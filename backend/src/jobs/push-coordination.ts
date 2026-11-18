import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';

/*
 * What all API instances must agree on while pushing (NOTIF-01). Both pieces live in PostgreSQL, so no extra service is needed
 * and instance clocks do not matter (every time comparison uses the database clock).
 *
 *  1. Provider channel state: SEND and RECEIPT are separate channels. When Expo rejects our credentials, only the channel that
 *     saw it is paused; after the pause ONE instance (elected by a conditional UPDATE) probes it. The caller decides what a probe
 *     is: a single pending delivery for SEND, a read-only getReceipts request for RECEIPT. A receipt problem can therefore never
 *     cause a push to be sent again.
 *  2. A token bucket that keeps the COMBINED send rate of every instance under Expo's per-project limit.
 */

export type Channel = 'SEND' | 'RECEIPT';

/** Pause after the 1st, 2nd, 3rd and later consecutive authentication failures (minutes). */
export const PAUSE_MINUTES = [5, 15, 30, 60];
export const PROBE_LEASE_SECONDS = 120;

export type Gate = { run: false } | { run: true; probe: boolean; probeClaim: string | null };

/** May this instance work on the channel now? Healthy: yes. Paused: no. Pause over: yes, but only for the single instance that wins the probe. */
export async function enterChannel(channel: Channel): Promise<Gate> {
  const [row] = await prisma.$queryRaw<{ status: string; paused: boolean }[]>`
    SELECT status::text AS status, (paused_until IS NOT NULL AND paused_until > now()) AS paused
      FROM push_provider_state WHERE channel = ${channel}::push_channel`;
  if (!row || row.status === 'OK') return { run: true, probe: false, probeClaim: null };
  if (row.paused) return { run: false };
  const claim = randomUUID();
  const won = await prisma.$queryRaw<{ channel: string }[]>`
    UPDATE push_provider_state
       SET probe_claim_id = ${claim}::uuid, probe_until = now() + make_interval(secs => ${PROBE_LEASE_SECONDS}::double precision)
     WHERE channel = ${channel}::push_channel AND status = 'AUTH_FAILED' AND paused_until <= now()
       AND (probe_until IS NULL OR probe_until <= now())
    RETURNING channel::text AS channel`;
  return won.length > 0 ? { run: true, probe: true, probeClaim: claim } : { run: false };
}

/**
 * Records that Expo rejected our credentials and returns when the channel may be tried again (the caller postpones its own rows to
 * that moment). From a normal run it opens the pause (once, even if several instances notice at the same time); from the probe it
 * lengthens it. One error log per pause, never one per delivery, and never any secret.
 */
export async function authFailed(channel: Channel, code: string, probeClaim: string | null): Promise<Date> {
  if (probeClaim) {
    const [r] = await prisma.$queryRaw<{ paused_until: Date; consecutive_failures: number }[]>`
      UPDATE push_provider_state
         SET paused_until = now() + make_interval(mins => (ARRAY[5, 15, 30, 60])[LEAST(consecutive_failures + 1, 4)]),
             consecutive_failures = consecutive_failures + 1, last_error_code = ${code}, last_error_at = now(), probe_claim_id = NULL, probe_until = NULL
       WHERE channel = ${channel}::push_channel AND status = 'AUTH_FAILED' AND probe_claim_id = ${probeClaim}::uuid
      RETURNING paused_until, consecutive_failures`;
    if (r) {
      logger.error({ channel, code, failures: r.consecutive_failures, pausedUntil: r.paused_until }, 'push: Expo still rejects the credentials, channel stays paused');
      return r.paused_until;
    }
  } else {
    const [r] = await prisma.$queryRaw<{ paused_until: Date }[]>`
      UPDATE push_provider_state
         SET status = 'AUTH_FAILED', consecutive_failures = 1, paused_until = now() + make_interval(mins => 5), last_error_code = ${code}, last_error_at = now(),
             probe_claim_id = NULL, probe_until = NULL
       WHERE channel = ${channel}::push_channel AND status = 'OK'
      RETURNING paused_until`;
    if (r) {
      logger.error(
        { channel, code, pausedUntil: r.paused_until },
        'push: Expo rejected the credentials. Pending work is kept and resumes by itself once they are fixed (check EXPO_ACCESS_TOKEN and EXPO_ENHANCED_SECURITY)',
      );
      return r.paused_until;
    }
  }
  // Someone else already opened (or changed) the pause: use theirs.
  const [cur] = await prisma.$queryRaw<{ paused_until: Date | null }[]>`SELECT paused_until FROM push_provider_state WHERE channel = ${channel}::push_channel`;
  return cur?.paused_until ?? new Date(Date.now() + 5 * 60_000);
}

/** Expo answered without rejecting our credentials: a paused channel is healthy again and resumes from where it stopped. */
export async function channelOk(channel: Channel, probeClaim: string | null): Promise<void> {
  const resumed = await prisma.$executeRaw`
    UPDATE push_provider_state
       SET status = 'OK', paused_until = NULL, consecutive_failures = 0, probe_claim_id = NULL, probe_until = NULL
     WHERE channel = ${channel}::push_channel AND status = 'AUTH_FAILED' AND (${probeClaim}::uuid IS NULL OR probe_claim_id = ${probeClaim}::uuid)`;
  if (resumed > 0) logger.info({ channel }, 'push: Expo accepts the credentials again, channel resumed');
}

/** A probe that learned nothing about the credentials (network error, 5xx): give the probe up and try again soon. */
export async function releaseProbe(channel: Channel, probeClaim: string, retryAfterSeconds = 60): Promise<void> {
  await prisma.$executeRaw`
    UPDATE push_provider_state
       SET probe_claim_id = NULL, probe_until = NULL, paused_until = now() + make_interval(secs => ${retryAfterSeconds}::double precision)
     WHERE channel = ${channel}::push_channel AND status = 'AUTH_FAILED' AND probe_claim_id = ${probeClaim}::uuid`;
}

// ───────────────────────── shared send rate (token bucket) ─────────────────────────

export interface RateConfig {
  perSecond: number;
  capacity: number;
}

/** 300 messages per second for ALL instances together: half of Expo's documented 600 per second per project. */
export const DEFAULT_RATE: RateConfig = { perSecond: 300, capacity: 300 };

/**
 * Takes up to `n` tokens from the shared bucket in ONE atomic statement (the row is locked, refilled from the elapsed database
 * time, and debited). Messages sent by all instances in any window of T seconds are at most capacity + perSecond * T.
 * `waitMs` tells a caller that got nothing when it is worth asking again. Tokens taken but not used are returned with refundTokens;
 * tokens lost to a crash are simply gone, which errs on the safe side.
 */
export async function acquireTokens(n: number, cfg: RateConfig = DEFAULT_RATE): Promise<{ granted: number; waitMs: number }> {
  const [r] = await prisma.$queryRaw<{ granted: number; wait_ms: number }[]>`
    WITH cur AS (
      SELECT tokens, refilled_at, blocked_until FROM push_rate_bucket WHERE id = 1 FOR UPDATE),
    calc AS (
      SELECT LEAST(${cfg.capacity}::double precision, tokens + ${cfg.perSecond}::double precision * GREATEST(EXTRACT(EPOCH FROM (clock_timestamp() - refilled_at)), 0)) AS avail,
             (blocked_until IS NOT NULL AND blocked_until > clock_timestamp()) AS blocked, blocked_until
        FROM cur),
    g AS (
      SELECT avail, blocked, blocked_until, CASE WHEN blocked THEN 0 ELSE LEAST(${n}::int, floor(avail))::int END AS granted FROM calc)
    UPDATE push_rate_bucket b SET tokens = g.avail - g.granted, refilled_at = clock_timestamp()
      FROM g WHERE b.id = 1
    RETURNING g.granted::int AS granted,
      (CASE WHEN g.granted > 0 THEN 0
            WHEN g.blocked THEN ceil(EXTRACT(EPOCH FROM (g.blocked_until - clock_timestamp())) * 1000)
            ELSE ceil((1 - g.avail) / ${cfg.perSecond}::double precision * 1000) END)::int AS wait_ms`;
  return { granted: r?.granted ?? 0, waitMs: r?.wait_ms ?? 1000 };
}

export async function refundTokens(k: number, cfg: RateConfig = DEFAULT_RATE): Promise<void> {
  if (k <= 0) return;
  await prisma.$executeRaw`UPDATE push_rate_bucket SET tokens = LEAST(${cfg.capacity}::double precision, tokens + ${k}::double precision) WHERE id = 1`;
}

/** Expo said "too many requests": stop ALL instances for a while, not just the one that saw it. */
export async function blockSending(seconds: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE push_rate_bucket
       SET tokens = 0, blocked_until = GREATEST(COALESCE(blocked_until, clock_timestamp()), clock_timestamp() + make_interval(secs => ${seconds}::double precision))
     WHERE id = 1`;
}
