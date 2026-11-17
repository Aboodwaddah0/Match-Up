import dotenv from 'dotenv';
import { z } from 'zod';

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
  // E-mail over SMTP, e.g. smtps://user:password@smtp.example.com:465 . Empty = log in development, skip in production.
  SMTP_URL: z.string().trim().optional().transform((v) => (v ? v : undefined)),
  MAIL_FROM: z.string().trim().min(3).default('Find Your Match <no-reply@localhost>'),
  // Background sweepers (match start / close-unconfirmed). Safe to run on several instances.
  JOBS_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Set to 1 when running behind one reverse proxy so rate limiting sees the real client IP.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  console.error(`Invalid environment configuration:\n${problems.join('\n')}`);
  process.exit(1);
}

export const env = parsed.data;
