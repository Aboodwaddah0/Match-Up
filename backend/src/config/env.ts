import dotenv from 'dotenv';
import { z } from 'zod';
import { isLinkTemplate } from '../lib/links';
import { DEV_MAIL_OUTBOX_KEY, isValidMailKey } from '../lib/mail-key';
import { productionProblems } from './production-checks';

dotenv.config({ quiet: true });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Auth
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Base URL used in e-mail links (the mobile deep link / web app later).
  APP_URL: z.string().url().default('http://localhost:3000'),
  // Where the links in verification / reset e-mails point. A template containing {token}: a mobile deep link such as
  // fym://verify-email?token={token} or a web page. Empty = APP_URL + /verify-email (or /reset-password) ?token={token}.
  VERIFY_EMAIL_URL: z.string().trim().optional().transform((v) => (v ? v : undefined)).refine((v) => v === undefined || isLinkTemplate(v), 'must be a URL containing {token}'),
  RESET_PASSWORD_URL: z.string().trim().optional().transform((v) => (v ? v : undefined)).refine((v) => v === undefined || isLinkTemplate(v), 'must be a URL containing {token}'),
  // E-mail over SMTP, e.g. smtps://user:password@smtp.example.com:465 . Empty = log in development, skip in production.
  SMTP_URL: z.string().trim().optional().transform((v) => (v ? v : undefined)),
  // Dedicated key that encrypts one-time tokens while their e-mail is queued (32 random bytes, base64). REQUIRED in production, never
  // derived from JWT_ACCESS_SECRET. Unset outside production = a fixed public development key. Generate:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  MAIL_OUTBOX_ENCRYPTION_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || isValidMailKey(v), 'must be 32 random bytes encoded as base64 (43 characters), e.g. from: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"'),
  // Error tracking (D20 / OBS-01). Empty or unset = Sentry stays completely off. SENTRY_ENVIRONMENT picks the environment name shown in Sentry;
  // unset = production when NODE_ENV=production, otherwise development. A staging deployment runs NODE_ENV=production with SENTRY_ENVIRONMENT=staging.
  SENTRY_DSN: z.string().trim().optional().transform((v) => (v ? v : undefined)),
  SENTRY_ENVIRONMENT: z.string().trim().optional().transform((v) => (v ? v : undefined)).pipe(z.enum(['development', 'staging', 'production']).optional()),
  // Push notifications through Expo (NOTIF-01). The access token is needed only when "Enhanced Push Security" is switched on in the Expo
  // account; the API cannot detect that, so EXPO_ENHANCED_SECURITY says so (production then refuses to start without the token).
  // The Expo project id is NOT a backend setting: the mobile app passes it to getExpoPushTokenAsync (see README).
  EXPO_ACCESS_TOKEN: z.string().trim().optional().transform((v) => (v ? v : undefined)),
  EXPO_ENHANCED_SECURITY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  EXPO_API_BASE_URL: z
    .string()
    .trim()
    .url()
    .default('https://exp.host')
    .transform((v) => v.replace(/\/+$/, '')),
  // Sends the pushes of notifications. Safe to run on several instances.
  PUSH_WORKER_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Media (photos and videos) are stored at Cloudinary; the API signs direct uploads and verifies / deletes files, it never receives the binary.
  // All three are REQUIRED in production (see production-checks.ts); unset elsewhere = the media endpoints answer 503 MEDIA_NOT_CONFIGURED.
  CLOUDINARY_CLOUD_NAME: z.string().trim().optional().transform((v) => (v ? v : undefined)),
  CLOUDINARY_API_KEY: z.string().trim().optional().transform((v) => (v ? v : undefined)),
  CLOUDINARY_API_SECRET: z.string().trim().optional().transform((v) => (v ? v : undefined)),
  // Only a different value in tests or behind a proxy. The API secret travels to this host, so production requires https.
  CLOUDINARY_API_BASE_URL: z
    .string()
    .trim()
    .url()
    .default('https://api.cloudinary.com')
    .transform((v) => v.replace(/\/+$/, '')),
  CLOUDINARY_DELIVERY_BASE_URL: z
    .string()
    .trim()
    .url()
    .default('https://res.cloudinary.com')
    .transform((v) => v.replace(/\/+$/, '')),
  // Folder prefix of every storage key ("<folder>/media/<id>"), so one Cloudinary account can serve several environments.
  CLOUDINARY_FOLDER: z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/, 'letters, digits, - and _ only').default('fym'),
  // Deletes files at the provider after a media row was removed or an upload was never confirmed. Safe to run on several instances.
  MEDIA_WORKER_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Daily reconciliation of the media folder at the provider: removes files that are not the verified file of a READY item (jobs/media-reconcile.ts).
  MEDIA_RECONCILE_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Hours between the START of two scan cycles of one resource type (a cycle that takes longer is followed by the next one at once).
  MEDIA_RECONCILE_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  // A stray is deleted only when the PROVIDER created it at least this long ago; must exceed the upload window (70 min) by a wide margin.
  MEDIA_RECONCILE_GRACE_HOURS: z.coerce.number().int().min(2).max(168).default(24),
  // Admin API listing pages one run may fetch (all resource types together, 500 assets per page). The provider allows 500 Admin API calls per hour.
  MEDIA_RECONCILE_MAX_PAGES: z.coerce.number().int().min(1).max(100).default(25),
  MAIL_FROM: z.string().trim().min(3).default('Find Your Match <no-reply@localhost>'),
  // Sends queued e-mails (verification, password reset). Safe to run on several instances. Turn it off only on instances that must not send.
  MAIL_WORKER_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Background sweepers (match start / close-unconfirmed). Safe to run on several instances.
  JOBS_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // How long a shutdown may take before remaining connections are cut. Keep it BELOW the orchestrator's kill timeout (Docker: 10 s).
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(8000),
  // Set to 1 when running behind one reverse proxy so rate limiting sees the real client IP.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  console.error(`Invalid environment configuration:\n${problems.join('\n')}`);
  process.exit(1);
}

const unsafe = productionProblems(parsed.data);
if (unsafe.length > 0) {
  console.error(`Refusing to start in production with an unsafe configuration:\n${unsafe.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

// The production guard above has already refused a missing key; outside production the fixed development key stands in (never the JWT secret).
export const env = { ...parsed.data, MAIL_OUTBOX_ENCRYPTION_KEY: parsed.data.MAIL_OUTBOX_ENCRYPTION_KEY ?? DEV_MAIL_OUTBOX_KEY };
