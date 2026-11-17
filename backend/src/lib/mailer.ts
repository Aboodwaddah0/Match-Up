import { env } from '../config/env';
import { logger } from './logger';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/** Test-only inbox: lets tests read verification / reset links. */
export const testOutbox: Email[] = [];

/**
 * Placeholder transport until a real provider (SMTP / SES / Resend) is chosen.
 *  - test: stored in memory
 *  - development: printed to the API log so you can copy the link
 *  - production: NOT sent and the body is NOT logged (it contains a secret token)
 */
export async function sendEmail(email: Email): Promise<void> {
  if (env.NODE_ENV === 'test') {
    testOutbox.push(email);
    return;
  }
  if (env.NODE_ENV === 'development') {
    logger.info(`\n--- EMAIL to ${email.to} ---\n${email.subject}\n\n${email.text}\n--- end ---`);
    return;
  }
  logger.warn({ to: email.to, subject: email.subject }, 'No mail transport configured: e-mail not sent');
}
