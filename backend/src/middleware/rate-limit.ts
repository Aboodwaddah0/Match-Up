import type { Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { env } from '../config/env';

/*
 * Rate limits for the authentication endpoints. Design rules:
 *  - Each endpoint has its OWN limiter. One shared bucket would let a few requests to cheap endpoints (token refresh,
 *    which every mobile client calls periodically) lock users out of login.
 *  - Password-guessing is limited PER ACCOUNT (e-mail), not only per IP: many users share one IP (mobile carrier NAT,
 *    offices, or a reverse proxy), so IP limits must be generous, while a single account must not be guessable.
 *  - Token endpoints (refresh, e-mail verification, reset) carry 256-bit random tokens, so guessing is infeasible and
 *    their limits only protect the server from floods.
 *
 * Limits are counted in memory PER API INSTANCE. With more than one instance, use a shared store (Redis) or the
 * effective limit is multiplied by the number of instances. Behind a reverse proxy set TRUST_PROXY=1, otherwise every
 * client appears to come from the proxy's IP and shares one bucket.
 */

const tooMany = { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } };

/** Limits are off under NODE_ENV=test so the test suite never trips them, except in the dedicated rate-limit test. */
export const rateLimitTesting = { enabled: false };

interface LimiterOptions {
  windowMinutes: number;
  limit: number;
  /** Identifies WHAT is limited. Return undefined to fall back to the client IP. Default: the client IP. */
  key?: (req: Request) => string | undefined;
  /** Count only failed responses (status >= 400), e.g. so successful logins never use up the allowance. */
  failuresOnly?: boolean;
}

function limiter({ windowMinutes, limit, key, failuresOnly = false }: LimiterOptions) {
  return rateLimit({
    windowMs: windowMinutes * 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: tooMany,
    skipSuccessfulRequests: failuresOnly,
    // IPv6 addresses are collapsed to their /56 so one client cannot rotate through addresses to dodge the limit.
    keyGenerator: (req) => key?.(req) ?? ipKeyGenerator(req.ip ?? ''),
    skip: () => env.NODE_ENV === 'test' && !rateLimitTesting.enabled,
  });
}

/** The (already validated, lower-cased) e-mail of the request body. Put the limiter AFTER `validate()`. */
const emailOf = (req: Request): string | undefined => {
  const email = (req.valid?.body as { email?: string } | undefined)?.email;
  return email ? `email:${email}` : undefined;
};
const userOf = (req: Request): string | undefined => (req.auth ? `user:${req.auth.userId}` : undefined);

// ── sign-up and sign-in ──
/** 30 sign-ups per hour per IP. */
export const registerLimiter = limiter({ windowMinutes: 60, limit: 30 });
/** Broad flood protection: 100 login attempts per 15 minutes per IP (generous because IPs are shared). */
export const loginIpLimiter = limiter({ windowMinutes: 15, limit: 100 });
/** Password guessing: 10 FAILED attempts per 15 minutes per account, from any IP. Successful logins are not counted. */
export const loginAccountLimiter = limiter({ windowMinutes: 15, limit: 10, key: emailOf, failuresOnly: true });

// ── tokens ──
/** Refresh is called regularly by every client: 120 per 15 minutes per IP. */
export const refreshLimiter = limiter({ windowMinutes: 15, limit: 120 });
/** E-mail verification and password reset links: 30 per 15 minutes per IP. */
export const tokenLimiter = limiter({ windowMinutes: 15, limit: 30 });

// ── e-mail sending (each accepted request sends a message) ──
/** forgot-password: 20 per hour per IP, plus 5 per hour per target e-mail so nobody can flood one inbox. */
export const forgotIpLimiter = limiter({ windowMinutes: 60, limit: 20 });
export const forgotAccountLimiter = limiter({ windowMinutes: 60, limit: 5, key: emailOf });
/** resend-verification: 5 per hour per signed-in user. */
export const resendLimiter = limiter({ windowMinutes: 60, limit: 5, key: userOf });

// ── authenticated ──
/** change-password: 10 wrong-password attempts per 15 minutes per user (a stolen access token must not allow guessing). */
export const changePasswordLimiter = limiter({ windowMinutes: 15, limit: 10, key: userOf, failuresOnly: true });
