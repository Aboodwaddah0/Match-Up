import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { execSync } from 'node:child_process';
import { databaseName, toTestUrl } from './helpers/db-url';

/** Creates the `<db>_test` database if needed and applies all migrations (fast when up to date). */
export default async function setup(): Promise<void> {
  dotenv.config({ quiet: true });
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error('DATABASE_URL is required to run tests (start the db: docker compose up -d db)');

  const testUrl = toTestUrl(baseUrl);
  const testDb = databaseName(testUrl);

  const admin = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    const rows = await admin.$queryRaw<{ n: number }[]>`SELECT 1 AS n FROM pg_database WHERE datname = ${testDb}`;
    if (rows.length === 0) await admin.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  } finally {
    await admin.$disconnect();
  }

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });
}
