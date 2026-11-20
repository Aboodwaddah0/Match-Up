import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { decryptOutboxToken, encryptOutboxToken } from '../src/lib/mail-outbox';
import { DEV_MAIL_OUTBOX_KEY, decodeMailKey, isValidMailKey, MAIL_KEY_BYTES } from '../src/lib/mail-key';

const newKey = () => randomBytes(32).toString('base64url');

describe('key format', () => {
  it('accepts 32 bytes as base64url, as base64, and with one trailing "="', () => {
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => 251 - i)); // includes bytes that differ between base64 and base64url
    expect(isValidMailKey(bytes.toString('base64url'))).toBe(true);
    expect(isValidMailKey(bytes.toString('base64'))).toBe(true); // 44 characters with "="
    expect(decodeMailKey(bytes.toString('base64')).equals(bytes)).toBe(true);
    expect(decodeMailKey(bytes.toString('base64url')).length).toBe(MAIL_KEY_BYTES);
  });

  it.each([
    ['empty', ''],
    ['31 bytes', Buffer.alloc(31, 1).toString('base64url')],
    ['33 bytes', Buffer.alloc(33, 1).toString('base64url')],
    ['64 hex characters', randomBytes(32).toString('hex')],
    ['stray characters that Buffer would silently drop', `${newKey().slice(0, 40)}!!!`],
    ['whitespace inside', `${newKey().slice(0, 20)} ${newKey().slice(0, 22)}`],
    ['two padding characters', `${newKey().slice(0, 42)}==`],
  ])('rejects %s', (_name, value) => {
    expect(isValidMailKey(value)).toBe(false);
    expect(() => decodeMailKey(value)).toThrow();
  });

  it('the public development key is itself a valid key (so a fresh checkout works)', () => {
    expect(isValidMailKey(DEV_MAIL_OUTBOX_KEY)).toBe(true);
  });
});

describe('encryption uses the DEDICATED key and nothing else', () => {
  const originalJwt = env.JWT_ACCESS_SECRET;
  const originalKey = env.MAIL_OUTBOX_ENCRYPTION_KEY;
  afterEach(() => {
    env.JWT_ACCESS_SECRET = originalJwt;
    env.MAIL_OUTBOX_ENCRYPTION_KEY = originalKey;
  });

  it('round-trips with the configured key, bound to the row id', () => {
    const id = randomUUID();
    const blob = encryptOutboxToken('one-time-token', id);
    expect(blob).not.toContain('one-time-token');
    expect(decryptOutboxToken(blob, id)).toBe('one-time-token');
    expect(() => decryptOutboxToken(blob, randomUUID())).toThrow();
  });

  it('rotating the JWT signing secret does NOT affect queued mail', () => {
    const id = randomUUID();
    const blob = encryptOutboxToken('one-time-token', id);
    env.JWT_ACCESS_SECRET = 'a completely different jwt secret, 40+ characters long';
    expect(decryptOutboxToken(blob, id)).toBe('one-time-token'); // still decrypts
    const after = encryptOutboxToken('other', id);
    env.JWT_ACCESS_SECRET = originalJwt;
    expect(decryptOutboxToken(after, id)).toBe('other'); // and new messages are readable under the old secret too
  });

  it('rotating the mail key DOES make messages encrypted under the old key unreadable (documented consequence)', () => {
    const id = randomUUID();
    const blob = encryptOutboxToken('one-time-token', id);
    env.MAIL_OUTBOX_ENCRYPTION_KEY = newKey();
    expect(() => decryptOutboxToken(blob, id)).toThrow();
    const fresh = encryptOutboxToken('new-token', id);
    expect(decryptOutboxToken(fresh, id)).toBe('new-token'); // new messages work under the new key
    env.MAIL_OUTBOX_ENCRYPTION_KEY = originalKey;
    expect(() => decryptOutboxToken(fresh, id)).toThrow(); // and the old key cannot read them
  });

  it('does not fall back to the JWT secret: an invalid mail key fails loudly instead of using another secret', () => {
    env.MAIL_OUTBOX_ENCRYPTION_KEY = 'not-a-valid-key';
    expect(() => encryptOutboxToken('x', randomUUID())).toThrow(/MAIL_OUTBOX_ENCRYPTION_KEY/);
  });

  it('a tampered ciphertext is refused (authenticated encryption)', () => {
    const id = randomUUID();
    const raw = Buffer.from(encryptOutboxToken('one-time-token', id), 'base64url');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    expect(() => decryptOutboxToken(raw.toString('base64url'), id)).toThrow();
  });
});

describe('start-up configuration (a real process loads src/config/env.ts)', () => {
  const root = path.resolve(__dirname, '..');
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const envUrl = pathToFileURL(path.join(root, 'src', 'config', 'env.ts')).href;

  /** Runs the config loader in a clean process, in an empty directory so no .env file leaks in. */
  function load(vars: Record<string, string>) {
    const r = spawnSync(process.execPath, [tsx, '-e', `import('${envUrl}').then((m) => console.log('LOADED ' + m.env.MAIL_OUTBOX_ENCRYPTION_KEY))`], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', DATABASE_URL: 'postgresql://api:s3cr3t-pass@db.internal:5432/fym', JWT_ACCESS_SECRET: 'q7Zk2x9LmP4vR8sT1uWb6nYc3dEfGh5JkLpOiUyTrEwQaSdFgHjKlZxCvBnM', ...vars },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }
  const production = {
    NODE_ENV: 'production',
    APP_URL: 'https://api.example.com',
    SMTP_URL: 'smtps://u:p@smtp.example.com:465',
    // media storage is a required production setting too (not what these mail-key tests are about)
    CLOUDINARY_CLOUD_NAME: 'acme-media',
    CLOUDINARY_API_KEY: '123456789012345',
    CLOUDINARY_API_SECRET: 'Zq8Xv2LmN5rT9vC4dHsJaE6gKoI',
  };

  it('production refuses to start without the key', () => {
    const r = load(production);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/MAIL_OUTBOX_ENCRYPTION_KEY is not set/);
  });

  it.each([
    ['too short', Buffer.alloc(16, 9).toString('base64url')],
    ['hex', randomBytes(32).toString('hex')],
  ])('production refuses a key that is %s', (_name, key) => {
    const r = load({ ...production, MAIL_OUTBOX_ENCRYPTION_KEY: key });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/MAIL_OUTBOX_ENCRYPTION_KEY/);
  });

  it('production refuses the development key and a key equal to the JWT secret', () => {
    const dev = load({ ...production, MAIL_OUTBOX_ENCRYPTION_KEY: DEV_MAIL_OUTBOX_KEY });
    expect(dev.code).toBe(1);
    expect(dev.err).toMatch(/development placeholder/);
    const same = newKey();
    const reuse = load({ ...production, JWT_ACCESS_SECRET: same, MAIL_OUTBOX_ENCRYPTION_KEY: same });
    expect(reuse.code).toBe(1);
    expect(reuse.err).toMatch(/different value from JWT_ACCESS_SECRET/);
  });

  it('production starts with a proper key, and uses exactly that key', () => {
    const key = newKey();
    const r = load({ ...production, MAIL_OUTBOX_ENCRYPTION_KEY: key });
    expect(r.err).toBe('');
    expect(r.out).toContain(`LOADED ${key}`);
    expect(r.code).toBe(0);
  });

  it('an invalid key is refused in EVERY environment (a set value is never ignored)', () => {
    const r = load({ NODE_ENV: 'development', MAIL_OUTBOX_ENCRYPTION_KEY: 'short' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/MAIL_OUTBOX_ENCRYPTION_KEY/);
  });

  it('development without a key uses the fixed public development key, never the JWT secret', () => {
    const r = load({ NODE_ENV: 'development' });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`LOADED ${DEV_MAIL_OUTBOX_KEY}`);
    expect(r.out).not.toContain('q7Zk2x9LmP4v'); // the JWT secret used by this helper
  });
});
