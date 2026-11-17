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

describe('production configuration guards (OPS-01)', () => {
  it('accepts a sound production configuration', () => {
    expect(productionProblems(good)).toEqual([]);
  });

  it('is silent outside production, so development and tests keep their placeholders', () => {
    expect(productionProblems({ NODE_ENV: 'development', JWT_ACCESS_SECRET: 'dev-only-secret-change-me-dev-only-secret-change-me', DATABASE_URL: 'postgresql://fym:fym_dev_password@localhost/fym', APP_URL: 'http://localhost:3000' })).toEqual([]);
    expect(productionProblems({ ...good, NODE_ENV: 'test', SMTP_URL: undefined })).toEqual([]);
  });

  it.each([
    'dev-only-secret-change-me-dev-only-secret-change-me', // .env.example / docker-compose.yml
    'ci-only-secret-ci-only-secret-ci-only-secret', // CI workflow
    'test-secret-test-secret-test-secret-123456', // test setup
    'please-CHANGE-ME-please-CHANGE-ME-please-CHANGE-ME',
  ])('refuses the placeholder JWT secret %s', (secret) => {
    const problems = productionProblems({ ...good, JWT_ACCESS_SECRET: secret });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/JWT_ACCESS_SECRET/);
  });

  it('refuses the development database password', () => {
    expect(productionProblems({ ...good, DATABASE_URL: 'postgresql://fym:fym_dev_password@db:5432/fym' })[0]).toMatch(/DATABASE_URL/);
  });

  it('requires SMTP_URL, because without it nobody can verify an account or reset a password', () => {
    const problems = productionProblems({ ...good, SMTP_URL: undefined });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/SMTP_URL/);
  });

  it('refuses e-mail links that would point at localhost, unless both deep-link templates are set', () => {
    expect(productionProblems({ ...good, APP_URL: 'http://localhost:3000' })[0]).toMatch(/localhost/);
    expect(productionProblems({ ...good, APP_URL: 'http://127.0.0.1:3000' })).toHaveLength(1);
    expect(
      productionProblems({ ...good, APP_URL: 'http://localhost:3000', VERIFY_EMAIL_URL: 'fym://verify-email?token={token}', RESET_PASSWORD_URL: 'fym://reset-password?token={token}' }),
    ).toEqual([]);
    // only one of the two templates is not enough
    expect(productionProblems({ ...good, APP_URL: 'http://localhost:3000', VERIFY_EMAIL_URL: 'fym://verify-email?token={token}' })).toHaveLength(1);
  });

  it('reports every problem at once', () => {
    const problems = productionProblems({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'dev-only-secret-change-me-dev-only-secret-change-me', DATABASE_URL: 'postgresql://fym:fym_dev_password@db/fym', APP_URL: 'http://localhost:3000' });
    expect(problems).toHaveLength(5); // the mail key is missing too
  });

  describe('the dedicated mail encryption key', () => {
    const noKey = { ...good, MAIL_OUTBOX_ENCRYPTION_KEY: undefined };

    it('is required in production', () => {
      const problems = productionProblems(noKey);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/MAIL_OUTBOX_ENCRYPTION_KEY is not set/);
      expect(productionProblems({ ...good, MAIL_OUTBOX_ENCRYPTION_KEY: '' })[0]).toMatch(/not set/);
    });

    it.each([
      ['too short (31 bytes)', Buffer.alloc(31, 7).toString('base64url')],
      ['too long (33 bytes)', Buffer.alloc(33, 7).toString('base64url')],
      ['hex instead of base64', Buffer.alloc(32, 7).toString('hex')],
      ['not base64 at all', 'this is not a key!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'],
    ])('refuses a key that is %s', (_name, key) => {
      const problems = productionProblems({ ...good, MAIL_OUTBOX_ENCRYPTION_KEY: key });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/32 random bytes/);
    });

    it('refuses the public development and test keys, and a key that equals the JWT secret', () => {
      expect(productionProblems({ ...good, MAIL_OUTBOX_ENCRYPTION_KEY: Buffer.from('dev-only-mail-key-change-me-0123').toString('base64url') })[0]).toMatch(/development placeholder/);
      expect(productionProblems({ ...good, MAIL_OUTBOX_ENCRYPTION_KEY: Buffer.from('test-only-mail-key-test-only-012').toString('base64url') })[0]).toMatch(/development placeholder/);
      const shared = 'q7Zk2x9LmP4vR8sT1uWb6nYc3dEfGh5JkLpOiUyTrEw'; // 43 characters: valid as a key
      const problems = productionProblems({ ...good, JWT_ACCESS_SECRET: shared + 'QaSdFgHjKlZxCvBnM', MAIL_OUTBOX_ENCRYPTION_KEY: shared });
      expect(problems).toEqual([]); // different values: fine
      expect(productionProblems({ ...good, JWT_ACCESS_SECRET: shared, MAIL_OUTBOX_ENCRYPTION_KEY: shared })[0]).toMatch(/different value from JWT_ACCESS_SECRET/);
    });

    it('is not required outside production', () => {
      expect(productionProblems({ ...noKey, NODE_ENV: 'development' })).toEqual([]);
      expect(productionProblems({ ...noKey, NODE_ENV: 'test' })).toEqual([]);
    });
  });
});
