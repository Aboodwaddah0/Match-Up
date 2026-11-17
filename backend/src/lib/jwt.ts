import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env';

const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const ISSUER = 'find-your-match-api';
const AUDIENCE = 'find-your-match-app';

export const accessTokenTtlSeconds = env.ACCESS_TOKEN_TTL_MINUTES * 60;

/** Short-lived access token. Carries only the user id; role/status are re-read from the DB per request. */
export function signAccessToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${accessTokenTtlSeconds}s`)
    .sign(secret);
}

/** Throws if the signature, issuer, audience or expiry is wrong. Returns the user id and the expiry (seconds since the epoch). */
export async function verifyAccessTokenClaims(token: string): Promise<{ userId: string; expiresAt: number }> {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (!payload.sub) throw new Error('token has no subject');
  if (typeof payload.exp !== 'number') throw new Error('token has no expiry');
  return { userId: payload.sub, expiresAt: payload.exp };
}

/** Throws if the signature, issuer, audience or expiry is wrong. Returns the user id. */
export async function verifyAccessToken(token: string): Promise<string> {
  return (await verifyAccessTokenClaims(token)).userId;
}
