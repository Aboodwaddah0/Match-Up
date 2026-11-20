import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { ALL_RESOURCE_TYPES, storage, StorageError, type AssetPage, type ResourceType } from '../lib/cloudinary';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { backoffMs } from './media-worker';

/*
 * Media reconciliation. Walks the storage provider's OWN listing of "<folder>/media/" and deletes what should not be there.
 *
 * WHY. The upload signature does not cover the resource type, and nobody can prove that the provider never finishes processing an upload later than
 * the last per-item sweep (24 h after the slot, see media-worker.ts). Per-item sweeps end; this job does not: a stray that appears at any time is
 * found by a later scan, whatever its age.
 *
 * WHAT IS DELETED, per listed asset (id = the UUID in the key "<folder>/media/<uuid>"; a raw file is "<key>.<extension>"):
 *   - the id is not exactly that pattern, or the row belongs to another provider / has another storage key  -> FOREIGN, left alone (counted)
 *   - the PROVIDER created the asset less than the grace period ago                                           -> YOUNG, left alone
 *   - the row is READY and this is its verified canonical file (PHOTO = "image", VIDEO = "video", exact key)  -> KEPT, never deleted
 *   - the row is PENDING (an upload in flight, or one the expiry job will move to DELETING)                   -> left alone
 *   - the row is DELETING (the deletion worker owns it, and holds it until the upload window is over)          -> left alone
 *   - the row is READY and the asset is anything else (another resource type, a raw "<key>.<ext>")            -> STRAY, deleted
 *   - there is no row at all                                                                                  -> ORPHAN, deleted
 *   A row always exists BEFORE the first signature for its key is issued, so an asset with no row cannot be an upload in flight. Immediately before
 *   each delete the row is read again and the decision repeated; anything that changed is skipped (the next cycle looks again).
 *   Deleting uses the upload API's destroy by exact public id (not an Admin API call) and is idempotent ("not found" counts as deleted).
 *
 * CYCLES AND CURSORS. Image, video and raw are separate namespaces with their own row in media_reconcile (cursor, cycle start, progress, lease).
 *   - A cycle is one walk of a namespace from its first page to its last page (the listing returned no next cursor). It is COMPLETE only when
 *     the last page was processed without any failure; only then is the type idle until the next cycle (one interval after this one STARTED, or
 *     at once when the cycle took longer than that). An asset that appears behind the cursor while a cycle runs is therefore found by the next cycle.
 *   - A page is validated as a whole before anything is done with it (see storage.listAssets: one unreadable entry rejects the page) and its cursor
 *     is saved only after EVERY action on the page is finished. A failure (API, database, lost lease) leaves the saved cursor where it was, so the
 *     same page is fetched again and nothing is skipped. Deletions already done are not undone and are idempotent on the retry. If the deletion
 *     budget of a run is used up in the middle of a page the cursor stays as well: the next run fetches the page again (deleted assets are gone
 *     from it) and continues.
 *   - Verified live: the listing is ordered by public id and the cursor is a position in that order, so deleting listed assets does not shift later
 *     pages. If the provider ever rejects a saved cursor (HTTP 400 "Invalid next_cursor") the type restarts from its FIRST page; the cycle start is
 *     kept (so the reported age keeps growing) and the cycle cannot complete before the end of the listing has been reached again.
 *   - One failing asset (e.g. the provider refuses to delete it) holds its type at that page, loudly: attempts / last_error / the age of the cycle
 *     are in GET /admin/stats and from the 3rd attempt on the failure is logged at ERROR. It is never skipped silently.
 *
 * COST AND BOUNDS. Each Admin API call lists up to 500 assets of one namespace; a run fetches at most MEDIA_RECONCILE_MAX_PAGES pages (default 25,
 * all types together, round-robin so one huge namespace cannot starve the others) and deletes at most MAX_DELETIONS_PER_RUN assets. A run that
 * stops with work left pauses for CONTINUE_DELAY (30 min), so the Admin API budget used by a cycle is at most MAX_PAGES / 30 min while one is running
 * and nothing while all types are idle. The provider allows 500 Admin API calls per hour on this plan and reports how many are left: below
 * RATE_RESERVE the run stops and waits for the reset, so the confirmation lookups and the sweeps are never starved. With fewer than 500 assets per
 * namespace a cycle is 3 calls a day. A cycle of N pages in its biggest namespace takes about ceil(N / MAX_PAGES) runs, i.e. up to
 * (ceil(N / MAX_PAGES) - 1) x 30 min (+ any outage).
 *
 * WHAT IS GUARANTEED (see the README): while the provider and the database are reachable, a stray that exists for at least the grace period is
 * deleted by the first cycle that reaches it after that; a cycle starts within one interval of the previous start and takes the throughput above.
 * Nothing is guaranteed during an outage (the run stops without acting and retries with backoff; the age of the oldest unprocessed work keeps growing in the
 * stats), and a READY item's canonical file is never touched.
 */

const PAGE_SIZE = 500;
/** Deletions per run. Upload-API calls (not Admin API), but bounded all the same. */
const MAX_DELETIONS_PER_RUN = 100;
const LEASE_SECONDS = 300;
/** Pause after a run that stopped with work left (page or deletion budget used up). */
const CONTINUE_DELAY_SECONDS = 1800;
/** Stop listing when the provider says fewer than this many Admin API calls are left in its window. */
const RATE_RESERVE = 100;
/** Pause after an unexpected (database) failure in the middle of a run. */
const DB_ERROR_DELAY_SECONDS = 60;
const AUTH_DELAY_SECONDS = 1800;
const NOT_CONFIGURED_DELAY_SECONDS = 3600;
const ERROR_LOG_FROM_ATTEMPT = 3;
const POLL_MS = 60_000;

const PREFIX = `${env.CLOUDINARY_FOLDER}/media/`;
// "<folder>/media/<uuid>" plus, for the raw namespace only, the extension the client's file had. UUIDs are lower case (the row id is generated by the database).
const KEY_RE = new RegExp(`^${env.CLOUDINARY_FOLDER}/media/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\\.[A-Za-z0-9._-]{1,64})?$`);

export interface ReconcileOptions {
  /** Admin API pages per run (default MEDIA_RECONCILE_MAX_PAGES). */
  maxPages?: number;
  maxDeletions?: number;
  graceHours?: number;
  intervalHours?: number;
  /** Assets per page (default 500, the provider's maximum). Tests use small pages. */
  pageSize?: number;
}

export interface ReconcileResult {
  /** Listing pages fetched and validated. */
  pages: number;
  /** Assets that were on pages processed completely. */
  listed: number;
  deleted: number;
  /** Canonical files of READY items (never deleted). */
  kept: number;
  /** Younger than the grace period. */
  young: number;
  /** Not our pattern, or not our row. */
  foreign: number;
  /** PENDING or DELETING rows, left to their owners. */
  left: number;
  cyclesCompleted: ResourceType[];
  failed: Array<{ type: ResourceType; code: string }>;
  /** Types whose lease was lost to another runner mid-run (nothing more was done for them). */
  lostLease: ResourceType[];
}

interface MediaRow {
  id: string;
  kind: 'PHOTO' | 'VIDEO';
  status: 'PENDING' | 'READY' | 'DELETING';
  provider: string;
  storage_key: string;
}

type Verdict = 'keep' | 'young' | 'foreign' | 'left' | 'delete';

/** The decision for ONE listed asset. Pure: the caller supplies the row (or undefined when there is none). */
function judge(publicId: string, type: ResourceType, createdAt: Date, row: MediaRow | undefined, nowMs: number, graceMs: number): { verdict: Verdict; id: string | null } {
  const m = KEY_RE.exec(publicId);
  if (!m || (m[2] && type !== 'raw')) return { verdict: 'foreign', id: null };
  const id = m[1]!;
  if (nowMs - createdAt.getTime() < graceMs) return { verdict: 'young', id };
  if (!row) return { verdict: 'delete', id }; // orphan: a row always exists before a signature for its key does
  // ambiguous information is never a reason to delete
  if (row.provider !== 'CLOUDINARY' || row.storage_key !== `${PREFIX}${id}`) return { verdict: 'foreign', id };
  if (row.status !== 'READY') return { verdict: 'left', id };
  const canonical = row.kind === 'PHOTO' ? 'image' : 'video';
  return { verdict: type === canonical && !m[2] ? 'keep' : 'delete', id };
}

async function rowsFor(ids: string[]): Promise<Map<string, MediaRow>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<MediaRow[]>`
    SELECT id::text AS id, kind::text AS kind, status::text AS status, provider::text AS provider, storage_key
      FROM media_item WHERE id = ANY(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r]));
}

interface Ctx {
  type: ResourceType;
  claimId: string;
  /** The cursor that fetches the next page (null: the first page). */
  cursor: string | null;
  attempts: number;
  state: 'active' | 'complete' | 'paused' | 'failed' | 'lost';
}

interface Run {
  fetches: number;
  deletionsLeft: number;
  /** An error ended the run (or the provider's rate budget is low): no further listing or deleting. */
  stop: boolean;
  /** How long the types that were still active wait when the run was stopped (0 = they may run again at once). */
  pauseSeconds: number;
}

const ensureRows = () => prisma.$executeRaw`
  INSERT INTO media_reconcile (resource_type, updated_at) VALUES ('image', now()), ('video', now()), ('raw', now()) ON CONFLICT (resource_type) DO NOTHING`;

/** Takes ONE type if it is due and not leased. An idle type starts a new cycle here. */
async function claim(type: ResourceType, claimId: string): Promise<{ cursor: string | null; attempts: number } | null> {
  const rows = await prisma.$queryRaw<Array<{ cursor: string | null; attempts: number }>>`
    UPDATE media_reconcile
       SET claim_id = ${claimId}::uuid, lease_until = now() + make_interval(secs => ${LEASE_SECONDS}::double precision),
           cycle_started_at = COALESCE(cycle_started_at, now()), updated_at = now()
     WHERE resource_type = ${type} AND next_run_at <= now() AND (lease_until IS NULL OR lease_until <= now())
    RETURNING cursor, attempts`;
  return rows[0] ?? null;
}

/** Extends our lease; false = another runner took the type over (its writes are conditional on its own claim id, ours would be refused). */
async function renew(c: Ctx): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE media_reconcile SET lease_until = now() + make_interval(secs => ${LEASE_SECONDS}::double precision), updated_at = now()
     WHERE resource_type = ${c.type} AND claim_id = ${c.claimId}::uuid`;
  return n > 0;
}

const saveAdvance = (c: Ctx, next: string, scanned: number, deleted: number) => prisma.$executeRaw`
  UPDATE media_reconcile
     SET cursor = ${next}, cycle_pages = cycle_pages + 1, cycle_scanned = cycle_scanned + ${scanned}::int, cycle_deleted = cycle_deleted + ${deleted}::int,
         attempts = 0, last_error = NULL, updated_at = now()
   WHERE resource_type = ${c.type} AND claim_id = ${c.claimId}::uuid`;

const saveComplete = (c: Ctx, intervalHours: number) => prisma.$executeRaw`
  UPDATE media_reconcile
     SET cursor = NULL, cycle_started_at = NULL, cycle_pages = 0, cycle_scanned = 0, cycle_deleted = 0,
         last_cycle_completed_at = now(), next_run_at = GREATEST(now(), cycle_started_at + make_interval(hours => ${intervalHours}::int)),
         attempts = 0, last_error = NULL, claim_id = NULL, lease_until = NULL, updated_at = now()
   WHERE resource_type = ${c.type} AND claim_id = ${c.claimId}::uuid`;

/** Gives the type back without progress or failure: due again after `delaySeconds`. */
const release = (c: Ctx, delaySeconds: number, deleted = 0) => prisma.$executeRaw`
  UPDATE media_reconcile
     SET cycle_deleted = cycle_deleted + ${deleted}::int, claim_id = NULL, lease_until = NULL,
         next_run_at = now() + make_interval(secs => ${delaySeconds}::double precision), updated_at = now()
   WHERE resource_type = ${c.type} AND claim_id = ${c.claimId}::uuid`;

const saveFailure = (c: Ctx, code: string, delaySeconds: number, deleted: number) => prisma.$executeRaw`
  UPDATE media_reconcile
     SET attempts = attempts + 1, last_error = ${code}, cycle_deleted = cycle_deleted + ${deleted}::int, claim_id = NULL, lease_until = NULL,
         next_run_at = now() + make_interval(secs => ${delaySeconds}::double precision), updated_at = now()
   WHERE resource_type = ${c.type} AND claim_id = ${c.claimId}::uuid`;

/** The provider no longer accepts the saved cursor: start the walk again from the first page. The cycle start is kept. */
const saveRestart = (c: Ctx) => prisma.$executeRaw`
  UPDATE media_reconcile
     SET cursor = NULL, cycle_pages = 0, cycle_scanned = 0, cycle_deleted = 0, attempts = attempts + 1, last_error = 'INVALID_CURSOR',
         claim_id = NULL, lease_until = NULL, next_run_at = now(), updated_at = now()
   WHERE resource_type = ${c.type} AND claim_id = ${c.claimId}::uuid`;

/** A provider failure. Anything that is not a StorageError from the provider call is a bug and is treated like an unreadable answer. */
async function onProviderError(c: Ctx, err: unknown, run: Run, result: ReconcileResult, deleted: number, hadCursor: boolean): Promise<void> {
  const e = err instanceof StorageError ? err : new StorageError((err as Error).message, 'REJECTED', 'UNEXPECTED');
  run.stop = true; // nothing more is listed or deleted in this run
  c.state = 'failed';
  if (e.code === 'INVALID_CURSOR' && hadCursor) {
    await saveRestart(c);
    logger.warn({ type: c.type }, 'media reconcile: the saved cursor was refused; the walk restarts from the first page');
    return;
  }
  const attempt = c.attempts + 1;
  const delay = e.kind === 'AUTH' ? AUTH_DELAY_SECONDS : e.kind === 'NOT_CONFIGURED' ? NOT_CONFIGURED_DELAY_SECONDS : Math.round(backoffMs(attempt) / 1000);
  await saveFailure(c, e.code, delay, deleted);
  result.failed.push({ type: c.type, code: e.code });
  // a provider-wide trouble also holds back the other types for as long
  if (e.kind === 'TRANSIENT' || e.kind === 'AUTH' || e.kind === 'NOT_CONFIGURED') run.pauseSeconds = delay;
  const level = attempt >= ERROR_LOG_FROM_ATTEMPT || e.kind === 'AUTH' || e.kind === 'NOT_CONFIGURED' ? 'error' : 'warn';
  logger[level]({ type: c.type, code: e.code, kind: e.kind, attempt, retryInSeconds: delay }, 'media reconcile failed; the cursor did not move and the page will be tried again');
}

/** Fetches, validates and acts on ONE page of one type. Moves the saved cursor only when everything on the page is done. */
async function processPage(c: Ctx, run: Run, result: ReconcileResult, o: Required<ReconcileOptions>): Promise<void> {
  if (!(await renew(c))) {
    c.state = 'lost';
    result.lostLease.push(c.type);
    return;
  }
  run.fetches++;
  let page: AssetPage;
  try {
    page = await storage.listAssets(c.type, { prefix: PREFIX, cursor: c.cursor, maxResults: o.pageSize });
  } catch (err) {
    await onProviderError(c, err, run, result, 0, c.cursor !== null);
    return;
  }
  result.pages++;
  if (page.rateRemaining !== null && page.rateRemaining < RATE_RESERVE) {
    // keep the rest of the provider's Admin API budget for confirmations and sweeps; this page is processed, then the run ends
    run.stop = true;
    run.pauseSeconds = Math.max(CONTINUE_DELAY_SECONDS, page.rateResetAt ? Math.ceil((page.rateResetAt.getTime() - Date.now()) / 1000) : 0);
    logger.warn({ remaining: page.rateRemaining }, 'media reconcile: the provider Admin API budget is low; pausing');
  }

  const nowMs = Date.now();
  const graceMs = o.graceHours * 3_600_000;
  const parsed = page.assets.map((a) => ({ a, m: KEY_RE.exec(a.publicId) }));
  const rows = await rowsFor(parsed.flatMap((p) => (p.m ? [p.m[1]!] : [])));
  const tally = { kept: 0, young: 0, foreign: 0, left: 0 };
  const toDelete: Array<{ publicId: string; id: string }> = [];
  for (const { a, m } of parsed) {
    const j = judge(a.publicId, c.type, a.createdAt, m ? rows.get(m[1]!) : undefined, nowMs, graceMs);
    if (j.verdict === 'delete') toDelete.push({ publicId: a.publicId, id: j.id! });
    else tally[j.verdict === 'keep' ? 'kept' : j.verdict]++;
  }

  let done = 0;
  for (const d of toDelete) {
    if (run.deletionsLeft <= 0) {
      // the budget of this run is used up in the middle of the page: the cursor stays, the page is fetched again next time
      await release(c, CONTINUE_DELAY_SECONDS, done);
      c.state = 'paused';
      return;
    }
    if (!(await renew(c))) {
      c.state = 'lost';
      result.lostLease.push(c.type);
      return;
    }
    // decided again at the last moment, from a fresh read of the row
    const asset = page.assets.find((x) => x.publicId === d.publicId)!;
    const fresh = (await rowsFor([d.id])).get(d.id);
    if (judge(d.publicId, c.type, asset.createdAt, fresh, Date.now(), graceMs).verdict !== 'delete') continue;
    try {
      await storage.destroyAsset(d.publicId, c.type);
    } catch (err) {
      await onProviderError(c, err, run, result, done, false);
      return;
    }
    run.deletionsLeft--;
    done++;
    result.deleted++;
  }

  // every action on the page is finished: now, and only now, the cursor moves
  const moved = page.nextCursor
    ? await saveAdvance(c, page.nextCursor, page.assets.length, done)
    : await saveComplete(c, o.intervalHours);
  if (moved === 0) {
    c.state = 'lost';
    result.lostLease.push(c.type);
    return;
  }
  result.listed += page.assets.length;
  result.kept += tally.kept;
  result.young += tally.young;
  result.foreign += tally.foreign;
  result.left += tally.left;
  if (page.nextCursor) c.cursor = page.nextCursor;
  else {
    c.state = 'complete';
    result.cyclesCompleted.push(c.type);
  }
}

/**
 * One run: claims every due type, then fetches pages round-robin until the page budget is used up, an error stops the run, or every type is done
 * for now. Safe to call from several processes at once (claims under a lease).
 */
export async function runMediaReconcileOnce(opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const result: ReconcileResult = { pages: 0, listed: 0, deleted: 0, kept: 0, young: 0, foreign: 0, left: 0, cyclesCompleted: [], failed: [], lostLease: [] };
  if (!storage.configured()) return result;
  const o: Required<ReconcileOptions> = {
    maxPages: opts.maxPages ?? env.MEDIA_RECONCILE_MAX_PAGES,
    maxDeletions: opts.maxDeletions ?? MAX_DELETIONS_PER_RUN,
    graceHours: opts.graceHours ?? env.MEDIA_RECONCILE_GRACE_HOURS,
    intervalHours: opts.intervalHours ?? env.MEDIA_RECONCILE_INTERVAL_HOURS,
    pageSize: opts.pageSize ?? PAGE_SIZE,
  };
  await ensureRows();
  const ctxs: Ctx[] = [];
  for (const type of ALL_RESOURCE_TYPES) {
    const claimId = randomUUID();
    const row = await claim(type, claimId);
    if (row) ctxs.push({ type, claimId, cursor: row.cursor, attempts: row.attempts, state: 'active' });
  }
  const run: Run = { fetches: 0, deletionsLeft: o.maxDeletions, stop: false, pauseSeconds: 0 };
  try {
    while (!run.stop && run.fetches < o.maxPages) {
      const active = ctxs.filter((c) => c.state === 'active');
      if (active.length === 0) break;
      for (const c of active) {
        if (run.stop || run.fetches >= o.maxPages) break;
        await processPage(c, run, result, o);
      }
    }
  } catch (err) {
    // an unexpected failure (typically the database): nothing was saved for the page in flight, so its cursor did not move; try again soon
    run.stop = true;
    run.pauseSeconds = DB_ERROR_DELAY_SECONDS;
    throw err;
  } finally {
    // whatever is still ours goes back: with the page budget used up it waits CONTINUE_DELAY, after a stop for as long as the stop asks
    const delay = run.stop ? run.pauseSeconds : CONTINUE_DELAY_SECONDS;
    for (const c of ctxs) {
      if (c.state !== 'active') continue;
      await release(c, delay).catch((err) => logger.error({ err, type: c.type }, 'media reconcile: could not release a type; its lease will expire'));
    }
  }
  if (result.pages || result.failed.length || result.lostLease.length) logger.info(result, 'media reconcile run');
  return result;
}

/** Starts the scheduler: a cheap poll (one UPDATE per type) that does real work only when a type is due. Runs in every API instance; claims make that safe. */
export function scheduleMediaReconcile(intervalMs = POLL_MS): () => Promise<void> {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = (async () => {
      try {
        await runMediaReconcileOnce();
      } catch (err) {
        logger.error({ err }, 'media reconcile run failed');
      }
    })().finally(() => {
      running = null;
    });
  };
  const first = setTimeout(tick, 20_000);
  const timer = setInterval(tick, intervalMs);
  return async () => {
    clearTimeout(first);
    clearInterval(timer);
    await running;
  };
}

export interface ReconcileTypeStatus {
  type: ResourceType;
  /** A cycle is in progress. */
  running: boolean;
  /** Age of the running cycle = the age of the oldest work not yet processed. */
  cycleAgeSeconds: number | null;
  /** How long a cycle that should have started is overdue (idle types only). */
  overdueSeconds: number | null;
  pages: number;
  scanned: number;
  deleted: number;
  /** Consecutive failed runs of the current cycle. */
  attempts: number;
  lastError: string | null;
  lastCompletedAt: string | null;
  nextRunAt: string | null;
}

/** Monitoring view for GET /admin/stats: how old is the oldest unprocessed work, and is any type stuck. */
export async function reconcileStatus() {
  const rows = await prisma.mediaReconcile.findMany();
  const now = Date.now();
  const types: ReconcileTypeStatus[] = ALL_RESOURCE_TYPES.map((type) => {
    const r = rows.find((x) => x.resourceType === type);
    return {
      type,
      running: Boolean(r?.cycleStartedAt),
      cycleAgeSeconds: r?.cycleStartedAt ? Math.max(0, Math.floor((now - r.cycleStartedAt.getTime()) / 1000)) : null,
      overdueSeconds: r && !r.cycleStartedAt && r.nextRunAt.getTime() < now ? Math.floor((now - r.nextRunAt.getTime()) / 1000) : null,
      pages: r?.cyclePages ?? 0,
      scanned: r?.cycleScanned ?? 0,
      deleted: r?.cycleDeleted ?? 0,
      attempts: r?.attempts ?? 0,
      lastError: r?.lastError ?? null,
      lastCompletedAt: r?.lastCycleCompletedAt?.toISOString() ?? null,
      nextRunAt: r?.nextRunAt.toISOString() ?? null,
    };
  });
  return {
    enabled: env.MEDIA_RECONCILE_ENABLED,
    oldestUnprocessedSeconds: Math.max(0, ...types.map((t) => t.cycleAgeSeconds ?? t.overdueSeconds ?? 0)),
    stuck: types.filter((t) => t.attempts >= ERROR_LOG_FROM_ATTEMPT).map((t) => t.type),
    types,
  };
}
