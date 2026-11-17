import { Prisma, type TokenType, type User } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { randomToken, sha256 } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { accessTokenTtlSeconds, signAccessToken } from '../../lib/jwt';
import { sendEmail } from '../../lib/mailer';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../lib/password';
import { prisma } from '../../lib/prisma';
import { toPublicUser } from '../users/users.service';
import { resetPasswordMessage, verifyEmailMessage } from './auth.emails';

const HOUR = 3_600_000;
const VERIFY_TTL_MS = 24 * HOUR;
const RESET_TTL_MS = 1 * HOUR;
const REFRESH_TTL_MS = env.REFRESH_TOKEN_TTL_DAYS * 24 * HOUR;

type Tx = Prisma.TransactionClient;

export interface Session {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

// ───────────── sessions (access JWT + rotating opaque refresh token) ─────────────

async function createRefreshToken(tx: Tx, userId: string, familyId: string): Promise<string> {
  const raw = randomToken(48);
  await tx.refreshToken.create({
    data: { userId, familyId, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
  });
  return raw;
}

async function startSession(tx: Tx, userId: string, familyId: string = randomUUID()): Promise<Session> {
  return {
    accessToken: await signAccessToken(userId),
    refreshToken: await createRefreshToken(tx, userId, familyId),
    tokenType: 'Bearer',
    expiresIn: accessTokenTtlSeconds,
  };
}

function revokeUserSessions(tx: Tx, userId: string) {
  return tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

// ───────────── one-time e-mail tokens (verify e-mail / reset password) ─────────────

async function issueUserToken(userId: string, type: TokenType, ttlMs: number): Promise<string> {
  const raw = randomToken(32);
  await prisma.$transaction([
    prisma.userToken.deleteMany({ where: { userId, type, usedAt: null } }), // only the newest link works
    prisma.userToken.create({ data: { userId, type, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + ttlMs) } }),
  ]);
  return raw;
}

/** Atomically consumes a token (single use). Returns the user id, or throws INVALID_TOKEN. */
async function consumeUserToken(tx: Tx, raw: string, type: TokenType): Promise<string> {
  const tokenHash = sha256(raw);
  const row = await tx.userToken.findUnique({ where: { tokenHash } });
  if (!row || row.type !== type) throw new AppError(400, 'INVALID_TOKEN', 'This link is invalid or has expired');
  const claimed = await tx.userToken.updateMany({
    where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) throw new AppError(400, 'INVALID_TOKEN', 'This link is invalid or has expired');
  return row.userId;
}

async function sendVerificationEmail(user: Pick<User, 'id' | 'email' | 'locale'>): Promise<void> {
  const raw = await issueUserToken(user.id, 'EMAIL_VERIFY', VERIFY_TTL_MS);
  await sendEmail(verifyEmailMessage(user.email, user.locale, `${env.APP_URL}/verify-email?token=${raw}`));
}

// ───────────── use cases ─────────────

export async function register(input: { email: string; password: string; fullName: string; locale: 'ar' | 'en' }) {
  const passwordHash = await hashPassword(input.password);
  let user: User;
  try {
    user = await prisma.user.create({
      data: { email: input.email, passwordHash, fullName: input.fullName, locale: input.locale },
    });
  } catch (e) {
    // email column is citext + unique: case-insensitive duplicates land here, including races
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError(409, 'EMAIL_TAKEN', 'An account with this e-mail already exists');
    }
    throw e;
  }
  await sendVerificationEmail(user);
  return toPublicUser(user);
}

/** Consumes a single-use e-mail verification token and marks the address verified. */
export async function verifyEmail(rawToken: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const userId = await consumeUserToken(tx, rawToken, 'EMAIL_VERIFY');
    await tx.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
  });
}

/** Sends a new verification link (only the newest link works). 409 when the address is already verified. */
export async function resendVerification(userId: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.emailVerifiedAt) throw new AppError(409, 'ALREADY_VERIFIED', 'E-mail is already verified');
  await sendVerificationEmail(user);
}

/**
 * Checks e-mail + password and starts a session.
 * Security: an unknown e-mail still burns a password-hash check, so timing does not reveal whether an account exists,
 * and the account state (suspended) is revealed only after the correct password.
 */
export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    await burnPasswordCheck(password);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'E-mail or password is incorrect');
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'E-mail or password is incorrect');
  }
  // Only reveal the account state to someone who proved they own it.
  if (user.status !== 'ACTIVE') throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is not active');

  const session = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return startSession(tx, user.id);
  });
  return { user: toPublicUser(user), ...session };
}

/**
 * Rotation: every refresh token works once. Presenting an already-used token means it was
 * stolen (or replayed), so the whole family is revoked and the real user must log in again.
 */
export async function refresh(rawToken: string): Promise<Session> {
  const tokenHash = sha256(rawToken);
  const invalid = () => new AppError(401, 'INVALID_REFRESH_TOKEN', 'Session expired, please log in again');

  const row = await prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: { select: { status: true } } } });
  if (!row) throw invalid();

  if (row.revokedAt) {
    await prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    throw invalid();
  }
  if (row.expiresAt <= new Date() || row.user.status !== 'ACTIVE') throw invalid();

  return prisma.$transaction(async (tx) => {
    // Guarded claim: if two requests race with the same token only one wins.
    const claimed = await tx.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (claimed.count !== 1) {
      await tx.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw invalid();
    }
    return startSession(tx, row.userId, row.familyId);
  });
}

/** Ends this device's session. Idempotent: unknown tokens are ignored. */
export async function logout(rawToken: string): Promise<void> {
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (!row) return;
  await prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Revokes every refresh token of the user (all devices). */
export async function logoutAll(userId: string): Promise<void> {
  await prisma.$transaction((tx) => revokeUserSessions(tx, userId));
}

/** Always succeeds from the caller's point of view, so it cannot be used to discover accounts. */
export async function forgotPassword(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== 'ACTIVE') return;
  const raw = await issueUserToken(user.id, 'PASSWORD_RESET', RESET_TTL_MS);
  await sendEmail(resetPasswordMessage(user.email, user.locale, `${env.APP_URL}/reset-password?token=${raw}`));
}

/**
 * Sets a new password from a reset link. One transaction: consume the single-use token, change the password, mark the
 * e-mail verified (the user proved the inbox is theirs), and revoke all sessions so every device must log in again.
 */
export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    const userId = await consumeUserToken(tx, rawToken, 'PASSWORD_RESET');
    // Following a link sent to the inbox also proves the address is theirs.
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    await tx.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
    await revokeUserSessions(tx, userId); // every device must log in again
  });
}

/** Changes the password after checking the current one; revokes all other sessions and returns a fresh session for this device. */
export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<Session> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new AppError(400, 'WRONG_PASSWORD', 'Current password is incorrect');
  }
  const passwordHash = await hashPassword(newPassword);
  return prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    await revokeUserSessions(tx, userId);
    return startSession(tx, userId); // this device continues with a fresh session
  });
}
