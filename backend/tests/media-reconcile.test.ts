import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { asIfTimePassed, fakeStorage, MEDIA, photoAsset, prismaP, requestSlot, uploadMedia, videoAsset, warmPool, worker, type FakeStorage } from './helpers/media';
import { makeUser, type TestUser } from './helpers/users';

/*
 * The daily reconciliation of the media folder at the provider (src/jobs/media-reconcile.ts).
 *
 * Decisions per listed asset: a READY item's verified canonical file is NEVER deleted; PENDING and DELETING rows are left to their owners; strays of
 * READY items and files with no row are deleted, but only when the PROVIDER created them at least the grace period ago; ids outside the exact
 * "<folder>/media/<uuid>" pattern are ignored.
 * Cursors and cycles: image / video / raw are walked independently; a page's cursor is saved only after everything on the page is done; a cycle
 * completes only when the last page was processed without a failure; assets that appear behind the cursor are found by the NEXT cycle.
 * The fake provider (tests/helpers/media.ts) lists in public-id order with a position cursor, exactly as the live service does (checked live).
 */

let api: Awaited<ReturnType<typeof startApp>>;
let fake: FakeStorage;
let ann: TestUser;
let admin: TestUser;

const HOUR = 3_600_000;
const OLD = 48 * HOUR;
const prisma = async () => prismaP();
const raw = async (sql: string, ...p: unknown[]) => (await prisma()).$executeRawUnsafe(sql, ...p);
const row = async (id: string) => (await prisma()).mediaItem.findUniqueOrThrow({ where: { id } });
const rec = async (opts: Record<string, unknown> = {}) => (await import('../src/jobs/media-reconcile')).runMediaReconcileOnce(opts);
const status = async () => (await import('../src/jobs/media-reconcile')).reconcileStatus();
const st = async (type = 'image') => (await prisma()).mediaReconcile.findUniqueOrThrow({ where: { resourceType: type } });
let parked: string[] = [];
/** Everything is due again (the schedule is time-based; the tests do not wait). Parked types stay parked; a held lease is left alone. */
const dueAll = () => raw(`UPDATE media_reconcile SET next_run_at = now() - interval '1 second' WHERE resource_type <> ALL($1::text[])`, parked);
/** Keeps the given types out of the run (due a day from now), so a test can look at ONE namespace. */
const park = async (...types: string[]) => {
  parked.push(...types);
  for (const t of types) {
    await raw(
      `INSERT INTO media_reconcile (resource_type, updated_at, next_run_at) VALUES ($1, now(), now() + interval '1 day')
       ON CONFLICT (resource_type) DO UPDATE SET next_run_at = now() + interval '1 day'`,
      t,
    );
  }
};
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const keyOfN = (n: number) => `fym/media/${uid(n)}`;
type Ns = 'image' | 'video' | 'raw';
/** A file at the provider with no row (an upload nobody confirmed, or one that arrived late). Raw files carry the client's extension. */
function orphan(n: number, type: Ns = 'image', ageMs = OLD) {
  const key = type === 'raw' ? `${keyOfN(n)}.png` : keyOfN(n);
  fake.put(key, type, type === 'video' ? videoAsset(key) : photoAsset(key, { resourceType: type }), ageMs);
  return key;
}
const has = (type: Ns, key: string) => fake.objects.has(`${type}:${key}`);
const ids = (type: Ns) => [...fake.objects.keys()].filter((k) => k.startsWith(`${type}:`)).sort();
const transient = (code = 'HTTP_503') => new fake.StorageError('provider unavailable', 'TRANSIENT', code);
const rejected = (code: string) => new fake.StorageError('bad answer', 'REJECTED', code);
/** An item that is READY, whose canonical file the provider created long ago. */
async function ready(kind: 'PHOTO' | 'VIDEO' = 'PHOTO', ageMs = OLD) {
  const up = await uploadMedia(api, fake, ann, { kind });
  expect(up.res.status).toBe(200);
  fake.age(up.key, kind === 'PHOTO' ? 'image' : 'video', ageMs);
  return up;
}

beforeAll(async () => {
  api = await startApp();
  await warmPool();
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  parked = [];
  await resetDb();
  fake = await fakeStorage();
  ann = await makeUser(api, 'ann@example.com');
  admin = await makeUser(api, 'admin@example.com');
  await (await prismaP()).user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('what is kept and what is deleted', () => {
  it('the verified canonical file of a READY item is never deleted, whatever its age (photo as "image", video as "video")', async () => {
    const photo = await ready('PHOTO');
    const video = await ready('VIDEO');
    const r = await rec();
    expect(r).toMatchObject({ deleted: 0, kept: 2, listed: 2 });
    expect(fake.destroyAssetCalls).toEqual([]);
    expect(has('image', photo.key) && has('video', video.key)).toBe(true);
    expect((await row(photo.id)).status).toBe('READY');
    expect((await row(video.id)).status).toBe('READY');
  });

  it('a late stray that arrives AFTER all three per-item sweeps is deleted; the canonical file and the READY item are untouched', async () => {
    const { id, key } = await ready('PHOTO');
    const w = await worker();
    for (let i = 0; i < 3; i++) {
      await raw(`UPDATE media_item SET stray_sweep_at = now() - interval '1 second' WHERE id = $1::uuid AND stray_sweeps_left > 0`, id);
      await w.runMediaWorkerOnce();
    }
    expect((await row(id)).straySweepsLeft).toBe(0); // no sweep is scheduled any more: nothing but the reconciliation can find a new stray
    const lateRaw = `${key}.png`;
    fake.put(lateRaw, 'raw', photoAsset(lateRaw, { resourceType: 'raw' }), OLD);
    fake.put(key, 'video', videoAsset(key), OLD);
    const before = await row(id);
    const r = await rec();
    expect(r.deleted).toBe(2);
    expect(has('raw', lateRaw)).toBe(false);
    expect(has('video', key)).toBe(false);
    expect(has('image', key)).toBe(true);
    const after = await row(id);
    expect(after).toMatchObject({ status: 'READY', url: before.url, thumbnailUrl: before.thumbnailUrl, straySweepsLeft: 0 });
    // by exact public id, in the namespace where it was found (a raw file keeps its extension)
    expect(fake.destroyAssetCalls).toEqual(expect.arrayContaining([{ publicId: key, type: 'video' }, { publicId: lateRaw, type: 'raw' }]));
    expect(fake.destroyAssetCalls).toHaveLength(2);
  });

  it('a video item: a copy of its key under "image" is a stray; a photo item: the "video" copy is', async () => {
    const video = await ready('VIDEO');
    const photo = await ready('PHOTO');
    fake.put(video.key, 'image', photoAsset(video.key), OLD);
    fake.put(photo.key, 'video', videoAsset(photo.key), OLD);
    await rec();
    expect(has('image', video.key)).toBe(false);
    expect(has('video', photo.key)).toBe(false);
    expect(has('video', video.key) && has('image', photo.key)).toBe(true);
  });

  it('a file with no row (an unconfirmed or late upload) is deleted in every namespace, a raw one under its extension', async () => {
    const a = orphan(1, 'image');
    const b = orphan(2, 'video');
    const c = orphan(3, 'raw');
    const r = await rec();
    expect(r.deleted).toBe(3);
    expect([has('image', a), has('video', b), has('raw', c)]).toEqual([false, false, false]);
  });

  it('the grace period is measured from the PROVIDER creation time: a young stray is kept, an old one is deleted (24 h by default)', async () => {
    const { key } = await ready('PHOTO');
    const young = `${key}.png`;
    fake.put(young, 'raw', photoAsset(young, { resourceType: 'raw' }), 23 * HOUR);
    const youngOrphan = orphan(1, 'image', 23 * HOUR + 30 * 60_000);
    const r = await rec();
    expect(r).toMatchObject({ deleted: 0, young: 2, kept: 1 });
    expect(has('raw', young) && has('image', youngOrphan)).toBe(true);
    fake.age(young, 'raw', 25 * HOUR);
    fake.age(youngOrphan, 'image', 25 * HOUR);
    await dueAll();
    expect((await rec()).deleted).toBe(2);
    // the option moves the line
    const o = orphan(2, 'image', 3 * HOUR);
    await dueAll();
    expect((await rec({ graceHours: 4 })).deleted).toBe(0);
    await dueAll();
    expect((await rec({ graceHours: 2 })).deleted).toBe(1);
    expect(has('image', o)).toBe(false);
  });

  it('PENDING rows are kept (an upload in flight), and DELETING rows are left to the deletion worker, even when their files look like strays', async () => {
    const slot = await requestSlot(api, ann);
    const pendingKey = `fym/media/${slot.body.media.id}`;
    fake.put(pendingKey, 'image', photoAsset(pendingKey), OLD);
    fake.put(pendingKey, 'video', videoAsset(pendingKey), OLD);
    const gone = await ready('PHOTO');
    expect((await api.call('DELETE', `${MEDIA}/${gone.id}`, undefined, ann.token)).status).toBe(204);
    expect((await row(gone.id)).status).toBe('DELETING');
    fake.put(gone.key, 'video', videoAsset(gone.key), OLD);
    const r = await rec();
    expect(r).toMatchObject({ deleted: 0, left: 4 });
    expect(fake.destroyAssetCalls).toEqual([]);
    expect(fake.objects.size).toBe(4);
  });

  it('ids outside the exact "<folder>/media/<uuid>" pattern are ignored (counted as foreign), and other folders are never listed', async () => {
    const put = (key: string, type: Ns = 'image') => fake.put(key, type, photoAsset(key, { resourceType: type }), OLD);
    put('fym/media/not-a-uuid');
    put(`fym/media/${uid(1)}/extra`);
    put('fym/media/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'); // upper case: the database never produces it
    put(`fym/media/${uid(1)}.png`, 'image'); // an extension is only ever the raw namespace's form
    put(`fym-other/media/${uid(2)}`);
    put(`fym/other/${uid(2)}`);
    put(`fym/media/${uid(3)}.png`, 'raw'); // OUR raw stray form: deleted
    const r = await rec();
    expect(r).toMatchObject({ deleted: 1, foreign: 4 });
    expect(has('raw', `fym/media/${uid(3)}.png`)).toBe(false);
    expect(fake.objects.size).toBe(6);
  });

  it('a row whose stored key does not match the listed id is ambiguous and is never a reason to delete', async () => {
    const { id, key } = await ready('PHOTO');
    await asIfTimePassed(`UPDATE media_item SET storage_key = $2 WHERE id = $1::uuid`, id, `fym/media/other-${id}`);
    const r = await rec();
    expect(r).toMatchObject({ deleted: 0, foreign: 1 });
    expect(has('image', key)).toBe(true);
  });

  it('the decision is repeated right before each delete: a row that is deleted by its owner, or created, AFTER the page was judged is not touched', async () => {
    // one page of the video namespace, judged as a whole: [orphan 1, orphan 2, stray of a READY item]. Deleting orphan 1 is the moment the world changes:
    // the READY item is deleted by its owner (its row becomes DELETING) and a slot is requested for orphan 2 (a PENDING row appears).
    const a = await ready('PHOTO');
    fake.put(a.key, 'video', videoAsset(a.key), OLD);
    orphan(1, 'video');
    orphan(2, 'video');
    fake.state.beforeDestroyAsset = async (publicId) => {
      if (publicId !== keyOfN(1)) return;
      await api.call('DELETE', `${MEDIA}/${a.id}`, undefined, ann.token);
      await (await prisma()).mediaItem.create({
        data: { id: uid(2), ownerUserId: ann.userId, uploadedById: ann.userId, kind: 'PHOTO', storageKey: keyOfN(2), mimeType: 'image/jpeg' },
      });
    };
    const r = await rec();
    expect(r.deleted).toBe(1); // orphan 1 only
    expect(fake.destroyAssetCalls).toEqual([{ publicId: keyOfN(1), type: 'video' }]);
    expect(has('video', a.key) && has('video', keyOfN(2))).toBe(true);
    expect((await row(a.id)).status).toBe('DELETING');
  });
});

describe('pagination, budgets and cycles', () => {
  it('walks every page in order, deletes on each, and completes the cycle only at the end of the listing', async () => {
    await park('video', 'raw');
    for (let n = 1; n <= 7; n++) orphan(n);
    const r = await rec({ pageSize: 3, maxPages: 10 });
    expect(r).toMatchObject({ pages: 3, deleted: 7, cyclesCompleted: ['image'], failed: [] });
    expect(fake.listCalls.map((c) => c.cursor)).toEqual([null, `c:${keyOfN(3)}`, `c:${keyOfN(6)}`]);
    expect(fake.listCalls.every((c) => c.maxResults === 3 && c.type === 'image')).toBe(true);
    const s = await st();
    expect(s).toMatchObject({ cursor: null, cycleStartedAt: null, cyclePages: 0, cycleScanned: 0, cycleDeleted: 0, attempts: 0, lastError: null, claimId: null });
    expect(s.lastCycleCompletedAt).not.toBeNull();
    // the next cycle starts an interval after this one STARTED
    expect(s.nextRunAt.getTime() - Date.now()).toBeGreaterThan(23.9 * HOUR);
    expect(ids('image')).toEqual([]);
  });

  it('the page budget splits a long walk across runs; the cursor is saved, the type pauses, and the next run continues where it stopped', async () => {
    await park('video', 'raw');
    for (let n = 1; n <= 7; n++) orphan(n);
    const first = await rec({ pageSize: 2, maxPages: 2 });
    expect(first).toMatchObject({ pages: 2, deleted: 4, cyclesCompleted: [] });
    const mid = await st();
    expect(mid).toMatchObject({ cursor: `c:${keyOfN(4)}`, cyclePages: 2, cycleScanned: 4, cycleDeleted: 4, attempts: 0, claimId: null });
    expect(mid.cycleStartedAt).not.toBeNull();
    expect(mid.nextRunAt.getTime() - Date.now()).toBeGreaterThan(25 * 60_000); // pauses, does not hammer the Admin API
    expect((await rec({ pageSize: 2, maxPages: 2 })).pages).toBe(0); // not due yet
    await dueAll();
    const second = await rec({ pageSize: 2, maxPages: 2 });
    expect(second).toMatchObject({ pages: 2, deleted: 3, cyclesCompleted: ['image'] });
    expect(fake.listCalls.at(-2)!.cursor).toBe(`c:${keyOfN(4)}`); // the second run started from the saved cursor
    expect(ids('image')).toEqual([]);
    expect(await st()).toMatchObject({ cursor: null, cycleStartedAt: null });
  });

  it('every resource type completes a full scan even when each is larger than the per-run budget, and none is starved (round-robin)', async () => {
    for (let n = 1; n <= 7; n++) orphan(n, 'image');
    for (let n = 1; n <= 5; n++) orphan(n, 'video');
    for (let n = 1; n <= 3; n++) orphan(n, 'raw');
    let runs = 0;
    const completed = new Set<string>();
    for (; runs < 12 && completed.size < 3; runs++) {
      const r = await rec({ pageSize: 2, maxPages: 3 });
      r.cyclesCompleted.forEach((t) => completed.add(t));
      if (runs === 0) expect(fake.listCalls.map((c) => c.type).sort()).toEqual(['image', 'raw', 'video']); // one page each: no type waits for another to finish
      await dueAll();
    }
    expect([...completed].sort()).toEqual(['image', 'raw', 'video']);
    expect(runs).toBeLessThanOrEqual(4);
    expect(fake.objects.size).toBe(0);
    for (const t of ['image', 'video', 'raw']) expect((await st(t)).lastCycleCompletedAt).not.toBeNull();
  });

  it('the deletion budget can end a run in the middle of a page: the cursor stays and the next run fetches the page again and finishes it', async () => {
    await park('video', 'raw');
    for (let n = 1; n <= 5; n++) orphan(n);
    const first = await rec({ maxDeletions: 2 });
    expect(first).toMatchObject({ deleted: 2, cyclesCompleted: [] });
    expect(await st()).toMatchObject({ cursor: null, cycleDeleted: 2, claimId: null });
    expect((await st()).cycleStartedAt).not.toBeNull();
    expect(ids('image')).toHaveLength(3);
    await dueAll();
    const second = await rec({ maxDeletions: 5 });
    expect(second).toMatchObject({ deleted: 3, cyclesCompleted: ['image'] });
    expect(ids('image')).toEqual([]);
    expect(fake.destroyAssetCalls).toHaveLength(5); // nothing was deleted twice
  });

  it('an asset that appears BEHIND the cursor is found by the next complete cycle, not the running one', async () => {
    await park('video', 'raw');
    for (const n of [3, 4, 5, 6]) orphan(n);
    await rec({ pageSize: 2, maxPages: 1 }); // page [3,4] done, cursor after 4
    expect(await st()).toMatchObject({ cursor: `c:${keyOfN(4)}` });
    const behind = orphan(1); // sorts before the cursor
    const ahead = orphan(9); // sorts after it
    await dueAll();
    const r = await rec({ pageSize: 2, maxPages: 10 });
    expect(r).toMatchObject({ deleted: 3, cyclesCompleted: ['image'] }); // 5, 6 and 9
    expect(has('image', ahead)).toBe(false);
    expect(has('image', behind)).toBe(true); // the cycle that found the end of the listing did not look back
    await dueAll(); // the next cycle
    const next = await rec({ pageSize: 2, maxPages: 10 });
    expect(next).toMatchObject({ deleted: 1, cyclesCompleted: ['image'] });
    expect(has('image', behind)).toBe(false);
  });

  it('a second run right after a finished cycle does nothing, and an extra cycle with nothing to remove deletes nothing (idempotent)', async () => {
    const { key } = await ready('PHOTO');
    const stray = orphan(1);
    expect((await rec()).deleted).toBe(1);
    const again = await rec();
    expect(again.pages).toBe(0); // not due
    await dueAll();
    const third = await rec();
    expect(third).toMatchObject({ deleted: 0, kept: 1, failed: [] });
    expect(has('image', key)).toBe(true);
    expect(has('image', stray)).toBe(false);
  });

  it('with the Admin API budget nearly used up the run stops after the page in hand and waits, so confirmations and sweeps are not starved', async () => {
    for (let n = 1; n <= 4; n++) orphan(n);
    fake.state.rateRemaining = 50;
    const r = await rec({ pageSize: 2, maxPages: 10 });
    expect(r.pages).toBe(1); // one page although two more types and more pages were due
    expect(r.deleted).toBe(2); // the page in hand was processed
    expect((await st('image')).cursor).toBe(`c:${keyOfN(2)}`);
    for (const t of ['image', 'video', 'raw']) expect((await st(t)).nextRunAt.getTime() - Date.now()).toBeGreaterThan(25 * 60_000);
  });
});

describe('partial failures', () => {
  it('a failure on page 2 keeps the saved cursor of page 1, does not complete the cycle, and the retry continues without skipping anything', async () => {
    await park('video', 'raw');
    for (let n = 1; n <= 6; n++) orphan(n);
    fake.state.listError = ({ call }) => (call === 2 ? transient() : null);
    const r = await rec({ pageSize: 2, maxPages: 10 });
    expect(r).toMatchObject({ pages: 1, deleted: 2, cyclesCompleted: [], failed: [{ type: 'image', code: 'HTTP_503' }] });
    const s = await st();
    expect(s).toMatchObject({ cursor: `c:${keyOfN(2)}`, cyclePages: 1, attempts: 1, lastError: 'HTTP_503', claimId: null });
    expect(s.cycleStartedAt).not.toBeNull();
    expect(s.lastCycleCompletedAt).toBeNull();
    expect(s.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 30_000); // backoff
    fake.state.listError = null;
    await dueAll();
    const retry = await rec({ pageSize: 2, maxPages: 10 });
    expect(retry).toMatchObject({ deleted: 4, cyclesCompleted: ['image'] });
    expect(fake.listCalls.at(-2)!.cursor).toBe(`c:${keyOfN(2)}`); // resumed from the saved cursor
    expect(ids('image')).toEqual([]); // nothing in page 2 or 3 was skipped
    expect(await st()).toMatchObject({ attempts: 0, lastError: null, cursor: null });
  });

  it('a failing delete stops all further deletions at once, leaves the cursor where it was, and a retry finishes the page idempotently', async () => {
    await park('video', 'raw');
    for (let n = 1; n <= 5; n++) orphan(n);
    fake.state.destroyAssetError = (publicId) => (publicId === keyOfN(3) ? transient('HTTP_500') : null);
    const r = await rec();
    expect(r).toMatchObject({ deleted: 2, cyclesCompleted: [], failed: [{ type: 'image', code: 'HTTP_500' }] });
    expect(fake.destroyAssetCalls.map((c) => c.publicId)).toEqual([keyOfN(1), keyOfN(2), keyOfN(3)]); // 4 and 5 were never attempted
    expect(await st()).toMatchObject({ cursor: null, cycleDeleted: 2, attempts: 1, lastError: 'HTTP_500' });
    expect(ids('image')).toHaveLength(3);
    fake.state.destroyAssetError = null;
    await dueAll();
    const retry = await rec();
    expect(retry).toMatchObject({ deleted: 3, cyclesCompleted: ['image'] });
    expect(fake.destroyAssetCalls.filter((c) => c.publicId === keyOfN(1))).toHaveLength(1); // the already deleted are not repeated
    expect(ids('image')).toEqual([]);
  });

  it('an unreadable page is never acted on: nothing is deleted, the cursor does not move, the cycle does not complete', async () => {
    await park('video', 'raw');
    orphan(1);
    fake.state.listError = () => rejected('BAD_PAGE');
    const r = await rec();
    expect(r).toMatchObject({ deleted: 0, cyclesCompleted: [], failed: [{ type: 'image', code: 'BAD_PAGE' }] });
    expect(fake.destroyAssetCalls).toEqual([]);
    expect(await st()).toMatchObject({ cursor: null, attempts: 1, lastError: 'BAD_PAGE' });
    expect((await st()).lastCycleCompletedAt).toBeNull();
  });

  it('a provider outage stops the whole run after ONE call and holds the other types back too; a failure is logged and counted in the stats', async () => {
    orphan(1);
    fake.state.listError = () => transient('NETWORK');
    const r = await rec();
    expect(r.failed).toEqual([{ type: 'image', code: 'NETWORK' }]);
    expect(fake.listCalls).toHaveLength(1);
    await rec(); // straight away: nothing is due, nothing is tried
    expect(fake.listCalls).toHaveLength(1);
    for (const t of ['video', 'raw']) expect((await st(t)).nextRunAt.getTime() - Date.now()).toBeGreaterThan(30_000);
    expect(fake.destroyAssetCalls).toEqual([]);
  });

  it('bad credentials and a missing configuration back off for 30 and 60 minutes', async () => {
    orphan(1);
    fake.state.listError = () => new fake.StorageError('no', 'AUTH', 'HTTP_401');
    await rec();
    expect((await st('image')).nextRunAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    fake.state.listError = () => new fake.StorageError('no', 'NOT_CONFIGURED', 'NOT_CONFIGURED');
    await dueAll();
    await rec();
    expect((await st('image')).nextRunAt.getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
  });

  it('a database error mid-page leaves the cursor unmoved and deletes nothing; the type is released and the retry succeeds', async () => {
    await park('video', 'raw');
    orphan(1);
    const p = await prisma();
    const original = p.$queryRaw.bind(p) as (...a: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(p, '$queryRaw').mockImplementation(((...a: unknown[]) => {
      const sql = Array.isArray(a[0]) ? (a[0] as string[]).join('?') : String(a[0]);
      return sql.includes('FROM media_item') ? Promise.reject(new Error('db down')) : original(...a);
    }) as never);
    await expect(rec()).rejects.toThrow('db down');
    spy.mockRestore();
    expect(fake.destroyAssetCalls).toEqual([]);
    expect(await st()).toMatchObject({ cursor: null, claimId: null, cyclePages: 0 });
    expect((await st()).nextRunAt.getTime()).toBeGreaterThan(Date.now() + 30_000); // a short pause, not the 30 minutes of a finished budget
    expect((await st()).nextRunAt.getTime()).toBeLessThan(Date.now() + 5 * 60_000);
    await dueAll();
    expect(await rec()).toMatchObject({ deleted: 1, cyclesCompleted: ['image'] });
  });

  it('a cursor the provider no longer accepts restarts the walk from the first page: the cycle start is kept, the cycle cannot complete early', async () => {
    await park('video', 'raw');
    for (let n = 1; n <= 4; n++) orphan(n);
    await rec({ pageSize: 2, maxPages: 1 });
    const started = (await st()).cycleStartedAt!;
    fake.state.rejectCursors = true;
    await dueAll();
    const r = await rec({ pageSize: 2, maxPages: 10 });
    expect(r.cyclesCompleted).toEqual([]);
    expect(await st()).toMatchObject({ cursor: null, cyclePages: 0, attempts: 1, lastError: 'INVALID_CURSOR', claimId: null });
    expect((await st()).cycleStartedAt!.getTime()).toBe(started.getTime());
    fake.state.rejectCursors = false;
    await dueAll();
    const again = await rec({ pageSize: 2, maxPages: 10 });
    expect(again).toMatchObject({ deleted: 2, cyclesCompleted: ['image'] }); // 3 and 4: from the first page again
    expect(ids('image')).toEqual([]);
  });
});

describe('leases: one runner per type, progress survives restarts', () => {
  it('two runs at the same time delete every file exactly once', async () => {
    await park('video', 'raw');
    for (let n = 1; n <= 6; n++) orphan(n);
    await Promise.all([rec({ pageSize: 2 }), rec({ pageSize: 2 })]);
    expect(fake.destroyAssetCalls).toHaveLength(6);
    expect(new Set(fake.destroyAssetCalls.map((c) => c.publicId)).size).toBe(6);
    expect(ids('image')).toEqual([]);
  });

  it('a type leased by another runner is left alone; once its lease has expired the run resumes from the saved cursor', async () => {
    for (let n = 1; n <= 4; n++) orphan(n);
    await park('video', 'raw');
    await raw(`INSERT INTO media_reconcile (resource_type, updated_at) VALUES ('image', now()) ON CONFLICT DO NOTHING`);
    await raw(
      `UPDATE media_reconcile SET cursor = $1, cycle_started_at = now() - interval '1 hour', cycle_pages = 1, claim_id = gen_random_uuid(),
              lease_until = now() + interval '5 minutes', next_run_at = now() - interval '1 second' WHERE resource_type = 'image'`,
      `c:${keyOfN(2)}`,
    );
    expect((await rec()).pages).toBe(0);
    expect(fake.listCalls).toEqual([]);
    await raw(`UPDATE media_reconcile SET lease_until = now() - interval '1 second' WHERE resource_type = 'image'`);
    const r = await rec({ pageSize: 10 });
    expect(r).toMatchObject({ deleted: 2, cyclesCompleted: ['image'] });
    expect(fake.listCalls[0]!.cursor).toBe(`c:${keyOfN(2)}`);
    expect(has('image', keyOfN(1)) && has('image', keyOfN(2))).toBe(true); // behind the saved cursor: the next cycle's work
    expect(has('image', keyOfN(3)) || has('image', keyOfN(4))).toBe(false);
  });

  it('a runner that loses its lease mid-run stops: it deletes nothing more and writes nothing', async () => {
    await park('video', 'raw');
    for (let n = 1; n <= 3; n++) orphan(n);
    fake.state.afterList = async () => {
      await raw(`UPDATE media_reconcile SET claim_id = gen_random_uuid(), lease_until = now() + interval '5 minutes' WHERE resource_type = 'image'`);
    };
    const r = await rec();
    expect(r).toMatchObject({ deleted: 0, lostLease: ['image'], cyclesCompleted: [] });
    expect(fake.destroyAssetCalls).toEqual([]);
    expect(await st()).toMatchObject({ cursor: null, cyclePages: 0, attempts: 0 });
  });
});

describe('monitoring and configuration', () => {
  it('reports the age of the oldest unprocessed work, per type, and the types that keep failing; GET /admin/stats carries it', async () => {
    await park('video', 'raw');
    for (let n = 1; n <= 4; n++) orphan(n);
    await rec({ pageSize: 2, maxPages: 1 });
    await raw(`UPDATE media_reconcile SET cycle_started_at = now() - interval '3 hours', attempts = 3, last_error = 'HTTP_500' WHERE resource_type = 'image'`);
    const s = await status();
    const image = s.types.find((t) => t.type === 'image')!;
    expect(image).toMatchObject({ running: true, pages: 1, scanned: 2, deleted: 2, attempts: 3, lastError: 'HTTP_500' });
    expect(image.cycleAgeSeconds).toBeGreaterThanOrEqual(3 * 3600);
    expect(s.oldestUnprocessedSeconds).toBeGreaterThanOrEqual(3 * 3600);
    expect(s.stuck).toEqual(['image']);
    const http = await api.call('GET', '/api/v1/admin/stats', undefined, admin.token);
    expect(http.status).toBe(200);
    expect(http.body.mediaReconcile.oldestUnprocessedSeconds).toBeGreaterThanOrEqual(3 * 3600);
    expect(http.body.mediaReconcile.stuck).toEqual(['image']);
    expect(http.body.mediaReconcile.types).toHaveLength(3);
  });

  it('an idle type that is overdue is reported as overdue, a type that never ran as idle with no age', async () => {
    await raw(`INSERT INTO media_reconcile (resource_type, updated_at, next_run_at) VALUES ('video', now(), now() - interval '2 hours')`);
    const s = await status();
    expect(s.types.find((t) => t.type === 'video')).toMatchObject({ running: false, cycleAgeSeconds: null });
    expect(s.types.find((t) => t.type === 'video')!.overdueSeconds).toBeGreaterThanOrEqual(7200);
    expect(s.types.find((t) => t.type === 'image')).toMatchObject({ running: false, overdueSeconds: null, nextRunAt: null });
    expect(s.oldestUnprocessedSeconds).toBeGreaterThanOrEqual(7200);
  });

  it('without provider credentials the job does nothing and creates nothing', async () => {
    const { storage } = await import('../src/lib/cloudinary');
    vi.spyOn(storage, 'configured').mockReturnValue(false);
    const r = await rec();
    expect(r.pages).toBe(0);
    expect(await (await prisma()).mediaReconcile.count()).toBe(0);
    expect(fake.listCalls).toEqual([]);
  });

  it('the table refuses impossible states (type, cursor outside a cycle, a lease without a claim, negative counters)', async () => {
    await expect(raw(`INSERT INTO media_reconcile (resource_type, updated_at) VALUES ('thumbnail', now())`)).rejects.toThrow(/chk_media_reconcile_type/);
    await raw(`INSERT INTO media_reconcile (resource_type, updated_at) VALUES ('image', now())`);
    await expect(raw(`UPDATE media_reconcile SET cursor = 'x' WHERE resource_type = 'image'`)).rejects.toThrow(/chk_media_reconcile_cycle/);
    await expect(raw(`UPDATE media_reconcile SET cycle_pages = 1 WHERE resource_type = 'image'`)).rejects.toThrow(/chk_media_reconcile_cycle/);
    await expect(raw(`UPDATE media_reconcile SET cycle_started_at = now(), cycle_deleted = -1 WHERE resource_type = 'image'`)).rejects.toThrow(/chk_media_reconcile_cycle/);
    await expect(raw(`UPDATE media_reconcile SET claim_id = gen_random_uuid() WHERE resource_type = 'image'`)).rejects.toThrow(/chk_media_reconcile_lease/);
    await expect(raw(`UPDATE media_reconcile SET lease_until = now() WHERE resource_type = 'image'`)).rejects.toThrow(/chk_media_reconcile_lease/);
  });
});
