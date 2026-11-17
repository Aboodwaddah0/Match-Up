import { createApp } from './app';
import { env } from './config/env';
import { scheduleLifecycleJobs } from './jobs/match-lifecycle';
import { scheduleMailWorker } from './jobs/mail-worker';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { attachRealtime, closeRealtime } from './lib/realtime';
import { gracefulShutdown } from './lib/shutdown';

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

const stopLifecycle = env.JOBS_ENABLED && env.NODE_ENV !== 'test' ? scheduleLifecycleJobs() : async () => {};
const stopMail = env.MAIL_WORKER_ENABLED && env.NODE_ENV !== 'test' ? scheduleMailWorker() : async () => {};
// A send in progress is awaited; if it outlives the shutdown timeout its claim lease expires and the message is retried (see mail-worker.ts).
const stopJobs = async () => {
  await Promise.all([stopLifecycle(), stopMail()]);
};

let shuttingDown = false;

/** Runs the orderly shutdown once, then exits with 0 (clean) or 1 (forced, or the process was already failing). */
async function shutdown(reason: string, failing = false): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${reason}: shutting down`);
  const result = await gracefulShutdown({
    server,
    closeRealtime,
    stopJobs,
    disconnectDb: () => prisma.$disconnect(),
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    log: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
  });
  process.exit(failing ? 1 : result);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// A bug that escapes every handler leaves the process in an unknown state: log it with the stack, finish what is in flight,
// and exit non-zero so the orchestrator restarts a clean instance (instead of Node's silent default or a half-working server).
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  void shutdown('unhandledRejection', true);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException', true);
});
