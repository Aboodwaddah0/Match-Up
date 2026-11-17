import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env';

const tooMany = { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } };

function limiter(windowMinutes: number, limit: number) {
  return rateLimit({
    windowMs: windowMinutes * 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: tooMany,
    skip: () => env.NODE_ENV === 'test',
  });
}

/** login, register, refresh: 20 attempts / 15 min / IP */
export const authLimiter = limiter(15, 20);
/** forgot-password, resend-verification: 5 / hour / IP (each one sends an e-mail) */
export const emailLimiter = limiter(60, 5);
