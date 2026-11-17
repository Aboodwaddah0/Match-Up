import { randomUUID } from 'node:crypto';
import type { MailKind } from '@prisma/client';
import { logger } from '../lib/logger';
import { decryptOutboxToken } from '../lib/mail-outbox';
import { classifySmtpError, deliverEmail, MailDeliveryError, messageIdFor, type Email } from '../lib/mailer';
import { prisma } from '../lib/prisma';
import { renderMail } from '../modules/auth/auth.emails';

/*
 * E-mail outbox worker (MAIL-01). Consumes the rows written by `enqueueMail`.
 *
 * Guarantees and limits:
 *  - AT-LEAST-ONCE delivery. SMTP cannot give exactly-once: if the mail server accepts a message and this process dies (or
 *    the send times out locally although the server went on to accept it) before the result is recorded, the row is tried again
 *    and the recipient may receive the same message twice. Every attempt for one row uses the same Message-ID (derived from the
 *    row id), which lets mail systems and clients recognize a duplicate, but that is not guaranteed.
 *  - No message is lost by a crash: a claim is a LEASE. A row left in SENDING by a dead worker is claimed again once the lease
 *    has expired. The attempt is counted when claiming, so a message that keeps killing the worker still ends as FAILED.
 *  - No two workers send the same row at the same time: claiming uses FOR UPDATE SKIP LOCKED, and recording a result is
 *    conditional on the claim id, so a worker whose lease expired cannot overwrite the result of the one that took over.
 *  - Rows are claimed ONE AT A TIME, so a lease only has to cover a single send.
 *  - Transient errors are retried with backoff; refusals of the recipient (SMTP 550-554, invalid envelope) and exhausted attempts
 *    end as FAILED. A message still queued after its token expired is CANCELLED (the link would not work).
 *  - Nothing here logs an address, a token or a message body: logs carry the outbox id, the kind, the attempt and an error code.
 */

export const MAX_ATTEMPTS = 6;
export const LEASE_SECONDS = 120;
/** Hard limit for one send, below the lease. nodemailer has its own socket time limits; this is the overall backstop. */
export const SEND_DEADLINE_MS = 45_000;
/** Delay before attempt n+1 after attempt n failed (the last value repeats). Jittered by +-20%. */
export const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
const MAX_PER_RUN = 50;
const POLL_MS = 5_000;
const KEEP_SENT_DAYS = 7;
const KEEP_FINISHED_DAYS = 30;

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1]!;
  return Math.round(base * (0.8 + random() * 0.4));
}

export type SendFn = (email: Email, messageId: string) => Promise<void>;

export interface MailRunOptions {
  /** How a message is delivered. Default: the configured transport. Tests inject their own. */
  send?: SendFn;
  maxMessages?: number;
  maxAttempts?: number;
  /** Overall limit for one send (default SEND_DEADLINE_MS). */
  sendDeadlineMs?: number;
}

export interface MailRunResult {
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
  /** Results we could not record because another worker had taken the row over (its lease had expired). */
  lostClaim: number;
}

interface Claimed {
  id: string;
  kind: MailKind;
  to_email: string;
  locale: 'ar' | 'en';
  token_enc: string;
  attempts: number;
}

/** Messages whose link has expired, whether queued or stuck in a dead worker's claim, are not worth sending. */
async function cancelExpired(): Promise<number> {
  return prisma.$executeRaw`
    UPDATE mail_outbox
       SET status = 'CANCELLED', token_enc = NULL, finished_at = now(), claim_id = NULL, locked_until = NULL, last_error = 'EXPIRED'
     WHERE expires_at <= now() AND (status = 'PENDING' OR (status = 'SENDING' AND locked_until <= now()))`;
}

/** A claim whose lease ran out and that has no attempts left (it kept crashing the worker) is a terminal failure. */
async function failExhaustedLeases(maxAttempts: number): Promise<number> {
  return prisma.$executeRaw`
    UPDATE mail_outbox
       SET status = 'FAILED', token_enc = NULL, finished_at = now(), claim_id = NULL, locked_until = NULL, last_error = 'WORKER_CRASHED'
     WHERE status = 'SENDING' AND locked_until <= now() AND attempts >= ${maxAttempts}`;
}

/** Takes ONE due row (or an abandoned one) under a lease. SKIP LOCKED: concurrent workers get different rows or none. */
async function claimOne(claimId: string): Promise<Claimed | null> {
  const rows = await prisma.$queryRaw<Claimed[]>`
    WITH due AS (
      SELECT id FROM mail_outbox
       WHERE (status = 'PENDING' AND next_attempt_at <= now()) OR (status = 'SENDING' AND locked_until <= now())
       ORDER BY next_attempt_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED)
    UPDATE mail_outbox m
       SET status = 'SENDING', claim_id = ${claimId}::uuid, locked_until = now() + make_interval(secs => ${LEASE_SECONDS}::double precision), attempts = m.attempts + 1
      FROM due
     WHERE m.id = due.id
    RETURNING m.id, m.kind::text AS kind, m.to_email, m.locale::text AS locale, m.token_enc, m.attempts`;
  return rows[0] ?? null;
}

// Every result is recorded only while the row is still OUR claim (claim_id + SENDING); 0 rows = someone else took it over.
const finishSent = (id: string, claimId: string) => prisma.$executeRaw`
  UPDATE mail_outbox SET status = 'SENT', sent_at = now(), finished_at = now(), token_enc = NULL, claim_id = NULL, locked_until = NULL, last_error = NULL
   WHERE id = ${id}::uuid AND claim_id = ${claimId}::uuid AND status = 'SENDING'`;

const finishFailed = (id: string, claimId: string, code: string) => prisma.$executeRaw`
  UPDATE mail_outbox SET status = 'FAILED', finished_at = now(), token_enc = NULL, claim_id = NULL, locked_until = NULL, last_error = ${code}
   WHERE id = ${id}::uuid AND claim_id = ${claimId}::uuid AND status = 'SENDING'`;

const scheduleRetry = (id: string, claimId: string, delayMs: number, code: string) => prisma.$executeRaw`
  UPDATE mail_outbox SET status = 'PENDING', next_attempt_at = now() + make_interval(secs => ${delayMs / 1000}::double precision), claim_id = NULL, locked_until = NULL, last_error = ${code}
   WHERE id = ${id}::uuid AND claim_id = ${claimId}::uuid AND status = 'SENDING'`;

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MailDeliveryError('send deadline exceeded', 'SEND_TIMEOUT', false)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

async function processRow(row: Claimed, claimId: string, send: SendFn, maxAttempts: number, deadlineMs: number, result: MailRunResult): Promise<void> {
  const log = { outboxId: row.id, kind: row.kind, attempt: row.attempts };
  let email: Email;
  try {
    email = renderMail(row.kind, row.to_email, row.locale, decryptOutboxToken(row.token_enc, row.id));
  } catch {
    // The token cannot be decrypted (server secret rotated, or the row was tampered with): retrying cannot help.
    if ((await finishFailed(row.id, claimId, 'DECRYPT_FAILED')) > 0) result.failed++;
    logger.error(log, 'mail outbox: message cannot be rendered, giving up');
    return;
  }

  try {
    await withDeadline(send(email, messageIdFor(row.id)), deadlineMs);
  } catch (err) {
    const e = err instanceof MailDeliveryError ? err : classifySmtpError(err);
    if (e.permanent || row.attempts >= maxAttempts) {
      if ((await finishFailed(row.id, claimId, e.code)) > 0) result.failed++;
      logger.error({ ...log, code: e.code, permanent: e.permanent }, 'mail outbox: giving up on a message');
    } else {
      if ((await scheduleRetry(row.id, claimId, backoffMs(row.attempts), e.code)) > 0) result.retried++;
      logger.warn({ ...log, code: e.code }, 'mail outbox: delivery failed, will retry');
    }
    return;
  }
  if ((await finishSent(row.id, claimId)) > 0) result.sent++;
  else {
    result.lostClaim++;
    logger.warn(log, 'mail outbox: message was sent but its claim had expired; another worker owns the row (possible duplicate)');
  }
}

/**
 * One pass: housekeeping, then claim and send due messages one at a time (up to `maxMessages`).
 * Safe to call from several processes at once.
 */
export async function runMailWorkerOnce(opts: MailRunOptions = {}): Promise<MailRunResult> {
  const send = opts.send ?? deliverEmail;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const result: MailRunResult = { sent: 0, retried: 0, failed: 0, cancelled: 0, lostClaim: 0 };
  result.cancelled += await cancelExpired();
  result.failed += await failExhaustedLeases(maxAttempts);
  for (let i = 0; i < (opts.maxMessages ?? MAX_PER_RUN); i++) {
    const claimId = randomUUID();
    const row = await claimOne(claimId);
    if (!row) break;
    await processRow(row, claimId, send, maxAttempts, opts.sendDeadlineMs ?? SEND_DEADLINE_MS, result);
  }
  return result;
}

/** Retention: finished rows hold a recipient address, so they are not kept forever. Idempotent. */
export async function purgeFinishedMail(): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM mail_outbox
     WHERE (status = 'SENT' AND finished_at < now() - make_interval(days => ${KEEP_SENT_DAYS}::int))
        OR (status IN ('FAILED', 'CANCELLED') AND finished_at < now() - make_interval(days => ${KEEP_FINISHED_DAYS}::int))`;
}

let kick: (() => void) | null = null;

/** Asks the running worker (if any) to look at the queue now, instead of at the next poll. Never throws, never waits. */
export function kickMailWorker(): void {
  kick?.();
}

/**
 * Starts polling (and listening to `kickMailWorker`). Returns a stop function that resolves when a pass in progress has ended.
 * Runs in every API instance; claiming makes that safe.
 */
export function scheduleMailWorker(intervalMs = POLL_MS): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  let lastPurge = 0;
  const tick = () => {
    if (running) {
      again = true; // a kick arrived during a pass: go round once more afterwards
      return;
    }
    running = (async () => {
      try {
        do {
          again = false;
          const r = await runMailWorkerOnce();
          if (r.sent || r.retried || r.failed || r.cancelled || r.lostClaim) logger.info(r, 'mail outbox pass');
        } while (again);
        if (Date.now() - lastPurge > 3_600_000) {
          lastPurge = Date.now();
          const purged = await purgeFinishedMail();
          if (purged > 0) logger.info({ purged }, 'mail outbox: old rows removed');
        }
      } catch (err) {
        logger.error({ err }, 'mail outbox pass failed');
      }
    })().finally(() => {
      running = null;
    });
  };
  kick = tick;
  const first = setTimeout(tick, 1_000);
  const timer = setInterval(tick, intervalMs);
  return async () => {
    kick = null;
    clearTimeout(first);
    clearInterval(timer);
    await running;
  };
}
