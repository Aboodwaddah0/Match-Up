import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';
import { verifyAccessToken } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import type { Actor } from '../types/actor';

/**
 * Requires `Authorization: Bearer <access token>`.
 * The user is re-read on every request, so suspending an account takes effect immediately
 * (not only when the 15-minute token expires).
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHENTICATED', 'Missing access token');

  let userId: string;
  try {
    userId = await verifyAccessToken(header.slice(7));
  } catch {
    throw new AppError(401, 'INVALID_TOKEN', 'Access token is invalid or expired');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, platformRole: true, status: true, emailVerifiedAt: true },
  });
  if (!user || user.status !== 'ACTIVE') throw new AppError(401, 'INVALID_TOKEN', 'Access token is invalid or expired');

  req.auth = { userId: user.id, role: user.platformRole, emailVerified: user.emailVerifiedAt !== null };
  next();
}

/** Creating/joining matches and booking will require a verified e-mail. */
export function requireVerifiedEmail(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth?.emailVerified) throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your e-mail address first');
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.auth?.role !== 'ADMIN') throw new AppError(403, 'FORBIDDEN', 'Administrator access required');
  next();
}

/** The caller as the plain object services expect (set by `authenticate`, so call this only on authenticated routes). */
export function actorOf(req: Request): Actor {
  return { userId: req.auth!.userId, role: req.auth!.role };
}
