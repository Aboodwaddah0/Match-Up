import { randomUUID } from 'node:crypto';
import { expoClient, ExpoRequestError, type ExpoReceipt, type ExpoTicket, type PushClient } from '../lib/expo-push';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { buildPush, isPushType, KNOWN_TYPES, PUSH_TYPES } from '../modules/notifications/push-policy';
import { acquireTokens, authFailed, blockSending, channelOk, DEFAULT_RATE, enterChannel, refundTokens, releaseProbe, type Channel, type RateConfig } from './push-coordination';

/*
 * Push worker (NOTIF-01): turns pushable notifications into pushes on Expo. Four stages per pass, safe on several instances:
 *   1. fan-out   notification -> one PENDING push_delivery per device of an active user (ONE statement: atomic and repeatable)
 *   2. send      claim deliveries under a lease, send in batches of up to 100, record the TICKET (status ACCEPTED)
 *   3. receipts  ask Expo what happened to accepted pushes; DELIVERED / FAILED / retried / UNCONFIRMED
 *   4. housekeeping and (hourly) retention
 *
 * Guarantees and limits:
 *  - AT-LEAST-ONCE. Expo has no idempotency key: if Expo accepts a push and this process dies before recording the ticket, the push is
 *    sent again. collapseId / tag on the message reduce duplicates on the device; they are not a guarantee.
 *  - Two separate leases: SENDING rows carry claim_id + locked_until, a receipt check carries receipt_claim_id + receipt_locked_until on an
 *    ACCEPTED row. Database CHECKs (chk_push_claim, chk_push_receipt_lease) keep every lease column NULL on a row that is not in that phase.
 *  - A TICKET IS NOT A DELIVERY. A push counts as delivered only when its receipt says so. A receipt that never appears ends as
 *    UNCONFIRMED (not delivered, not failed).
 *  - No silent loss: a notification is marked fanned-out only in the statement that creates its deliveries; every failure ends in a visible
 *    state with an error code; the 24 h staleness rule and the reconciliation warning are logged. The in-app notification always remains.
 *  - Send and receipt authentication are separate channels (push-coordination.ts). A send authentication failure returns the batch to
 *    PENDING WITHOUT consuming attempts; a receipt authentication failure leaves rows ACCEPTED and only postpones the next receipt check.
 *    An ACCEPTED push is never sent again because receipts could not be read.
 *  - The combined send rate of all instances is limited by a shared token bucket.
 *  - Logs carry delivery ids and error codes: never a device token, the access token, a title or a body.
 */

// ───────────────────────── tuning (ours, not Expo's) ─────────────────────────

/** Documented maximum of messages per send request. */
export const SEND_BATCH = 100;
/** Documented maximum of ticket ids per getReceipts request. */
export const RECEIPT_BATCH = 1000;
export const LEASE_SECONDS = 120;
export const MAX_ATTEMPTS = 8;
/** Delay before attempt n+1 after attempt n failed (the last value repeats), jittered by +-20 %. */
export const SEND_BACKOFF_MS = [10_000, 60_000, 300_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000];
/** A notification older than this is not worth a push any more. Equals the push ttl. */
export const STALE_HOURS = 24;
/** When to look for the receipt, in minutes after the ticket: Expo recommends the first check at 15 minutes; receipts are cleared after 24 h. */
export const RECEIPT_OFFSETS_MIN = [15, 45, 105, 225, 465, 945, 1380];
export const RATE_LIMIT_BLOCK_SECONDS = 15;
const FANOUT_BATCH = 100;
const MAX_FANOUT_BATCHES = 10;
const MAX_SEND_BATCHES = 20;
const MAX_RECEIPT_BATCHES = 5;
const KEEP_DONE_DAYS = 14;
const KEEP_BAD_DAYS = 30;
const POLL_MS = 5_000;

/** Same shape the API accepts at registration: ExponentPushToken[...] / ExpoPushToken[...]. */
export const EXPO_TOKEN_SQL_REGEX = '^Expo(nent)?PushToken\\[[A-Za-z0-9_-]{10,100}\\]$';

export function sendBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = SEND_BACKOFF_MS[Math.min(Math.max(attempt, 1), SEND_BACKOFF_MS.length) - 1]!;
  return Math.round(base * (0.8 + random() * 0.4));
}

export interface PushRunOptions {
  /** The Expo client. Default: the real one. Tests inject a fake. */
  client?: PushClient;
  rate?: RateConfig;
  maxSendBatches?: number;
  /** How long a pass may wait for send tokens before giving up until the next pass. */
  maxTokenWaitMs?: number;
}

export interface PushRunResult {
  notificationsFannedOut: number;
  deliveriesCreated: number;
  staleNotifications: number;
  accepted: number;
  delivered: number;
  retried: number;
  failed: number;
  cancelled: number;
  unconfirmed: number;
  requeued: number;
  /** Results that could not be recorded because another worker had taken the row over (a possible duplicate). */
  lostClaim: number;
  paused: Channel[];
}

const emptyResult = (): PushRunResult => ({
  notificationsFannedOut: 0, deliveriesCreated: 0, staleNotifications: 0, accepted: 0, delivered: 0, retried: 0, failed: 0,
  cancelled: 0, unconfirmed: 0, requeued: 0, lostClaim: 0, paused: [],
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ───────────────────────── 1. fan-out ─────────────────────────

const warnedTypes = new Set<string>();

/**
 * ONE statement: lock a batch of notifications that have not been fanned out, create their deliveries, and mark them fanned out.
 * Either all of it happens or none of it (a crash leaves the rows untouched and the next pass redoes them); the UNIQUE
 * (notification, device) constraint makes a repeat harmless. Types that are not pushed, users that are not ACTIVE, devices whose token is
 * not an Expo token, and notifications older than 24 h produce no delivery but ARE marked, so they are never looked at again.
 */
async function fanOutBatch(): Promise<{ claimed: number; deliveries: number; stale: number; unknown: string[] }> {
  const [r] = await prisma.$queryRaw<{ claimed: number; deliveries: number; stale: number; unknown: string[] }[]>`
    WITH batch AS (
      SELECT id, user_id, type, created_at FROM notification
       WHERE push_fanout_at IS NULL
       ORDER BY created_at LIMIT ${FANOUT_BATCH}
       FOR UPDATE SKIP LOCKED),
    ins AS (
      INSERT INTO push_delivery (notification_id, user_id, device_token_id, expo_token)
      SELECT b.id, b.user_id, dt.id, dt.token
        FROM batch b
        JOIN "user" u ON u.id = b.user_id AND u.status = 'ACTIVE'
        JOIN device_token dt ON dt.user_id = b.user_id AND dt.token ~ ${EXPO_TOKEN_SQL_REGEX}
       WHERE b.type = ANY(${PUSH_TYPES}::text[]) AND b.created_at > now() - make_interval(hours => ${STALE_HOURS}::int)
      ON CONFLICT (notification_id, device_token_id) DO NOTHING
      RETURNING id),
    marked AS (
      UPDATE notification n SET push_fanout_at = now() FROM batch WHERE n.id = batch.id RETURNING n.id)
    SELECT (SELECT count(*) FROM marked)::int AS claimed,
           (SELECT count(*) FROM ins)::int AS deliveries,
           (SELECT count(*) FROM batch WHERE type = ANY(${PUSH_TYPES}::text[]) AND created_at <= now() - make_interval(hours => ${STALE_HOURS}::int))::int AS stale,
           COALESCE((SELECT array_agg(DISTINCT type) FROM batch WHERE NOT (type = ANY(${KNOWN_TYPES}::text[]))), '{}') AS unknown`;
  return r ?? { claimed: 0, deliveries: 0, stale: 0, unknown: [] };
}

async function fanOut(result: PushRunResult): Promise<void> {
  for (let i = 0; i < MAX_FANOUT_BATCHES; i++) {
    const r = await fanOutBatch();
    result.notificationsFannedOut += r.claimed;
    result.deliveriesCreated += r.deliveries;
    result.staleNotifications += r.stale;
    for (const t of r.unknown) {
      if (!warnedTypes.has(t)) {
        warnedTypes.add(t);
        logger.warn({ type: t }, 'push: unknown notification type is not pushed (default-deny); classify it in push-policy.ts');
      }
    }
    if (r.claimed < FANOUT_BATCH) break;
  }
}

// ───────────────────────── 4. housekeeping ─────────────────────────

async function housekeeping(result: PushRunResult): Promise<void> {
  // A claim whose lease ran out with no attempts left kept crashing the worker: terminal, visible.
  result.failed += await prisma.$executeRaw`
    UPDATE push_delivery
       SET status = 'FAILED', finished_at = now(), expo_token = NULL, claim_id = NULL, locked_until = NULL, last_error = 'WORKER_CRASHED'
     WHERE status = 'SENDING' AND locked_until <= now() AND attempts >= ${MAX_ATTEMPTS}`;
  // Waiting too long (for example through an authentication outage): a push for an event older than 24 h is no longer wanted.
  const stale = await prisma.$executeRaw`
    UPDATE push_delivery p
       SET status = 'CANCELLED', finished_at = now(), expo_token = NULL, claim_id = NULL, locked_until = NULL, last_error = 'STALE'
      FROM notification n
     WHERE n.id = p.notification_id AND p.status = 'PENDING' AND n.created_at <= now() - make_interval(hours => ${STALE_HOURS}::int)`;
  result.cancelled += stale;
  result.staleNotifications += stale;
  // Expo clears receipts after 24 h: past that there is nothing left to ask. NOT delivered and NOT failed: unknown.
  result.unconfirmed += await prisma.$executeRaw`
    UPDATE push_delivery
       SET status = 'UNCONFIRMED', finished_at = now(), expo_token = NULL, receipt_claim_id = NULL, receipt_locked_until = NULL, last_error = 'RECEIPT_WINDOW_CLOSED'
     WHERE status = 'ACCEPTED' AND ticket_at <= now() - interval '24 hours' AND (receipt_locked_until IS NULL OR receipt_locked_until <= now())`;
}

// ───────────────────────── row transitions (always conditional on OUR claim) ─────────────────────────

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type Db = Tx | typeof prisma;

/** A result is recorded only while the row is still this worker's claim, in the phase it was claimed in. */
const accepted = (id: string, claim: string, ticketId: string) => prisma.$executeRaw`
  UPDATE push_delivery
     SET status = 'ACCEPTED', ticket_id = ${ticketId}, ticket_at = now(), next_receipt_at = now() + interval '15 minutes', receipt_attempts = 0,
         claim_id = NULL, locked_until = NULL, last_error = NULL
   WHERE id = ${id}::uuid AND claim_id = ${claim}::uuid AND status = 'SENDING'`;

const delivered = (id: string, claim: string) => prisma.$executeRaw`
  UPDATE push_delivery
     SET status = 'DELIVERED', finished_at = now(), expo_token = NULL, receipt_claim_id = NULL, receipt_locked_until = NULL, last_error = NULL
   WHERE id = ${id}::uuid AND receipt_claim_id = ${claim}::uuid AND status = 'ACCEPTED'`;

/** Ends a delivery. `from` says which phase claimed it: SENDING rows hold the send lease, ACCEPTED rows the receipt lease. */
const finish = (db: Db, id: string, claim: string, from: 'SENDING' | 'ACCEPTED', status: 'FAILED' | 'CANCELLED' | 'UNCONFIRMED', code: string) =>
  from === 'SENDING'
    ? db.$executeRaw`
        UPDATE push_delivery
           SET status = ${status}::push_status, finished_at = now(), expo_token = NULL, claim_id = NULL, locked_until = NULL, last_error = ${code}
         WHERE id = ${id}::uuid AND claim_id = ${claim}::uuid AND status = 'SENDING'`
    : db.$executeRaw`
        UPDATE push_delivery
           SET status = ${status}::push_status, finished_at = now(), expo_token = NULL, receipt_claim_id = NULL, receipt_locked_until = NULL, last_error = ${code}
         WHERE id = ${id}::uuid AND receipt_claim_id = ${claim}::uuid AND status = 'ACCEPTED'`;

/** Back to PENDING after a failed SEND attempt. The attempt stays counted. */
const retryLater = (id: string, claim: string, delayMs: number, code: string) => prisma.$executeRaw`
  UPDATE push_delivery
     SET status = 'PENDING', next_attempt_at = now() + make_interval(secs => ${delayMs / 1000}::double precision), claim_id = NULL, locked_until = NULL, last_error = ${code}
   WHERE id = ${id}::uuid AND claim_id = ${claim}::uuid AND status = 'SENDING'`;

/**
 * The device is gone (Expo says so): delete the token (only if it still is the same token), cancel the device's other waiting
 * deliveries, and fail this one, together.
 */
async function failDeviceGone(id: string, claim: string, from: 'SENDING' | 'ACCEPTED', deviceId: string | null, token: string | null): Promise<number> {
  return prisma.$transaction(async (tx) => {
    if (deviceId && token) {
      await tx.$executeRaw`
        UPDATE push_delivery
           SET status = 'CANCELLED', finished_at = now(), expo_token = NULL, claim_id = NULL, locked_until = NULL, last_error = 'DEVICE_REMOVED'
         WHERE device_token_id = ${deviceId}::uuid AND status = 'PENDING' AND id <> ${id}::uuid`;
      await tx.$executeRaw`DELETE FROM device_token WHERE id = ${deviceId}::uuid AND token = ${token}`;
    }
    return finish(tx, id, claim, from, 'FAILED', 'DeviceNotRegistered');
  });
}

const CREDENTIAL_CODES = new Set(['MismatchSenderId', 'InvalidCredentials', 'InvalidProviderToken']);

// ───────────────────────── 2. send ─────────────────────────

interface Row {
  id: string;
  attempts: number;
  user_id: string;
  expo_token: string;
  device_token_id: string | null;
  notification_id: string;
  type: string;
  params: unknown;
  resource_type: string | null;
  resource_id: string | null;
  locale: 'ar' | 'en';
  user_status: string;
  device_token: string | null;
  device_user_id: string | null;
  stale: boolean;
}

async function claimForSend(limit: number, claim: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH due AS (
      SELECT id FROM push_delivery
       WHERE (status = 'PENDING' AND next_attempt_at <= now()) OR (status = 'SENDING' AND locked_until <= now() AND attempts < ${MAX_ATTEMPTS})
       ORDER BY next_attempt_at LIMIT ${limit}
       FOR UPDATE SKIP LOCKED)
    UPDATE push_delivery p
       SET status = 'SENDING', claim_id = ${claim}::uuid, locked_until = now() + make_interval(secs => ${LEASE_SECONDS}::double precision), attempts = p.attempts + 1
      FROM due WHERE p.id = due.id
    RETURNING p.id`;
  return rows.length;
}

function hydrate(claim: string): Promise<Row[]> {
  return prisma.$queryRaw<Row[]>`
    SELECT p.id, p.attempts, p.user_id, p.expo_token, p.device_token_id, n.id AS notification_id, n.type, n.params, n.resource_type, n.resource_id,
           u.locale::text AS locale, u.status::text AS user_status, dt.token AS device_token, dt.user_id AS device_user_id,
           (n.created_at <= now() - make_interval(hours => ${STALE_HOURS}::int)) AS stale
      FROM push_delivery p
      JOIN notification n ON n.id = p.notification_id
      JOIN "user" u ON u.id = p.user_id
      LEFT JOIN device_token dt ON dt.id = p.device_token_id
     WHERE p.claim_id = ${claim}::uuid AND p.status = 'SENDING'
     ORDER BY p.next_attempt_at`;
}

/** Why a claimed delivery must NOT be sent after all (checked at send time, not only at fan-out). */
function cancelReason(r: Row): string | null {
  if (!isPushType(r.type)) return 'NOT_PUSHABLE';
  if (r.device_token === null) return 'DEVICE_REMOVED';
  if (r.device_token !== r.expo_token || r.device_user_id !== r.user_id) return 'DEVICE_CHANGED';
  if (r.user_status !== 'ACTIVE') return 'USER_INELIGIBLE';
  if (r.stale) return 'STALE';
  return null;
}

type SendOutcome = 'answered' | 'auth' | 'unknown';

/** Retry after a failed attempt, or give up when the attempts are used up. */
async function retryOrFail(r: Row, claim: string, code: string, result: PushRunResult): Promise<void> {
  if (r.attempts >= MAX_ATTEMPTS) {
    if ((await finish(prisma, r.id, claim, 'SENDING', 'FAILED', code)) > 0) result.failed++;
    logger.error({ deliveryId: r.id, code, attempts: r.attempts }, 'push: giving up on a delivery');
    return;
  }
  if ((await retryLater(r.id, claim, sendBackoffMs(r.attempts), code)) > 0) result.retried++;
}

async function handleTicket(r: Row, claim: string, ticket: ExpoTicket, result: PushRunResult): Promise<void> {
  if (ticket.status === 'ok') {
    if ((await accepted(r.id, claim, ticket.id)) > 0) result.accepted++;
    else {
      result.lostClaim++;
      logger.warn({ deliveryId: r.id }, 'push: sent, but the claim had expired and another worker owns the row (possible duplicate)');
    }
    return;
  }
  const code = String(ticket.details?.error ?? 'UNKNOWN').slice(0, 60);
  if (code === 'DeviceNotRegistered') {
    if ((await failDeviceGone(r.id, claim, 'SENDING', r.device_token_id, r.expo_token)) > 0) result.failed++;
  } else if (code === 'MessageTooBig' || CREDENTIAL_CODES.has(code)) {
    if ((await finish(prisma, r.id, claim, 'SENDING', 'FAILED', code)) > 0) result.failed++;
    logger.error({ deliveryId: r.id, code }, 'push: delivery failed permanently');
  } else {
    await retryOrFail(r, claim, code === 'MessageRateExceeded' ? code : `TICKET_${code}`, result);
  }
}

/** Sends one claimed batch. Returns what Expo's answer says about our credentials. */
async function sendClaimed(claim: string, rate: RateConfig, client: PushClient, probeClaim: string | null, result: PushRunResult): Promise<{ outcome: SendOutcome; granted: number }> {
  const rows = await hydrate(claim);
  const sendable: { row: Row; message: NonNullable<ReturnType<typeof buildPush>> }[] = [];
  let cancelled = 0;
  for (const r of rows) {
    const reason = cancelReason(r);
    const message = reason ? null : buildPush({ notificationId: r.notification_id, type: r.type, params: r.params, resourceType: r.resource_type, resourceId: r.resource_id }, r.expo_token, r.locale);
    if (reason || !message) {
      if ((await finish(prisma, r.id, claim, 'SENDING', 'CANCELLED', reason ?? 'NOT_PUSHABLE')) > 0) {
        result.cancelled++;
        cancelled++;
      }
      continue;
    }
    sendable.push({ row: r, message });
  }
  if (cancelled > 0) await refundTokens(cancelled, rate);
  if (sendable.length === 0) return { outcome: 'unknown', granted: 0 };

  let tickets: ExpoTicket[];
  try {
    tickets = await client.send(sendable.map((s) => s.message));
  } catch (err) {
    const ids = sendable.map((s) => s.row.id);
    if (err instanceof ExpoRequestError && err.kind === 'AUTH') {
      // Credentials rejected: nothing was sent, so hand the attempts back and wait. The work is kept, in its original stage (PENDING).
      const until = await authFailed('SEND', err.code, probeClaim);
      await prisma.$executeRaw`
        UPDATE push_delivery
           SET status = 'PENDING', attempts = attempts - 1, next_attempt_at = ${until}, claim_id = NULL, locked_until = NULL, last_error = 'AUTH_PAUSED'
         WHERE id = ANY(${ids}::uuid[]) AND claim_id = ${claim}::uuid AND status = 'SENDING'`;
      return { outcome: 'auth', granted: 0 };
    }
    if (err instanceof ExpoRequestError && err.kind === 'RATE_LIMIT') {
      await blockSending(RATE_LIMIT_BLOCK_SECONDS); // every instance stops, not just this one
      await prisma.$executeRaw`
        UPDATE push_delivery
           SET status = 'PENDING', attempts = attempts - 1, next_attempt_at = now() + make_interval(secs => ${RATE_LIMIT_BLOCK_SECONDS}::double precision), claim_id = NULL, locked_until = NULL, last_error = 'RATE_LIMITED'
         WHERE id = ANY(${ids}::uuid[]) AND claim_id = ${claim}::uuid AND status = 'SENDING'`;
      return { outcome: 'answered', granted: 0 }; // Expo answered, so the credentials work
    }
    const code = err instanceof ExpoRequestError ? err.code : 'UNKNOWN';
    for (const s of sendable) await retryOrFail(s.row, claim, code, result);
    return { outcome: 'unknown', granted: 0 }; // says nothing about the credentials
  }

  for (let i = 0; i < sendable.length; i++) await handleTicket(sendable[i]!.row, claim, tickets[i]!, result);
  return { outcome: 'answered', granted: 0 };
}

async function takeTokens(want: number, rate: RateConfig, maxWaitMs: number): Promise<number> {
  const started = Date.now();
  for (;;) {
    const r = await acquireTokens(want, rate);
    if (r.granted > 0) return r.granted;
    const left = maxWaitMs - (Date.now() - started);
    if (left <= 0) return 0;
    await sleep(Math.min(Math.max(r.waitMs, 5), 1000, left));
  }
}

async function sendStage(client: PushClient, opts: PushRunOptions, result: PushRunResult): Promise<void> {
  const gate = await enterChannel('SEND');
  if (!gate.run) {
    result.paused.push('SEND');
    return;
  }
  const rate = opts.rate ?? DEFAULT_RATE;
  let probeClaim = gate.probe ? gate.probeClaim : null;
  for (let i = 0; i < (opts.maxSendBatches ?? MAX_SEND_BATCHES); i++) {
    const want = probeClaim ? 1 : SEND_BATCH; // the probe is ONE pending delivery
    const granted = await takeTokens(want, rate, opts.maxTokenWaitMs ?? 2_000);
    if (granted === 0) break;
    const claim = randomUUID();
    const claimed = await claimForSend(granted, claim);
    if (claimed < granted) await refundTokens(granted - claimed, rate);
    if (claimed === 0) {
      if (probeClaim) await releaseProbe('SEND', probeClaim, 0); // nothing to probe with right now
      break;
    }
    const { outcome } = await sendClaimed(claim, rate, client, probeClaim, result);
    if (outcome === 'auth') {
      result.paused.push('SEND'); // authFailed() already lengthened the pause and released the probe
      break;
    }
    if (probeClaim) {
      if (outcome === 'answered') await channelOk('SEND', probeClaim);
      else await releaseProbe('SEND', probeClaim); // the answer said nothing about the credentials
      probeClaim = null;
      if (outcome !== 'answered') break;
    }
    if (claimed < granted) break; // fewer due rows than tokens: the queue is drained
  }
}

// ───────────────────────── 3. receipts ─────────────────────────

interface ReceiptRow {
  id: string;
  ticket_id: string;
  ticket_at: Date;
  device_token_id: string | null;
  expo_token: string;
  attempts: number;
  receipt_attempts: number;
}

async function claimReceipts(limit: number, claim: string): Promise<ReceiptRow[]> {
  return prisma.$queryRaw<ReceiptRow[]>`
    WITH due AS (
      SELECT id FROM push_delivery
       WHERE status = 'ACCEPTED' AND next_receipt_at <= now() AND ticket_at > now() - interval '24 hours'
         AND (receipt_locked_until IS NULL OR receipt_locked_until <= now())
       ORDER BY next_receipt_at LIMIT ${limit}
       FOR UPDATE SKIP LOCKED)
    UPDATE push_delivery p
       SET receipt_claim_id = ${claim}::uuid, receipt_locked_until = now() + make_interval(secs => ${LEASE_SECONDS}::double precision)
      FROM due WHERE p.id = due.id
    RETURNING p.id, p.ticket_id, p.ticket_at, p.device_token_id, p.expo_token, p.attempts, p.receipt_attempts`;
}

/** Looks at one receipt (or its absence) and moves the delivery on. Never touches a row that is not still our claim. */
async function handleReceipt(r: ReceiptRow, claim: string, receipt: ExpoReceipt | undefined, result: PushRunResult): Promise<void> {
  if (!receipt) {
    // Not available (yet). Keep asking on a widening schedule until the 24 h window closes.
    const k = r.receipt_attempts + 1;
    if (k >= RECEIPT_OFFSETS_MIN.length) {
      if ((await finish(prisma, r.id, claim, 'ACCEPTED', 'UNCONFIRMED', 'NO_RECEIPT')) > 0) result.unconfirmed++;
      return;
    }
    await prisma.$executeRaw`
      UPDATE push_delivery
         SET receipt_attempts = ${k}, next_receipt_at = GREATEST(now() + interval '1 minute', ticket_at + make_interval(mins => ${RECEIPT_OFFSETS_MIN[k]!}::int)), receipt_claim_id = NULL, receipt_locked_until = NULL
       WHERE id = ${r.id}::uuid AND receipt_claim_id = ${claim}::uuid AND status = 'ACCEPTED'`;
    return;
  }
  if (receipt.status === 'ok') {
    if ((await delivered(r.id, claim)) > 0) result.delivered++;
    return;
  }
  const code = String(receipt.details?.error ?? 'UNKNOWN').slice(0, 60);
  if (code === 'DeviceNotRegistered') {
    if ((await failDeviceGone(r.id, claim, 'ACCEPTED', r.device_token_id, r.expo_token)) > 0) result.failed++;
  } else if (code === 'MessageRateExceeded') {
    // The provider refused the push because the device was rate limited: it did NOT reach the device, so sending it again is correct.
    // This is the only way an ACCEPTED delivery returns to PENDING, and it clears the ticket on purpose (chk_push_ticket_phase).
    if (r.attempts >= MAX_ATTEMPTS) {
      if ((await finish(prisma, r.id, claim, 'ACCEPTED', 'FAILED', code)) > 0) result.failed++;
    } else {
      const n = await prisma.$executeRaw`
        UPDATE push_delivery
           SET status = 'PENDING', ticket_id = NULL, ticket_at = NULL, next_receipt_at = NULL, receipt_attempts = 0,
               next_attempt_at = now() + make_interval(secs => ${sendBackoffMs(r.attempts) / 1000}::double precision), receipt_claim_id = NULL, receipt_locked_until = NULL, last_error = ${code}
         WHERE id = ${r.id}::uuid AND receipt_claim_id = ${claim}::uuid AND status = 'ACCEPTED'`;
      if (n > 0) result.requeued++;
    }
  } else {
    // MessageTooBig, MismatchSenderId, InvalidCredentials, anything else: terminal and visible (README: how to requeue after a fix).
    if ((await finish(prisma, r.id, claim, 'ACCEPTED', 'FAILED', CREDENTIAL_CODES.has(code) || code === 'MessageTooBig' ? code : `RECEIPT_${code}`)) > 0) result.failed++;
    logger.error({ deliveryId: r.id, code }, 'push: receipt reports a failure');
  }
}

async function receiptStage(client: PushClient, result: PushRunResult): Promise<void> {
  const gate = await enterChannel('RECEIPT');
  if (!gate.run) {
    result.paused.push('RECEIPT');
    return;
  }
  let probeClaim = gate.probe ? gate.probeClaim : null;
  for (let i = 0; i < MAX_RECEIPT_BATCHES; i++) {
    const want = probeClaim ? 1 : RECEIPT_BATCH; // the probe is a read-only request for ONE receipt: it can never resend anything
    const claim = randomUUID();
    const rows = await claimReceipts(want, claim);
    if (rows.length === 0) {
      if (probeClaim) await releaseProbe('RECEIPT', probeClaim, 0); // nothing due to ask about
      break;
    }
    let receipts: Record<string, ExpoReceipt>;
    try {
      receipts = await client.getReceipts(rows.map((r) => r.ticket_id));
    } catch (err) {
      const ids = rows.map((r) => r.id);
      if (err instanceof ExpoRequestError && err.kind === 'AUTH') {
        // The rows stay ACCEPTED. Only the next receipt check moves; no status change, no attempt consumed. Nothing can be sent again from here.
        const until = await authFailed('RECEIPT', err.code, probeClaim);
        await prisma.$executeRaw`
          UPDATE push_delivery SET next_receipt_at = ${until}, receipt_claim_id = NULL, receipt_locked_until = NULL
           WHERE id = ANY(${ids}::uuid[]) AND receipt_claim_id = ${claim}::uuid AND status = 'ACCEPTED'`;
        result.paused.push('RECEIPT');
        return;
      }
      const delay = err instanceof ExpoRequestError && err.kind === 'RATE_LIMIT' ? 60 : 300;
      await prisma.$executeRaw`
        UPDATE push_delivery SET next_receipt_at = now() + make_interval(secs => ${delay}::double precision), receipt_claim_id = NULL, receipt_locked_until = NULL
         WHERE id = ANY(${ids}::uuid[]) AND receipt_claim_id = ${claim}::uuid AND status = 'ACCEPTED'`;
      if (probeClaim) {
        if (err instanceof ExpoRequestError && err.kind === 'RATE_LIMIT') await channelOk('RECEIPT', probeClaim); // Expo answered: the credentials work
        else await releaseProbe('RECEIPT', probeClaim);
      }
      return;
    }
    if (probeClaim) {
      await channelOk('RECEIPT', probeClaim);
      probeClaim = null;
    }
    for (const r of rows) await handleReceipt(r, claim, receipts[r.ticket_id], result);
    if (rows.length < want) break;
  }
}

// ───────────────────────── retention and reconciliation ─────────────────────────

/** Deletes FINISHED deliveries only. PENDING (also retrying), SENDING (leased) and ACCEPTED (waiting for a receipt) are never touched. */
export async function purgePushDeliveries(): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM push_delivery
     WHERE (status IN ('DELIVERED', 'CANCELLED') AND finished_at < now() - make_interval(days => ${KEEP_DONE_DAYS}::int))
        OR (status IN ('FAILED', 'UNCONFIRMED') AND finished_at < now() - make_interval(days => ${KEEP_BAD_DAYS}::int))`;
}

/** A pushable notification that has waited unreasonably long for its fan-out means the worker is not keeping up. Visible, not silent. */
export async function unfannedPushableCount(): Promise<number> {
  const [r] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM notification
     WHERE push_fanout_at IS NULL AND created_at < now() - interval '15 minutes' AND type = ANY(${PUSH_TYPES}::text[])`;
  return r?.n ?? 0;
}

// ───────────────────────── one pass, and the scheduler ─────────────────────────

/** One full pass (all four stages). Safe to call from several processes at once. */
export async function runPushWorkerOnce(opts: PushRunOptions = {}): Promise<PushRunResult> {
  const client = opts.client ?? expoClient;
  const result = emptyResult();
  await fanOut(result);
  await housekeeping(result);
  await sendStage(client, opts, result);
  await receiptStage(client, result);
  return result;
}

/** Starts polling. Returns a stop function that resolves when a pass in progress has ended. */
export function schedulePushWorker(intervalMs = POLL_MS): () => Promise<void> {
  let running: Promise<void> | null = null;
  let lastHourly = 0;
  const tick = () => {
    if (running) return;
    running = (async () => {
      try {
        const r = await runPushWorkerOnce();
        const interesting = r.notificationsFannedOut || r.accepted || r.delivered || r.retried || r.failed || r.cancelled || r.unconfirmed || r.requeued || r.lostClaim || r.paused.length;
        if (interesting) logger.info(r, 'push pass');
        if (Date.now() - lastHourly > 3_600_000) {
          lastHourly = Date.now();
          const purged = await purgePushDeliveries();
          if (purged > 0) logger.info({ purged }, 'push: old finished deliveries removed');
          const behind = await unfannedPushableCount();
          if (behind > 0) logger.warn({ behind }, 'push: pushable notifications are waiting for fan-out for more than 15 minutes');
        }
      } catch (err) {
        logger.error({ err }, 'push pass failed');
      }
    })().finally(() => {
      running = null;
    });
  };
  const first = setTimeout(tick, 2_000);
  const timer = setInterval(tick, intervalMs);
  return async () => {
    clearTimeout(first);
    clearInterval(timer);
    await running;
  };
}
