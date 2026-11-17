import { hash, verify } from '@node-rs/argon2';

// argon2id (the library default) with its default cost parameters.
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

// Verified against when the e-mail is unknown, so "no such user" and "wrong password"
// take the same time and cannot be told apart by timing.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hash('not-a-real-password');
  await verify(await dummyHash, password).catch(() => false);
}
