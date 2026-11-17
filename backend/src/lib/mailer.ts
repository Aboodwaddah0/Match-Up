import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from './logger';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/** Test-only inbox: messages "sent" while NODE_ENV=test are collected here, so tests can read verification / reset links. */
export const testOutbox: Email[] = [];

/** A failed delivery attempt. `permanent` = retrying cannot help (the recipient or message is refused), otherwise it is transient. */
export class MailDeliveryError extends Error {
  constructor(
    message: string,
    /** Short, content-free code stored in the outbox (e.g. SMTP_550, ETIMEDOUT). Never contains an address or message text. */
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}

/** SMTP time limits (ms). Without them a mail server that accepts the connection and then goes silent would hang a send for minutes. */
export const SMTP_TIMEOUTS = { dnsTimeout: 10_000, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };

export function createSmtpTransport(url: string, timeouts: typeof SMTP_TIMEOUTS = SMTP_TIMEOUTS): Transporter {
  return nodemailer.createTransport({ url, ...timeouts });
}

/**
 * Delivery (called by the outbox worker, never by a request):
 *  - test: stored in memory
 *  - SMTP_URL set (any provider: Resend, SES, Mailgun, Brevo, Gmail ...): sent over SMTP, with time limits
 *  - development without SMTP_URL: printed to the API log so you can copy the link (development only)
 *  - production without SMTP_URL: nothing can be sent; the attempt fails (and is retried), the body is NOT logged
 * Failures are thrown as MailDeliveryError so the worker can retry or give up. Nothing here logs a message body or a token.
 */
let transport: Transporter | null = null;

function smtp(): Transporter | null {
  if (!env.SMTP_URL) return null;
  transport ??= createSmtpTransport(env.SMTP_URL);
  return transport;
}

/** Maps a nodemailer / SMTP error to transient or permanent. Only a refusal of the recipient or message is permanent. */
export function classifySmtpError(err: unknown): MailDeliveryError {
  const e = err as { code?: string; responseCode?: number };
  if (typeof e.responseCode === 'number' && e.responseCode >= 550 && e.responseCode <= 554) {
    return new MailDeliveryError('smtp refused the message', `SMTP_${e.responseCode}`, true);
  }
  if (e.code === 'EENVELOPE') return new MailDeliveryError('invalid envelope', 'EENVELOPE', true);
  const code = typeof e.responseCode === 'number' ? `SMTP_${e.responseCode}` : typeof e.code === 'string' ? e.code.slice(0, 30) : 'UNKNOWN';
  return new MailDeliveryError('smtp delivery failed', code, false);
}

/** Sends through a given transporter (exposed for tests). Throws MailDeliveryError. `messageId` stays the same across retries of one outbox row. */
export async function deliver(t: Transporter, email: Email, from: string, messageId?: string): Promise<void> {
  try {
    await t.sendMail({ from, to: email.to, subject: email.subject, text: email.text, ...(messageId ? { messageId } : {}) });
  } catch (err) {
    throw classifySmtpError(err);
  }
}

/** The Message-ID of an outbox row: stable across retries, so mail systems and clients can recognize a duplicate. */
export function messageIdFor(outboxId: string): string {
  const domain = /@([^>\s]+)>?\s*$/.exec(env.MAIL_FROM)?.[1] ?? 'localhost';
  return `<${outboxId}@${domain}>`;
}

export async function deliverEmail(email: Email, messageId?: string): Promise<void> {
  if (env.NODE_ENV === 'test') {
    testOutbox.push(email);
    return;
  }
  const t = smtp();
  if (t) {
    await deliver(t, email, env.MAIL_FROM, messageId);
    return;
  }
  if (env.NODE_ENV === 'development') {
    logger.info(`\n--- EMAIL (development only, not sent) to ${email.to} ---\n${email.subject}\n\n${email.text}\n--- end ---`);
    return;
  }
  throw new MailDeliveryError('no mail transport configured (set SMTP_URL)', 'NO_TRANSPORT', false);
}
