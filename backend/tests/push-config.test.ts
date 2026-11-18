import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { productionProblems, type ProductionSettings } from '../src/config/production-checks';

const good: ProductionSettings = {
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: 'q7Zk2x9LmP4vR8sT1uWb6nYc3dEfGh5JkLpOiUyTrEwQaSdFgHjKlZxCvBnM',
  DATABASE_URL: 'postgresql://api:s3cr3t-pass@db.internal:5432/fym?sslmode=require',
  APP_URL: 'https://api.example.com',
  SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
  MAIL_OUTBOX_ENCRYPTION_KEY: 'u8Qf3kZ0w1X7pYb2LmN5rT9vC4dHsJaE6gKoIqWxPzM',
};

describe('push configuration guards (production)', () => {
  it('push needs no setting at all when Enhanced Push Security is off', () => {
    expect(productionProblems({ ...good })).toEqual([]);
    expect(productionProblems({ ...good, EXPO_ENHANCED_SECURITY: false, EXPO_ACCESS_TOKEN: undefined })).toEqual([]);
  });

  it('Enhanced Push Security without an access token is refused: Expo would reject every push', () => {
    const problems = productionProblems({ ...good, EXPO_ENHANCED_SECURITY: true });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/EXPO_ENHANCED_SECURITY is true but EXPO_ACCESS_TOKEN is not set/);
    expect(productionProblems({ ...good, EXPO_ENHANCED_SECURITY: true, EXPO_ACCESS_TOKEN: '' })).toHaveLength(1);
    expect(productionProblems({ ...good, EXPO_ENHANCED_SECURITY: true, EXPO_ACCESS_TOKEN: 'a-real-token' })).toEqual([]);
  });

  it('the Expo API address must be https in production, and the problem never prints the token', () => {
    const problems = productionProblems({ ...good, EXPO_API_BASE_URL: 'http://exp.host', EXPO_ACCESS_TOKEN: 'SECRET-TOKEN-XYZ' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/EXPO_API_BASE_URL must be an https URL/);
    expect(problems.join(' ')).not.toContain('SECRET-TOKEN-XYZ');
    expect(productionProblems({ ...good, EXPO_API_BASE_URL: 'https://exp.host' })).toEqual([]);
  });

  it('is silent outside production', () => {
    expect(productionProblems({ ...good, NODE_ENV: 'development', EXPO_ENHANCED_SECURITY: true, EXPO_API_BASE_URL: 'http://localhost:9' })).toEqual([]);
  });
});

describe('push configuration at start-up (a real process loads src/config/env.ts)', () => {
  const root = path.resolve(__dirname, '..');
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const envUrl = pathToFileURL(path.join(root, 'src', 'config', 'env.ts')).href;
  const production = {
    NODE_ENV: 'production',
    APP_URL: 'https://api.example.com',
    SMTP_URL: 'smtps://u:p@smtp.example.com:465',
    MAIL_OUTBOX_ENCRYPTION_KEY: 'u8Qf3kZ0w1X7pYb2LmN5rT9vC4dHsJaE6gKoIqWxPzM',
  };

  function load(vars: Record<string, string>) {
    const r = spawnSync(
      process.execPath,
      [tsx, '-e', `import('${envUrl}').then((m) => console.log('LOADED ' + JSON.stringify({ s: m.env.EXPO_ENHANCED_SECURITY, b: m.env.EXPO_API_BASE_URL, w: m.env.PUSH_WORKER_ENABLED, t: Boolean(m.env.EXPO_ACCESS_TOKEN) })))`],
      {
        cwd: tmpdir(),
        env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', DATABASE_URL: 'postgresql://api:s3cr3t-pass@db.internal:5432/fym', JWT_ACCESS_SECRET: 'q7Zk2x9LmP4vR8sT1uWb6nYc3dEfGh5JkLpOiUyTrEwQaSdFgHjKlZxCvBnM', ...vars },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  it('production refuses to start with Enhanced Push Security on and no access token', () => {
    const r = load({ ...production, EXPO_ENHANCED_SECURITY: 'true' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/EXPO_ENHANCED_SECURITY is true but EXPO_ACCESS_TOKEN is not set/);
  });

  it('production refuses a non-https Expo address, and the access token is not echoed', () => {
    const r = load({ ...production, EXPO_API_BASE_URL: 'http://exp.host', EXPO_ACCESS_TOKEN: 'SECRET-TOKEN-XYZ' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/EXPO_API_BASE_URL must be an https URL/);
    expect(r.err + r.out).not.toContain('SECRET-TOKEN-XYZ');
  });

  it('production starts with the token and the flag, with defaults for everything else', () => {
    const r = load({ ...production, EXPO_ENHANCED_SECURITY: 'true', EXPO_ACCESS_TOKEN: 'a-real-token' });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('{"s":true,"b":"https://exp.host","w":true,"t":true}');
  });

  it('defaults: Enhanced Push Security off, the Expo API address, the worker on; a trailing slash is removed; junk is refused', () => {
    expect(load({ NODE_ENV: 'development' }).out).toContain('{"s":false,"b":"https://exp.host","w":true,"t":false}');
    expect(load({ NODE_ENV: 'development', EXPO_API_BASE_URL: 'http://localhost:8099//' }).out).toContain('"b":"http://localhost:8099"');
    expect(load({ NODE_ENV: 'development', PUSH_WORKER_ENABLED: 'false' }).out).toContain('"w":false');
    const bad = load({ NODE_ENV: 'development', EXPO_API_BASE_URL: 'not a url' });
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/EXPO_API_BASE_URL/);
    const badFlag = load({ NODE_ENV: 'development', EXPO_ENHANCED_SECURITY: 'maybe' });
    expect(badFlag.code).toBe(1);
  });

  it('there is NO backend setting for the Expo project id: it belongs to the mobile app', () => {
    const r = load({ NODE_ENV: 'development', EXPO_PROJECT_ID: 'not-a-uuid' });
    expect(r.code).toBe(0); // an unknown variable is simply ignored: the backend has no use for it
  });
});
