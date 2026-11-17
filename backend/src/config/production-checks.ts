import { isValidMailKey } from '../lib/mail-key';

/**
 * Settings that are fine on a developer machine but dangerous in production (audit OPS-01). The API refuses to start in
 * production while any of these is true, instead of silently running with a known secret or without e-mail.
 * Pure function (no process access) so it can be tested.
 */
export interface ProductionSettings {
  NODE_ENV: string;
  JWT_ACCESS_SECRET: string;
  DATABASE_URL: string;
  APP_URL: string;
  SMTP_URL?: string | undefined;
  MAIL_OUTBOX_ENCRYPTION_KEY?: string | undefined;
  VERIFY_EMAIL_URL?: string | undefined;
  RESET_PASSWORD_URL?: string | undefined;
}

/** Fragments of the placeholder secrets and passwords shipped in .env.example, docker-compose.yml, tests and CI. */
const KNOWN_PLACEHOLDERS = ['dev-only', 'change-me', 'changeme', 'test-secret', 'audit-secret', 'ci-only', 'test-only', 'fym_dev_password'];

const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);

/** Human-readable problems; empty means the settings are acceptable (always empty outside production). */
export function productionProblems(s: ProductionSettings): string[] {
  if (s.NODE_ENV !== 'production') return [];
  const problems: string[] = [];

  if (KNOWN_PLACEHOLDERS.some((p) => s.JWT_ACCESS_SECRET.toLowerCase().includes(p))) {
    problems.push('JWT_ACCESS_SECRET is a development placeholder. Generate a real one: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
  }
  if (s.DATABASE_URL.includes('fym_dev_password')) {
    problems.push('DATABASE_URL uses the development database password.');
  }
  if (!s.SMTP_URL) {
    problems.push('SMTP_URL is not set: verification and password-reset e-mails could not be sent, so nobody could verify an account or reset a password.');
  }
  const mailKey = s.MAIL_OUTBOX_ENCRYPTION_KEY;
  if (!mailKey) {
    problems.push('MAIL_OUTBOX_ENCRYPTION_KEY is not set: it encrypts the one-time tokens of queued e-mails. Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"');
  } else if (!isValidMailKey(mailKey)) {
    problems.push('MAIL_OUTBOX_ENCRYPTION_KEY must be exactly 32 random bytes encoded as base64 (43 characters).');
  } else {
    const decoded = Buffer.from(mailKey, 'base64').toString('latin1').toLowerCase();
    if (KNOWN_PLACEHOLDERS.some((x) => decoded.includes(x))) problems.push('MAIL_OUTBOX_ENCRYPTION_KEY is a development placeholder. Generate a real one.');
    if (mailKey === s.JWT_ACCESS_SECRET) problems.push('MAIL_OUTBOX_ENCRYPTION_KEY must be a different value from JWT_ACCESS_SECRET.');
  }
  const linksConfigured = Boolean(s.VERIFY_EMAIL_URL && s.RESET_PASSWORD_URL);
  if (!linksConfigured && isLocal(s.APP_URL)) {
    problems.push('E-mail links would point at localhost: set VERIFY_EMAIL_URL and RESET_PASSWORD_URL (deep links containing {token}) or a public APP_URL.');
  }
  return problems;
}
