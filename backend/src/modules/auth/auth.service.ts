import { Prisma, type TokenType, type User } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { randomToken, sha256 } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { accessTokenTtlSeconds, signAccessToken } from '../../lib/jwt';
import { logger } from '../../lib/logger';
import { enqueueMail } from '../../lib/mail-outbox';
import { kickMailWorker } from '../../jobs/mail-worker';
import { disconnectUser } from '../../lib/realtime';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../lib/password';
import { prisma } from '../../lib/prisma';
import { toPublicUser } from '../users/users.service';

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

/** Creates the one-time token inside the caller's transaction (only the newest link works: unused older ones are deleted). */
async function issueUserToken(tx: Tx, userId: string, type: TokenType, ttlMs: number): Promise<{ raw: string; expiresAt: Date }> {
  const raw = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlMs);
  await tx.userToken.deleteMany({ where: { userId, type, usedAt: null } });
  await tx.userToken.create({ data: { userId, type, tokenHash: sha256(raw), expiresAt } });
  return { raw, expiresAt };
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

/**
 * Issues the token and queues the e-mail that carries it, in the caller's transaction: either both exist or neither does,
 * so a crash can never leave a token nobody was told about, or a queued mail for a token that was rolled back.
 * The caller must call `kickMailWorker()` AFTER the transaction commits.
 */
async function queueTokenMail(tx: Tx, user: Pick<User, 'id' | 'email' | 'locale'>, type: TokenType, ttlMs: number): Promise<void> {
  const { raw, expiresAt } = await issueUserToken(tx, user.id, type, ttlMs);
  await enqueueMail(tx, { userId: user.id, email: user.email, locale: user.locale, kind: type, rawToken: raw, expiresAt });
}

// ───────────── use cases ─────────────

export async function register(input: { email: string; password: string; fullName: string; locale: 'ar' | 'en' }) {
  const passwordHash = await hashPassword(input.password);
  let user: User;
  try {
    // The account, its verification token and the queued e-mail are created together: all of them or none.
    user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email: input.email, passwordHash, fullName: input.fullName, locale: input.locale },
      });
      await queueTokenMail(tx, created, 'EMAIL_VERIFY', VERIFY_TTL_MS);
      return created;
    });
  } catch (e) {
    // email column is citext + unique: case-insensitive duplicates land here, including races
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError(409, 'EMAIL_TAKEN', 'An account with this e-mail already exists');
    }
    throw e;
  }
  kickMailWorker();
  return toPublicUser(user);
}

/** Consumes a single-use e-mail verification token and marks the address verified. */
export async function verifyEmail(rawToken: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const userId = await consumeUserToken(tx, rawToken, 'EMAIL_VERIFY');
    // PRIV-01: like reset-password, a link never acts on an account that is not ACTIVE (the whole transaction, the token use included, rolls back).
    if ((await tx.user.count({ where: { id: userId, status: 'ACTIVE' } })) === 0) throw new AppError(400, 'INVALID_TOKEN', 'This link is invalid or has expired');
    await tx.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
  });
}

/** Queues a new verification link (only the newest link works). 409 when the address is already verified. */
export async function resendVerification(userId: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.emailVerifiedAt) throw new AppError(409, 'ALREADY_VERIFIED', 'E-mail is already verified');
  await prisma.$transaction((tx) => queueTokenMail(tx, user, 'EMAIL_VERIFY', VERIFY_TTL_MS));
  kickMailWorker();
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
  disconnectUser(userId); // live chat sockets must not outlive the sessions (clients reconnect only after logging in again)
}

/** Every call takes at least this long, so an existing account (a little database work) cannot be told from an unknown one by timing. */
const FORGOT_MIN_MS = 250;

/**
 * Always succeeds from the caller's point of view, so it cannot be used to discover accounts:
 *  - same answer, and nothing is sent inline (the e-mail is queued and a worker sends it), so there is no SMTP time to measure;
 *  - the small difference left (the token and outbox writes of a real account) is hidden by a fixed minimum duration;
 *  - a failure while queueing is logged and NOT reported, because an error that only happens for real accounts would
 *    reveal them. The user can simply ask again.
 */
export async function forgotPassword(email: string): Promise<void> {
  const started = Date.now();
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.status === 'ACTIVE') {
      await prisma.$transaction((tx) => queueTokenMail(tx, user, 'PASSWORD_RESET', RESET_TTL_MS));
      kickMailWorker();
    }
  } catch (err) {
    // No address and no error message in the log (they could name the account); the code is enough to investigate.
    logger.error({ code: (err as { code?: string }).code, name: (err as Error).name }, 'forgot-password: could not queue the reset e-mail');
  }
  const wait = FORGOT_MIN_MS - (Date.now() - started);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * Sets a new password from a reset link. One transaction: consume the single-use token, change the password, mark the
 * e-mail verified (the user proved the inbox is theirs), and revoke all sessions so every device must log in again.
 */
export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  const userId = await prisma.$transaction(async (tx) => {
    const id = await consumeUserToken(tx, rawToken, 'PASSWORD_RESET');
    // PRIV-01: the tokens of a deleted account are erased, but a reset must also never act on any account that is not ACTIVE.
    if ((await tx.user.count({ where: { id, status: 'ACTIVE' } })) === 0) throw new AppError(400, 'INVALID_TOKEN', 'This link is invalid or has expired');
    // Following a link sent to the inbox also proves the address is theirs.
    await tx.user.update({ where: { id }, data: { passwordHash } });
    await tx.user.updateMany({ where: { id, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
    await revokeUserSessions(tx, id); // every device must log in again
    return id;
  });
  disconnectUser(userId);
}

/** Changes the password after checking the current one; revokes all other sessions and returns a fresh session for this device. */
export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<Session> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new AppError(400, 'WRONG_PASSWORD', 'Current password is incorrect');
  }
  const passwordHash = await hashPassword(newPassword);
  const session = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    await revokeUserSessions(tx, userId);
    return startSession(tx, userId); // this device continues with a fresh session
  });
  disconnectUser(userId); // sockets opened with the old session end; this device reconnects with its new access token
  return session;
}
