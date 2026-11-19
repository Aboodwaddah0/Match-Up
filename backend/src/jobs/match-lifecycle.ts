import type { Prisma } from '@prisma/client';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { notify } from '../modules/notifications/notify';

/*
 * Time-driven transitions (D5, D16, D1). Designed to be restart-safe and multi-instance-safe:
 *  - no in-memory timers carry state: every run re-derives "what is due" from the database clock;
 *  - each row is claimed atomically (FOR UPDATE SKIP LOCKED), so two instances never double-process it;
 *  - the DB state machine re-validates every transition, and the handlers enforce the same rules lazily
 *    (see startMatchIfDue), so correctness never depends on this job having run on time.
 *
 * Failure isolation (audit JOB-01):
 *  - every row is handled in its OWN small transaction: one failing row is logged and skipped, it never blocks the others;
 *  - a row that failed is quarantined for a while, so a permanently bad row cannot occupy the batch every minute;
 *  - work is taken in bounded batches (BATCH_SIZE rows, at most MAX_BATCHES per run), so a backlog never becomes one huge
 *    transaction holding thousands of row locks;
 *  - every job of a run is isolated from the others: a job that throws is reported and the rest still run.
 */

/** Rows fetched per batch. */
export const BATCH_SIZE = 200;
/** Batches a single job may drain in one run (a larger backlog continues on the next run). */
export const MAX_BATCHES = 10;
const QUARANTINE_MS = 10 * 60_000;

export interface SweepOptions {
  batchSize?: number;
  maxBatches?: number;
}

type Tx = Prisma.TransactionClient;

/** Ids whose processing failed recently, per job: skipped until the cool-down passes. */
const quarantine = new Map<string, number>();
const quarantineKey = (job: string, id: string) => `${job}:${id}`;
function quarantinedIds(job: string): string[] {
  const now = Date.now();
  const ids: string[] = [];
  for (const [key, until] of quarantine) {
    if (until <= now) quarantine.delete(key);
    else if (key.startsWith(job + ':')) ids.push(key.slice(job.length + 1));
  }
  return ids;
}

/** Failed rows since the last reset; reported with each run so monitoring can alert on it. */
let rowFailures = 0;

/**
 * Handles each id in its own transaction. A failure is logged (with the job and the id), counted, and the id is quarantined;
 * the remaining ids are still processed. Returns how many ids `handle` reported as done.
 */
async function perRow(job: string, ids: string[], handle: (tx: Tx, id: string) => Promise<boolean>): Promise<number> {
  let done = 0;
  for (const id of ids) {
    try {
      if (await prisma.$transaction((tx) => handle(tx, id))) done++;
    } catch (err) {
      rowFailures++;
      quarantine.set(quarantineKey(job, id), Date.now() + QUARANTINE_MS);
      logger.error({ err, job, id }, 'sweeper: row failed and was skipped');
    }
  }
  return done;
}

/** Fetches a batch of due ids, handles them, and repeats while the batches come back full (up to maxBatches). */
async function drain(job: string, opts: SweepOptions, fetchIds: (limit: number, skip: string[]) => Promise<string[]>, handle: (tx: Tx, id: string) => Promise<boolean>): Promise<number> {
  const limit = opts.batchSize ?? BATCH_SIZE;
  const batches = opts.maxBatches ?? MAX_BATCHES;
  let total = 0;
  for (let i = 0; i < batches; i++) {
    const ids = await fetchIds(limit, quarantinedIds(job));
    if (ids.length === 0) break;
    total += await perRow(job, ids, handle);
    if (ids.length < limit) break;
  }
  return total;
}

const NO_UUID: string[] = [];
const skipList = (skip: string[]) => (skip.length > 0 ? skip : NO_UUID);

/** OPEN / FULL / SCHEDULED -> IN_PROGRESS once start_at has passed. (DB trigger expires pending requests.) */
export async function startDueMatches(opts: SweepOptions = {}): Promise<number> {
  return drain(
    'startDueMatches',
    opts,
    async (limit, skip) =>
      (
        await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "match"
           WHERE status IN ('OPEN', 'FULL', 'SCHEDULED') AND start_at <= now() AND id <> ALL(${skipList(skip)}::uuid[])
           ORDER BY start_at LIMIT ${limit}`
      ).map((r) => r.id),
    async (tx, id) => {
      // Re-check and claim under a row lock; SKIP LOCKED leaves rows another instance (or a request) is handling.
      const moved = await tx.$queryRaw<{ from_status: string }[]>`
        WITH due AS (
          SELECT id, status FROM "match"
           WHERE id = ${id}::uuid AND status IN ('OPEN', 'FULL', 'SCHEDULED') AND start_at <= now()
           FOR UPDATE SKIP LOCKED)
        UPDATE "match" m SET status = 'IN_PROGRESS' FROM due WHERE m.id = due.id
        RETURNING due.status::text AS from_status`;
      if (moved.length === 0) return false;
      await tx.matchEvent.create({ data: { matchId: id, fromStatus: moved[0]!.from_status as never, toStatus: 'IN_PROGRESS', reason: 'auto: start time reached' } });
      return true;
    },
  );
}

/** IN_PROGRESS and still unconfirmed 48h after the scheduled end -> CLOSED_UNCONFIRMED; tell the organizer. */
export async function closeUnconfirmedMatches(opts: SweepOptions = {}): Promise<number> {
  return drain(
    'closeUnconfirmedMatches',
    opts,
    async (limit, skip) =>
      (
        await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "match"
           WHERE status = 'IN_PROGRESS' AND end_at + fym_unconfirmed_grace() <= now() AND id <> ALL(${skipList(skip)}::uuid[])
           ORDER BY end_at LIMIT ${limit}`
      ).map((r) => r.id),
    async (tx, id) => {
      const closed = await tx.$queryRaw<{ organizer_id: string; title: string }[]>`
        WITH due AS (
          SELECT id FROM "match"
           WHERE id = ${id}::uuid AND status = 'IN_PROGRESS' AND end_at + fym_unconfirmed_grace() <= now()
           FOR UPDATE SKIP LOCKED)
        UPDATE "match" m SET status = 'CLOSED_UNCONFIRMED' FROM due WHERE m.id = due.id
        RETURNING m.organizer_id, m.title`;
      if (closed.length === 0) return false;
      await tx.matchEvent.create({ data: { matchId: id, fromStatus: 'IN_PROGRESS', toStatus: 'CLOSED_UNCONFIRMED', reason: 'auto: not confirmed within 48h' } });
      await notify(tx, [closed[0]!.organizer_id], 'MATCH_CLOSED_UNCONFIRMED', { matchId: id, title: closed[0]!.title }, { type: 'match', id });
      return true;
    },
  );
}

/** PENDING booking requests nobody answered within the 2h hold -> EXPIRED (slot released). The DB also expires stale holds lazily, so this is a tidy-up, not a correctness requirement. */
export async function expireStaleBookings(opts: SweepOptions = {}): Promise<number> {
  return drain(
    'expireStaleBookings',
    opts,
    async (limit, skip) =>
      (
        await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM booking
           WHERE status = 'PENDING' AND hold_expires_at <= now() AND id <> ALL(${skipList(skip)}::uuid[])
           ORDER BY hold_expires_at LIMIT ${limit}`
      ).map((r) => r.id),
    async (tx, id) => {
      const rows = await tx.$queryRaw<{ created_by_id: string; start_at: Date }[]>`
        WITH due AS (SELECT id FROM booking WHERE id = ${id}::uuid AND status = 'PENDING' AND hold_expires_at <= now() FOR UPDATE SKIP LOCKED)
        UPDATE booking b SET status = 'EXPIRED' FROM due WHERE b.id = due.id
        RETURNING b.created_by_id, b.start_at`;
      if (rows.length === 0) return false;
      await tx.bookingEvent.create({ data: { bookingId: id, fromStatus: 'PENDING', toStatus: 'EXPIRED', reason: 'auto: not answered within the hold' } });
      await notify(tx, [rows[0]!.created_by_id], 'BOOKING_EXPIRED', { bookingId: id, startAt: rows[0]!.start_at.toISOString() }, { type: 'booking', id });
      return true;
    },
  );
}

/** CONFIRMED bookings whose time has passed -> COMPLETED. (No side effects, so a bounded batch per statement is enough.) */
export async function completeFinishedBookings(opts: SweepOptions = {}): Promise<number> {
  const limit = opts.batchSize ?? BATCH_SIZE;
  let total = 0;
  for (let i = 0; i < (opts.maxBatches ?? MAX_BATCHES); i++) {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      WITH due AS (SELECT id FROM booking WHERE status = 'CONFIRMED' AND end_at <= now() ORDER BY end_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      UPDATE booking b SET status = 'COMPLETED' FROM due WHERE b.id = due.id RETURNING b.id`;
    total += rows.length;
    if (rows.length < limit) break;
  }
  return total;
}

/** Unanswered team challenges and team invitations past their deadline -> EXPIRED. Handlers also check lazily, so this is a tidy-up. */
export async function expireStaleTeamOffers(opts: SweepOptions = {}): Promise<number> {
  const challenges = await drain(
    'expireStaleTeamOffers',
    opts,
    async (limit, skip) =>
      (
        await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM team_challenge
           WHERE status = 'PENDING' AND expires_at <= now() AND id <> ALL(${skipList(skip)}::uuid[])
           ORDER BY expires_at LIMIT ${limit}`
      ).map((r) => r.id),
    async (tx, id) => {
      const rows = await tx.$queryRaw<{ challenger_team_id: string }[]>`
        WITH due AS (SELECT id FROM team_challenge WHERE id = ${id}::uuid AND status = 'PENDING' AND expires_at <= now() FOR UPDATE SKIP LOCKED)
        UPDATE team_challenge c SET status = 'EXPIRED' FROM due WHERE c.id = due.id RETURNING c.challenger_team_id`;
      if (rows.length === 0) return false;
      const staff = await tx.teamMember.findMany({ where: { teamId: rows[0]!.challenger_team_id, role: { in: ['CAPTAIN', 'VICE_CAPTAIN'] } }, select: { userId: true } });
      await notify(tx, staff.map((s) => s.userId), 'CHALLENGE_CANCELLED', { challengeId: id, expired: true }, { type: 'challenge', id });
      return true;
    },
  );
  const invites = await prisma.$executeRaw`
    UPDATE team_invitation SET status = 'EXPIRED'
     WHERE id IN (SELECT id FROM team_invitation WHERE status = 'PENDING' AND expires_at <= now() LIMIT ${opts.batchSize ?? BATCH_SIZE})`;
  return challenges + invites;
}

/**
 * PRIV-01: notifications that were inserted for a DELETED account AFTER its deletion transaction had erased the existing ones (a notifier that
 * read the recipient as ACTIVE just before the commit). One user per transaction, at most `batchSize` notifications each, their push deliveries
 * first (push_delivery.notification_id is RESTRICT). Rows are taken FOR UPDATE SKIP LOCKED, so a push fan-out working on them is never waited
 * for, and no user row is locked: the notification creation path is untouched. Idempotent (nothing left = nothing done); a larger backlog
 * continues on the next run. It removes nothing but these notification rows and their deliveries. Returns the number of notifications removed.
 */
export async function purgeDeletedUserNotifications(opts: SweepOptions = {}): Promise<number> {
  const limit = opts.batchSize ?? BATCH_SIZE;
  let purged = 0;
  await drain(
    'purgeDeletedUserNotifications',
    opts,
    async (max, skip) =>
      (
        await prisma.$queryRaw<{ id: string }[]>`
          SELECT u.id FROM "user" u
           WHERE u.status = 'DELETED' AND EXISTS (SELECT 1 FROM notification n WHERE n.user_id = u.id) AND u.id <> ALL(${skipList(skip)}::uuid[])
           ORDER BY u.id LIMIT ${max}`
      ).map((r) => r.id),
    async (tx, userId) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM notification WHERE user_id = ${userId}::uuid ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return false;
      const ids = rows.map((r) => r.id);
      await tx.pushDelivery.deleteMany({ where: { notificationId: { in: ids } } });
      purged += (await tx.notification.deleteMany({ where: { id: { in: ids } } })).count;
      return true;
    },
  );
  return purged;
}

export interface LifecycleResult {
  started: number;
  closed: number;
  expired: number;
  completed: number;
  offers: number;
  /** Notifications of deleted accounts removed (PRIV-01). */
  purged: number;
  /** Names of jobs that threw (the others still ran). */
  failedJobs: string[];
  /** Rows that failed and were skipped (quarantined) during this run. */
  failedRows: number;
}

/** Runs the given jobs one after another; a job that throws is reported in `failed` and does NOT stop the rest. */
export async function runIsolated<K extends string>(jobs: Record<K, () => Promise<number>>): Promise<{ counts: Record<K, number>; failed: K[] }> {
  const counts = {} as Record<K, number>;
  const failed: K[] = [];
  for (const name of Object.keys(jobs) as K[]) {
    try {
      counts[name] = await jobs[name]();
    } catch (err) {
      counts[name] = 0;
      failed.push(name);
      logger.error({ err, job: name }, 'sweeper job failed; the other jobs still run');
    }
  }
  return { counts, failed };
}

/** Runs every sweeper once, in order, each isolated from the others; each is idempotent, so running them twice or on two instances is safe. */
export async function runLifecycleJobs(): Promise<LifecycleResult> {
  rowFailures = 0;
  const { counts, failed } = await runIsolated({
    started: () => startDueMatches(),
    closed: () => closeUnconfirmedMatches(),
    expired: () => expireStaleBookings(),
    completed: () => completeFinishedBookings(),
    offers: () => expireStaleTeamOffers(),
    purged: () => purgeDeletedUserNotifications(),
  });
  return { ...counts, failedJobs: failed, failedRows: rowFailures };
}

/**
 * Runs the sweepers every minute without overlapping runs. Returns an async `stop` function: it cancels the schedule and
 * resolves when the run in progress (if any) has finished, so shutdown can wait for in-flight work.
 */
export function scheduleLifecycleJobs(intervalMs = 60_000): () => Promise<void> {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return; // never overlap with a slow previous run
    running = (async () => {
      try {
        const r = await runLifecycleJobs();
        if (r.started || r.closed || r.expired || r.completed || r.offers || r.purged || r.failedJobs.length > 0 || r.failedRows > 0) logger.info(r, 'match lifecycle job');
      } catch (err) {
        logger.error({ err }, 'match lifecycle job failed');
      }
    })().finally(() => {
      running = null;
    });
  };
  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, intervalMs);
  return async () => {
    clearTimeout(first);
    clearInterval(timer);
    await running;
  };
}
