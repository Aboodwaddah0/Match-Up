import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** URL-safe random secret (256 bits by default). Only the sha256 of it is ever stored. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Encrypts a short secret with AES-256-GCM. `key` must be 32 bytes (a dedicated key, see lib/mail-key.ts). `aad` (associated data, e.g. the id of the row that stores the value) is
 * authenticated but not stored: the ciphertext only decrypts for the same `aad`, so it cannot be copied to another row.
 * Output: base64url(iv | auth tag | ciphertext).
 */
export function encryptSecret(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** Reverses `encryptSecret`. Throws when the key, the associated data or the value is wrong (authentication fails). */
export function decryptSecret(blob: string, key: Buffer, aad: string): string {
  const raw = Buffer.from(blob, 'base64url');
  if (raw.length < 12 + 16) throw new Error('ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
