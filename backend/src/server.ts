import { createApp } from './app';
import { env } from './config/env';
import { scheduleLifecycleJobs } from './jobs/match-lifecycle';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { attachRealtime } from './modules/chat/realtime';

const app = createApp();
const server = app.listen(env.PORT, () => {
  logger.info(`API listening on :${env.PORT} (${env.NODE_ENV})`);
});

attachRealtime(server);

const stopJobs = env.JOBS_ENABLED && env.NODE_ENV !== 'test' ? scheduleLifecycleJobs() : () => {};

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, shutting down`);
  stopJobs();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  // Force exit if connections do not drain.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
