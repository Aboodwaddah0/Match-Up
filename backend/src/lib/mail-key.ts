/*
 * The key that encrypts one-time tokens while their e-mail waits in the outbox (MAIL-01).
 *
 * It is a DEDICATED secret (MAIL_OUTBOX_ENCRYPTION_KEY): 32 random bytes encoded as base64 / base64url (43 characters, one
 * trailing "=" allowed). It is used for nothing else and is never derived from JWT_ACCESS_SECRET, so rotating the JWT signing
 * secret has no effect on queued mail. Rotating THIS key does: see README, "E-mail outbox".
 *
 * Generate one:  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
 */

export const MAIL_KEY_BYTES = 32;

/** Shape check first, because Buffer.from(..., 'base64') silently ignores characters that are not base64. */
const SHAPE = /^[A-Za-z0-9+/_-]{43}=?$/;

export function isValidMailKey(value: string): boolean {
  return SHAPE.test(value) && Buffer.from(value, 'base64').length === MAIL_KEY_BYTES;
}

/** The 32 key bytes. Throws when the value is not a valid key (env validation makes that impossible at runtime). */
export function decodeMailKey(value: string): Buffer {
  if (!isValidMailKey(value)) throw new Error('MAIL_OUTBOX_ENCRYPTION_KEY must be 32 random bytes encoded as base64');
  return Buffer.from(value, 'base64');
}

/**
 * Fixed key used ONLY when NODE_ENV is not production and the variable is unset (local development, tests), so the project runs
 * without setup. It is public (it is in this repository), so production refuses it: see productionProblems.
 */
export const DEV_MAIL_OUTBOX_KEY = Buffer.from('dev-only-mail-key-change-me-0123').toString('base64url');
