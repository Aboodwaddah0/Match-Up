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

if (env.NODE_ENV === 'production' && env.TRUST_PROXY === 0) {
  // Rate limits are keyed by client IP. Behind a reverse proxy / load balancer with TRUST_PROXY=0, every client looks like
  // the proxy's IP and they all share one bucket. If the API is exposed directly (no proxy), 0 is correct.
  logger.warn('TRUST_PROXY is 0 in production: set TRUST_PROXY=1 when running behind a reverse proxy, or rate limits will be shared by all clients');
}

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
