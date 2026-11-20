import { logger } from './lib/logger';
import { initSentry } from './lib/sentry';

// Imported first by server.ts. Without SENTRY_DSN this does nothing at all.
logger.info(initSentry() ? 'Sentry error tracking is on' : 'Sentry error tracking is off (SENTRY_DSN is not set)');
