import { describe, expect, it } from 'vitest';
import { productionProblems, type ProductionSettings } from '../src/config/production-checks';

const good: ProductionSettings = {
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: 'q7Zk2x9LmP4vR8sT1uWb6nYc3dEfGh5JkLpOiUyTrEwQaSdFgHjKlZxCvBnM',
  DATABASE_URL: 'postgresql://api:s3cr3t-pass@db.internal:5432/fym?sslmode=require',
  APP_URL: 'https://api.example.com',
  SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
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
    expect(problems).toHaveLength(4);
  });
});
