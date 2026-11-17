import { createHash, randomBytes } from 'node:crypto';

/** URL-safe random secret (256 bits by default). Only the sha256 of it is ever stored. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
