import { randomUUID } from 'node:crypto';
import { ALL_RESOURCE_TYPES, storage, StorageError } from '../lib/cloudinary';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';

/*
 * Media deletion worker. Removes files from the storage provider and only then deletes their rows.
 *
 * WHY THE ROW OUTLIVES THE FILE: the row is the only record of the storage key. If it were deleted first (a cascade, a failed request, a crash) the
 * file would stay at the provider forever, still reachable by its URL. A database trigger therefore refuses to DELETE any row that is not DELETING,
 * and this worker deletes a row only after the provider confirmed that the file is gone.
 *
 * WHAT THE WORKER DOES
 *  1. Stale uploads: a PENDING row older than PENDING_TTL (the one-hour signature lifetime plus a grace period) was never confirmed. It moves to
 *     DELETING instead of being deleted, because the file may already be at the provider.
 *  2. Claims ONE DELETING row at a time under a lease (FOR UPDATE SKIP LOCKED, like the mail worker), so several instances never delete the same row
 *     and a worker that dies mid-way is simply replaced once its lease expires.
 *  3. Deletes the file under EVERY resource type (image, video, raw). The upload signature does not cover the resource type, so a client can place
 *     a file under a type other than the expected one; trying all three locates it wherever it is. "Not found" counts as deleted (idempotent).
 *  4. Success (all three answered deleted / not found): the row is deleted, conditional on our claim id, BUT NOT BEFORE THE UPLOAD WINDOW HAS CLOSED
 *     (see "THE UPLOAD WINDOW" below): a row deleted earlier is kept, hidden, as a tombstone and swept once more when the window is over. Failure: the
 *     row stays DELETING (hidden, no URL) and is retried with exponential backoff, for as long as it takes; it is never abandoned and never deleted
 *     without the provider's answer.
 *
 *  5. Stray sweeps (after a successful confirmation): the upload signature does not cover the resource type, so a client can also have put a file
 *     under ANOTHER type than the one confirmed (and a raw file is stored as "<key>.<extension>"). Every READY item has THREE sweeps scheduled by the
 *     confirmation (media_item.stray_sweeps_left): one due at once, one when the upload window has closed (STRAY_WINDOW_MINUTES after the slot was
 *     created) and a last one STRAY_LATE_AFTER_HOURS after it, as insurance against an upload that was still being PROCESSED at the provider when the
 *     window closed. A sweep deletes the object under every resource type EXCEPT the verified canonical one: a photo (stored as "image") is swept
 *     under video and raw, a video under image and raw. A key is "<folder>/media/<row uuid>", so nothing that belongs to another row can match; the
 *     raw sweep matches the key itself and "<key>.*" only. A sweep never touches the READY item: a failure only reschedules the sweep (the same
 *     backoff as deletions, never abandoned; whatever is left when the item is deleted is removed by the deletion path above).
 *     COST: each item makes three upload-API deletes (image or video namespace) and three Admin-API listings (raw) over its lifetime, in addition to
 *     the one Admin-API lookup of the confirmation. A pass handles at most MAX_STRAY_PER_RUN sweeps and STOPS at the first rate-limit / network /
 *     credential failure, so an outage costs one call per pass, not one per item.
 *
 * THE UPLOAD WINDOW (verified against the live service, see the README "Media API"): a signature is accepted while its timestamp is at most about
 * 3,600 s old and refused after that ("Stale request"). The timestamp is checked when the request has been RECEIVED IN FULL, not when it starts: an
 * upload that began 20 s before the expiry and took 153 s was refused and created no asset. So a slow or interrupted upload cannot complete after the
 * window; only a request whose body had fully arrived before the expiry can still be creating its asset afterwards, i.e. only the provider's own
 * processing time can reach past it (not published; the margin is 10 minutes, and the last sweep is 24 hours out). Nothing is claimed beyond that.
 * The window matters for DELETIONS too: a user who deletes a slot (or a rejected confirmation) can still upload with the signature that stays valid
 * for the rest of the hour, creating an asset with NO row. Therefore a row is removed only after the window, with a last sweep at the provider.
 *
 * MONITORING: every failed attempt is a structured log line (code, attempt number, media id; no keys of other users, no URLs). From the 3rd failed
 * attempt it is logged at ERROR. GET /admin/stats reports `mediaDeletionStuck`: files hidden more than 24 hours ago that are still not deleted.
 * Bad credentials (AUTH) push the row 30 minutes out, so a misconfigured key is not hammered every few seconds.
 */

/** Signature lifetime (1 h) + a grace period for a slow confirm. After this an unconfirmed slot is useless and is cleaned up. */
export const PENDING_TTL_MINUTES = 120;
export const LEASE_SECONDS = 120;
/** Delay before the next attempt after attempt n failed; the last value repeats forever. Jittered by +-20%. */
export const BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
const AUTH_DELAY_MS = 1_800_000;
const NOT_CONFIGURED_DELAY_MS = 3_600_000;
const ERROR_LOG_FROM_ATTEMPT = 3;
const MAX_PER_RUN = 25;
/** Stray sweeps handled per pass. Small on purpose: the raw listing is an Admin API call, which Cloudinary rate-limits per plan. */
export const MAX_STRAY_PER_RUN = 10;
/**
 * The upload window: the signature lifetime (60 min) plus 10 min of grace for clock differences and the provider's processing of a request that was
 * received just before the expiry. A deleted row is kept until this long after its slot was created, and the second sweep runs then.
 */
export const STRAY_WINDOW_MINUTES = 70;
/** The last sweep, as insurance against an upload that was still being processed by the provider when the window closed (no published limit exists). */
export const STRAY_LATE_AFTER_HOURS = 24;
const STALE_BATCH = 200;
const POLL_MS = 10_000;

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1]!;
  return Math.round(base * (0.8 + random() * 0.4));
}

/** What the worker needs from the provider (the real one by default; tests inject their own). */
export type DestroyFn = (key: string, resourceType: (typeof ALL_RESOURCE_TYPES)[number]) => Promise<'deleted' | 'not_found'>;

export interface MediaRunOptions {
  destroy?: DestroyFn;
  /** How long after its slot was created a deleted row is kept (default STRAY_WINDOW_MINUTES). Tests use 0 to delete at once. */
  holdMinutes?: number;
  maxRows?: number;
  /** Stray sweeps per pass (default MAX_STRAY_PER_RUN). */
  maxStray?: number;
  pendingTtlMinutes?: number;
}

export interface MediaRunResult {
  /** Unconfirmed uploads moved to DELETING. */
  expired: number;
  /** Rows whose file is gone from the provider and that were deleted. */
  deleted: number;
  /** Rows whose file is gone but that were KEPT (hidden) until the upload window closes; they get one more sweep then. */
  held: number;
  /** Attempts that failed and were rescheduled. */
  retried: number;
  /** Results not recorded because another worker had taken the row over (its lease had expired). */
  lostClaim: number;
  /** Stray sweeps of READY items that finished (each item has two). */
  swept: number;
  /** Stray sweeps that failed and were rescheduled (the READY item is untouched). */
  sweepRetried: number;
}

interface Claimed {
  id: string;
  storage_key: string;
  deletion_attempts: number;
}

/** Unconfirmed uploads become DELETING (bounded batch, rows skipped when locked: a confirm in flight decides first). Idempotent. */
async function expireStalePending(ttlMinutes: number): Promise<number> {
  return prisma.$executeRaw`
    UPDATE media_item
       SET status = 'DELETING', url = NULL, thumbnail_url = NULL, deleting_since = now(), next_deletion_at = now(), updated_at = now()
     WHERE id IN (
       SELECT id FROM media_item
        WHERE status = 'PENDING' AND created_at < now() - make_interval(mins => ${ttlMinutes}::int)
        ORDER BY created_at LIMIT ${STALE_BATCH}
        FOR UPDATE SKIP LOCKED)`;
}

/** Takes ONE due row (or an abandoned one whose lease expired) under a lease. Only CLOUDINARY rows: another provider needs its own worker. */
async function claimOne(claimId: string): Promise<Claimed | null> {
  const rows = await prisma.$queryRaw<Claimed[]>`
    WITH due AS (
      SELECT id FROM media_item
       WHERE status = 'DELETING' AND provider = 'CLOUDINARY' AND next_deletion_at <= now()
         AND (deletion_lease_until IS NULL OR deletion_lease_until <= now())
       ORDER BY next_deletion_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED)
    UPDATE media_item m
       SET deletion_claim_id = ${claimId}::uuid,
           deletion_lease_until = now() + make_interval(secs => ${LEASE_SECONDS}::double precision),
           deletion_attempts = m.deletion_attempts + 1,
           updated_at = now()
      FROM due
     WHERE m.id = due.id
    RETURNING m.id, m.storage_key, m.deletion_attempts`;
  return rows[0] ?? null;
}

// Every result is recorded only while the row is still OUR claim; 0 rows = someone else took it over after our lease expired.
const finishDeleted = (id: string, claimId: string) => prisma.$executeRaw`
  DELETE FROM media_item WHERE id = ${id}::uuid AND deletion_claim_id = ${claimId}::uuid AND status = 'DELETING'`;

const scheduleRetry = (id: string, claimId: string, delayMs: number, code: string) => prisma.$executeRaw`
  UPDATE media_item
     SET next_deletion_at = now() + make_interval(secs => ${delayMs / 1000}::double precision), deletion_claim_id = NULL, deletion_lease_until = NULL,
         last_deletion_error = ${code}, updated_at = now()
   WHERE id = ${id}::uuid AND deletion_claim_id = ${claimId}::uuid AND status = 'DELETING'`;

/**
 * The files are gone, but the signature that created this slot may still be valid: the client could upload again and create an asset with NO row,
 * which nothing would ever clean up. Until the upload window has closed (`holdMinutes` after the slot was created) the row stays, hidden, and becomes
 * due again exactly when the window is over; the next pass sweeps the provider once more and then deletes the row. Rows older than the window are
 * not held (0 rows updated). The bookkeeping of the finished attempt is reset so the extra pass starts clean.
 */
const holdUntilWindowCloses = (id: string, claimId: string, holdMinutes: number) => prisma.$executeRaw`
  UPDATE media_item
     SET next_deletion_at = created_at + make_interval(mins => ${holdMinutes}::int), deletion_claim_id = NULL, deletion_lease_until = NULL,
         deletion_attempts = 0, last_deletion_error = NULL, updated_at = now()
   WHERE id = ${id}::uuid AND deletion_claim_id = ${claimId}::uuid AND status = 'DELETING'
     AND created_at + make_interval(mins => ${holdMinutes}::int) > now()`;

async function processRow(row: Claimed, claimId: string, destroy: DestroyFn, holdMinutes: number, result: MediaRunResult): Promise<void> {
  const log = { mediaId: row.id, attempt: row.deletion_attempts };
  try {
    // All three namespaces, one after the other. A failure on any of them leaves the row for a retry; the ones already done answer "not found" next time.
    for (const type of ALL_RESOURCE_TYPES) await destroy(row.storage_key, type);
  } catch (err) {
    const e = err instanceof StorageError ? err : new StorageError((err as Error).message, 'TRANSIENT', 'UNEXPECTED');
    const delay = e.kind === 'AUTH' ? AUTH_DELAY_MS : e.kind === 'NOT_CONFIGURED' ? NOT_CONFIGURED_DELAY_MS : backoffMs(row.deletion_attempts);
    if ((await scheduleRetry(row.id, claimId, delay, e.code)) > 0) result.retried++;
    else result.lostClaim++;
    const level = row.deletion_attempts >= ERROR_LOG_FROM_ATTEMPT || e.kind === 'AUTH' || e.kind === 'NOT_CONFIGURED' ? 'error' : 'warn';
    logger[level]({ ...log, code: e.code, kind: e.kind, retryInSeconds: Math.round(delay / 1000) }, 'media deletion failed; the row stays hidden and will be retried');
    return;
  }
  if (holdMinutes > 0 && (await holdUntilWindowCloses(row.id, claimId, holdMinutes)) > 0) {
    result.held++;
    return;
  }
  if ((await finishDeleted(row.id, claimId)) > 0) result.deleted++;
  else {
    result.lostClaim++;
    logger.warn(log, 'media file deleted but the claim had expired; another worker owns the row (it will find the file gone and finish)');
  }
}

interface ClaimedStray {
  id: string;
  storage_key: string;
  kind: 'PHOTO' | 'VIDEO';
  stray_sweeps_left: number;
  stray_sweep_attempts: number;
}

/**
 * Takes ONE due sweep. The due time is pushed LEASE_SECONDS ahead as the lease (nothing else is needed: a worker that dies leaves the sweep due again
 * after that), under FOR UPDATE SKIP LOCKED so concurrent workers get different rows. Sweeps are idempotent anyway; the conditional updates below
 * only keep two workers from advancing the same step twice.
 */
async function claimStray(): Promise<ClaimedStray | null> {
  const rows = await prisma.$queryRaw<ClaimedStray[]>`
    WITH due AS (
      SELECT id FROM media_item
       WHERE status = 'READY' AND provider = 'CLOUDINARY' AND stray_sweeps_left > 0 AND stray_sweep_at <= now()
       ORDER BY stray_sweep_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED)
    UPDATE media_item m
       SET stray_sweep_at = now() + make_interval(secs => ${LEASE_SECONDS}::double precision), updated_at = now()
      FROM due
     WHERE m.id = due.id
    RETURNING m.id, m.storage_key, m.kind::text AS kind, m.stray_sweeps_left, m.stray_sweep_attempts`;
  return rows[0] ?? null;
}

/**
 * A sweep succeeded: step 3 (at confirmation) schedules step 2 (when the upload window has closed), step 2 schedules step 1 (the late insurance
 * sweep), step 1 ends the schedule. A step that is already overdue (an old item) becomes due at once. Conditional on the step, so two workers
 * cannot advance it twice.
 */
async function advanceStray(row: ClaimedStray): Promise<number> {
  if (row.stray_sweeps_left >= 3) {
    return prisma.$executeRaw`
      UPDATE media_item
         SET stray_sweeps_left = 2, stray_sweep_attempts = 0, last_stray_error = NULL, updated_at = now(),
             stray_sweep_at = GREATEST(now(), created_at + make_interval(mins => ${STRAY_WINDOW_MINUTES}::int))
       WHERE id = ${row.id}::uuid AND status = 'READY' AND stray_sweeps_left = 3`;
  }
  if (row.stray_sweeps_left === 2) {
    return prisma.$executeRaw`
      UPDATE media_item
         SET stray_sweeps_left = 1, stray_sweep_attempts = 0, last_stray_error = NULL, updated_at = now(),
             stray_sweep_at = GREATEST(now(), created_at + make_interval(hours => ${STRAY_LATE_AFTER_HOURS}::int))
       WHERE id = ${row.id}::uuid AND status = 'READY' AND stray_sweeps_left = 2`;
  }
  return prisma.$executeRaw`
    UPDATE media_item
       SET stray_sweeps_left = 0, stray_sweep_at = NULL, stray_sweep_attempts = 0, last_stray_error = NULL, updated_at = now()
     WHERE id = ${row.id}::uuid AND status = 'READY' AND stray_sweeps_left = 1`;
}

/** A sweep failed: it keeps its step and is retried later. Nothing about the READY item changes. */
const rescheduleStray = (row: ClaimedStray, delayMs: number, code: string) => prisma.$executeRaw`
  UPDATE media_item
     SET stray_sweep_at = now() + make_interval(secs => ${delayMs / 1000}::double precision), stray_sweep_attempts = stray_sweep_attempts + 1,
         last_stray_error = ${code}, updated_at = now()
   WHERE id = ${row.id}::uuid AND status = 'READY' AND stray_sweeps_left = ${row.stray_sweeps_left}::int`;

/**
 * One sweep. Returns true when the pass should STOP (the provider is rate-limiting, unreachable or refusing the credentials: more calls now would
 * only add load). The verified canonical resource type is never touched: a photo is stored as "image", a video as "video".
 */
async function sweepOne(row: ClaimedStray, destroy: DestroyFn, result: MediaRunResult): Promise<boolean> {
  const canonical = row.kind === 'PHOTO' ? 'image' : 'video';
  // the cheap upload-API delete of the other media type first, the raw listing (Admin API) last
  const others = ALL_RESOURCE_TYPES.filter((t) => t !== canonical);
  const log = { mediaId: row.id, step: row.stray_sweeps_left, attempt: row.stray_sweep_attempts + 1 };
  try {
    for (const type of others) await destroy(row.storage_key, type);
  } catch (err) {
    const e = err instanceof StorageError ? err : new StorageError((err as Error).message, 'REJECTED', 'UNEXPECTED');
    const delay = e.kind === 'AUTH' ? AUTH_DELAY_MS : e.kind === 'NOT_CONFIGURED' ? NOT_CONFIGURED_DELAY_MS : backoffMs(row.stray_sweep_attempts + 1);
    if ((await rescheduleStray(row, delay, e.code)) > 0) result.sweepRetried++;
    const level = row.stray_sweep_attempts + 1 >= ERROR_LOG_FROM_ATTEMPT || e.kind === 'AUTH' || e.kind === 'NOT_CONFIGURED' ? 'error' : 'warn';
    logger[level]({ ...log, code: e.code, kind: e.kind, retryInSeconds: Math.round(delay / 1000) }, 'media stray sweep failed; the item stays published and the sweep will be retried');
    return e.kind === 'TRANSIENT' || e.kind === 'AUTH' || e.kind === 'NOT_CONFIGURED';
  }
  if ((await advanceStray(row)) > 0) result.swept++;
  return false;
}

/**
 * One pass: expire stale uploads, delete files one row at a time (up to `maxRows`), then run due stray sweeps (up to `maxStray`).
 * Safe to call from several processes at once.
 */
export async function runMediaWorkerOnce(opts: MediaRunOptions = {}): Promise<MediaRunResult> {
  const destroy: DestroyFn = opts.destroy ?? ((key, type) => storage.destroy(key, type));
  const result: MediaRunResult = { expired: 0, deleted: 0, held: 0, retried: 0, lostClaim: 0, swept: 0, sweepRetried: 0 };
  result.expired = await expireStalePending(opts.pendingTtlMinutes ?? PENDING_TTL_MINUTES);
  for (let i = 0; i < (opts.maxRows ?? MAX_PER_RUN); i++) {
    const claimId = randomUUID();
    const row = await claimOne(claimId);
    if (!row) break;
    await processRow(row, claimId, destroy, opts.holdMinutes ?? STRAY_WINDOW_MINUTES, result);
  }
  for (let i = 0; i < (opts.maxStray ?? MAX_STRAY_PER_RUN); i++) {
    const row = await claimStray();
    if (!row) break;
    if (await sweepOne(row, destroy, result)) break; // provider trouble: stop here, the remaining sweeps stay due and are tried on the next pass
  }
  return result;
}

/** Starts polling. Returns a stop function that resolves when a pass in progress has ended. Runs in every API instance; claiming makes that safe. */
export function scheduleMediaWorker(intervalMs = POLL_MS): () => Promise<void> {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = (async () => {
      try {
        const r = await runMediaWorkerOnce();
        if (r.expired || r.deleted || r.held || r.retried || r.lostClaim || r.swept || r.sweepRetried) logger.info(r, 'media worker pass');
      } catch (err) {
        logger.error({ err }, 'media worker pass failed');
      }
    })().finally(() => {
      running = null;
    });
  };
  const first = setTimeout(tick, 3_000);
  const timer = setInterval(tick, intervalMs);
  return async () => {
    clearTimeout(first);
    clearInterval(timer);
    await running;
  };
}
