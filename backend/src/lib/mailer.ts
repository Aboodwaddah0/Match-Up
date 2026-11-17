import nodemailer, { type Transporter } from 'nodemailer';
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
 * Delivery:
 *  - test: stored in memory
 *  - SMTP_URL set (any provider: Resend, SES, Mailgun, Brevo, Gmail ...): sent over SMTP
 *  - development without SMTP_URL: printed to the API log so you can copy the link
 *  - production without SMTP_URL: NOT sent and the body is NOT logged (it contains a secret token)
 * A mail failure never breaks the request that triggered it (registration, password reset): it is logged
 * without the body and the user can ask for a new link. The e-mail text is never logged when SMTP is on.
 */
let transport: Transporter | null = null;

function smtp(): Transporter | null {
  if (!env.SMTP_URL) return null;
  transport ??= nodemailer.createTransport(env.SMTP_URL);
  return transport;
}

/** Exposed for tests: send through a given transporter, swallowing and logging failures. */
export async function deliver(t: Transporter, email: Email, from: string): Promise<boolean> {
  try {
    await t.sendMail({ from, to: email.to, subject: email.subject, text: email.text });
    return true;
  } catch (err) {
    logger.error({ err, to: email.to, subject: email.subject }, 'e-mail delivery failed');
    return false;
  }
}

export async function sendEmail(email: Email): Promise<void> {
  if (env.NODE_ENV === 'test') {
    testOutbox.push(email);
    return;
  }
  const t = smtp();
  if (t) {
    await deliver(t, email, env.MAIL_FROM);
    return;
  }
  if (env.NODE_ENV === 'development') {
    logger.info(`\n--- EMAIL to ${email.to} ---\n${email.subject}\n\n${email.text}\n--- end ---`);
    return;
  }
  logger.warn({ to: email.to, subject: email.subject }, 'No mail transport configured (set SMTP_URL): e-mail not sent');
}
