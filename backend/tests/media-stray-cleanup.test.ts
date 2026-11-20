import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { asIfTimePassed, confirm, fakeStorage, insertRow, keyOf, MEDIA, photoAsset, prismaP, requestSlot, uploadMedia, videoAsset, warmPool, worker, type FakeStorage } from './helpers/media';
import { makeUser, PASSWORD, type TestUser } from './helpers/users';

/*
 * Cleanup of STRAY provider objects. The upload signature does not cover the resource type, so a client can also put a file under another type than
 * the one confirmed (a raw file is stored as "<key>.<extension>"), and a signature stays usable for one hour. Every READY item gets THREE sweeps
 * (media_item.stray_sweeps_left): 3 = due at confirmation, 2 = due when the upload window has closed (70 minutes after the slot was created),
 * 1 = due 24 hours after it, 0 = done. They run in the media worker and:
 *   - delete the object under every resource type EXCEPT the verified canonical one, and nothing that belongs to another row;
 *   - never touch the READY item (a failure only reschedules the sweep, with backoff, never abandoned);
 *   - are idempotent ("not found" is fine) and bounded (a pass stops at the first rate-limit / network / credential failure).
 * A DELETED row is kept, hidden, until the window has closed, because the signature that created its slot may still be used to upload.
 *
 * Verified against the live service (not testable here): a signature is accepted while its timestamp is at most ~3,600 s old, and the check happens
 * when the request has been received in full, so a slow upload that outlives the signature is refused and creates no asset.
 */

let api: Awaited<ReturnType<typeof startApp>>;
let fake: FakeStorage;
let ann: TestUser;

const prisma = async () => prismaP();
const row = async (id: string) => (await prisma()).mediaItem.findUniqueOrThrow({ where: { id } });
const raw = async (sql: string, ...p: unknown[]) => (await prisma()).$executeRawUnsafe(sql, ...p);
/** Makes the sweep due now (allowed on a READY row: it is one of the columns a sweep may change). Only while a sweep is left. */
const dueNow = (id: string) => raw(`UPDATE media_item SET stray_sweep_at = now() - interval '1 second' WHERE id = $1::uuid`, id);
const run = async (opts: Record<string, unknown> = {}) => (await worker()).runMediaWorkerOnce(opts);
const keys = () => [...fake.objects.keys()].sort();
const MIN = 60_000;
const stray = (key: string, type: 'raw' | 'video' | 'image', ext = '') => {
  const k = type === 'raw' ? `${key}${ext || '.png'}` : key;
  fake.put(k, type, type === 'video' ? videoAsset(k) : photoAsset(k, { resourceType: type }));
};

beforeAll(async () => {
  api = await startApp();
  await warmPool();
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
  fake = await fakeStorage();
  ann = await makeUser(api, 'ann@example.com');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('after a successful confirmation', () => {
  it('image: an extra raw ("<key>.png") and video asset are removed, the canonical image stays, the item stays READY', async () => {
    const { id, key, res } = await uploadMedia(api, fake, ann);
    stray(key, 'raw');
    stray(key, 'video');
    expect(res.status).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'READY', straySweepsLeft: 3, straySweepAttempts: 0 }); // scheduled in the confirming transaction
    const urlBefore = (await row(id)).url;
    fake.destroyCalls.length = 0;

    expect(await run()).toMatchObject({ swept: 1, sweepRetried: 0 });
    expect(keys()).toEqual([`image:${key}`]); // only the canonical asset is left
    expect(fake.destroyCalls).toEqual([
      { key, type: 'video' },
      { key, type: 'raw' },
    ]); // the canonical type "image" is never asked to delete
    const after = await row(id);
    expect(after).toMatchObject({ status: 'READY', url: urlBefore, straySweepsLeft: 2, straySweepAttempts: 0, lastStrayError: null });
    // the second sweep is due when the upload window has closed (created + 70 min), not now
    const dueIn = after.straySweepAt!.getTime() - after.createdAt.getTime();
    expect(dueIn).toBeGreaterThan(69 * MIN);
    expect(dueIn).toBeLessThan(71 * MIN);
    expect((await api.call('GET', `/api/v1/players/${ann.userId}/media`, undefined, ann.token)).body.media.map((m: { id: string }) => m.id)).toEqual([id]);
  });

  it('video: an extra image and raw ("<key>.mov") asset are removed, the canonical video stays', async () => {
    const { id, key, res } = await uploadMedia(api, fake, ann, { kind: 'VIDEO' });
    stray(key, 'image');
    stray(key, 'raw', '.mov');
    expect(res.status).toBe(200);
    fake.destroyCalls.length = 0;

    expect(await run()).toMatchObject({ swept: 1 });
    expect(keys()).toEqual([`video:${key}`]);
    expect(fake.destroyCalls).toEqual([
      { key, type: 'image' },
      { key, type: 'raw' },
    ]);
    expect(await row(id)).toMatchObject({ status: 'READY', straySweepsLeft: 2 });
  });

  it('the schedule: now, when the upload window has closed (70 min), then a day after the slot (24 h), then nothing', async () => {
    const { id, key } = await uploadMedia(api, fake, ann);
    expect((await row(id)).straySweepsLeft).toBe(3);
    await run(); // sweep 1: at confirmation

    // a stray uploaded INSIDE the window, after the first sweep (the signature is still valid)
    stray(key, 'raw');
    stray(key, 'video');
    expect(await run()).toMatchObject({ swept: 0 }); // the second sweep is not due yet
    expect(keys()).toHaveLength(3);

    await dueNow(id); // the window has closed
    expect(await run()).toMatchObject({ swept: 1 });
    expect(keys()).toEqual([`image:${key}`]);
    const second = await row(id);
    expect(second).toMatchObject({ straySweepsLeft: 1, straySweepAttempts: 0 });
    const lateIn = second.straySweepAt!.getTime() - second.createdAt.getTime();
    expect(lateIn).toBeGreaterThan(23.9 * 60 * MIN);
    expect(lateIn).toBeLessThan(24.1 * 60 * MIN);

    // the insurance sweep: a file that the provider was still processing when the window closed and that appeared afterwards
    stray(key, 'raw', '.webp');
    expect(await run()).toMatchObject({ swept: 0 }); // not due yet
    expect(keys()).toHaveLength(2);
    await dueNow(id); // a day later
    expect(await run()).toMatchObject({ swept: 1 });
    expect(keys()).toEqual([`image:${key}`]);
    expect(await row(id)).toMatchObject({ status: 'READY', straySweepsLeft: 0, straySweepAt: null, straySweepAttempts: 0, lastStrayError: null });

    // finished: nothing is scheduled any more, no further provider calls, ever
    fake.destroyCalls.length = 0;
    await run();
    await run();
    expect(fake.destroyCalls).toEqual([]);
  });

  it('does not delete unrelated assets: another row\'s files and look-alike keys survive, and so does the canonical asset', async () => {
    const { id, key } = await uploadMedia(api, fake, ann);
    const other = '00000000-aaaa-4bbb-8ccc-000000000001';
    const survivors = [
      ['video', `fym/media/${other}`],
      ['raw', `fym/media/${other}.png`],
      ['image', `fym/media/${other}`],
      ['raw', `${key}0`], // same prefix, not the key
      ['raw', `${key}-copy.png`],
      ['raw', `x${key}.png`],
      ['video', `${key}.mp4`], // another id in the video namespace
    ] as const;
    for (const [type, k] of survivors) fake.put(k, type, photoAsset(k, { resourceType: type }));
    stray(key, 'raw'); // the one stray of this row
    for (let i = 0; i < 3; i++) {
      await run();
      if ((await row(id)).straySweepsLeft > 0) await dueNow(id);
    }
    expect(keys()).toEqual([`image:${key}`, ...survivors.map(([t, k]) => `${t}:${k}`)].sort());
  });
});

describe('idempotent, and "not found" is fine', () => {
  it('with nothing stray at the provider all three sweeps complete (every answer is "not found") and nothing else happens', async () => {
    const { id, key } = await uploadMedia(api, fake, ann);
    for (let i = 0; i < 3; i++) {
      expect(await run()).toMatchObject({ swept: 1, sweepRetried: 0 });
      if ((await row(id)).straySweepsLeft > 0) await dueNow(id);
    }
    expect(fake.destroyCalls.filter((c) => c.key === key)).toHaveLength(6); // 3 sweeps x 2 namespaces
    expect(await row(id)).toMatchObject({ status: 'READY', straySweepsLeft: 0 });
    expect(keys()).toEqual([`image:${key}`]);
  });

  it('two workers at the same time advance a sweep ONCE (a due sweep is claimed under a lease, the step is advanced conditionally)', async () => {
    const { id } = await uploadMedia(api, fake, ann);
    const results = await Promise.all([run(), run(), run()]);
    expect(results.reduce((n, r) => n + r.swept, 0)).toBe(1);
    expect((await row(id)).straySweepsLeft).toBe(2); // not 1: no sweep was skipped
  });

  it('a sweep claimed by a worker that died is taken over once its lease has expired, and not before', async () => {
    const { id } = await uploadMedia(api, fake, ann);
    await raw(`UPDATE media_item SET stray_sweep_at = now() + interval '2 minutes' WHERE id = $1::uuid`, id); // what a claim does
    expect(await run()).toMatchObject({ swept: 0 });
    await dueNow(id); // the lease ran out
    expect(await run()).toMatchObject({ swept: 1 });
  });
});

describe('a failing cleanup never invalidates a valid READY item', () => {
  it('the item stays published and visible, the sweep is rescheduled with backoff and the error recorded; a later success clears it', async () => {
    const { id, key, res } = await uploadMedia(api, fake, ann);
    expect(res.status).toBe(200);
    stray(key, 'raw');
    const before = await row(id);

    fake.failDestroy((_k, type) => (type === 'raw' ? new fake.StorageError('provider unavailable', 'TRANSIENT', 'HTTP_503') : null));
    expect(await run()).toMatchObject({ swept: 0, sweepRetried: 1 });
    const failed = await row(id);
    expect(failed).toMatchObject({ status: 'READY', url: before.url, thumbnailUrl: before.thumbnailUrl, sizeBytes: before.sizeBytes, caption: before.caption });
    expect(failed).toMatchObject({ straySweepsLeft: 3, straySweepAttempts: 1, lastStrayError: 'HTTP_503' }); // same step, one failed attempt
    expect(failed.straySweepAt!.getTime()).toBeGreaterThan(Date.now() + 30_000); // backoff
    expect(keys()).toContain(`raw:${key}.png`); // the stray is still there for now
    const list = await api.call('GET', `/api/v1/players/${ann.userId}/media`, undefined, ann.token);
    expect(list.body.media.map((m: { id: string }) => m.id)).toEqual([id]); // and the item is still served

    // not due again at once
    fake.destroyCalls.length = 0;
    expect(await run()).toMatchObject({ swept: 0, sweepRetried: 0 });
    expect(fake.destroyCalls).toEqual([]);

    // the provider recovers: the same step succeeds, the error is cleared, the stray is gone
    fake.failDestroy(null);
    await dueNow(id);
    expect(await run()).toMatchObject({ swept: 1 });
    expect(await row(id)).toMatchObject({ status: 'READY', straySweepsLeft: 2, straySweepAttempts: 0, lastStrayError: null });
    expect(keys()).toEqual([`image:${key}`]);
  });

  it('the backoff grows with the attempts, and bad credentials push the sweep 30 minutes out', async () => {
    const { backoffMs, BACKOFF_MS } = await worker();
    const { id } = await uploadMedia(api, fake, ann);
    fake.failDestroy(() => new fake.StorageError('down', 'TRANSIENT', 'NETWORK'));
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      await dueNow(id);
      await run();
      delays.push((await row(id)).straySweepAt!.getTime() - Date.now());
    }
    delays.forEach((d, i) => {
      expect(d).toBeGreaterThan(BACKOFF_MS[i]! * 0.75);
      expect(d).toBeLessThan(BACKOFF_MS[i]! * 1.25);
    });
    expect(backoffMs(99, () => 0.5)).toBe(12 * 3_600_000); // never abandoned, capped at 12 h
    fake.failDestroy(() => new fake.StorageError('refused', 'AUTH', 'HTTP_401'));
    await dueNow(id);
    await run();
    expect((await row(id)).straySweepAt!.getTime() - Date.now()).toBeGreaterThan(29 * MIN);
    expect(await row(id)).toMatchObject({ status: 'READY', lastStrayError: 'HTTP_401', straySweepAttempts: 4 });
  });
});

describe('bounded use of the provider', () => {
  it('a rate-limit / network / credential failure STOPS the pass after one call: an outage costs one request per pass, not one per item', async () => {
    const items = [];
    for (let i = 0; i < 4; i++) items.push(await uploadMedia(api, fake, ann));
    fake.destroyCalls.length = 0;
    fake.failDestroy(() => new fake.StorageError('rate limited', 'TRANSIENT', 'HTTP_420'));
    expect(await run()).toMatchObject({ swept: 0, sweepRetried: 1 });
    expect(fake.destroyCalls).toHaveLength(1); // one call in total, for one item
    const states = await Promise.all(items.map((i) => row(i.id)));
    expect(states.filter((s) => s.straySweepAttempts === 1)).toHaveLength(1);
    expect(states.filter((s) => s.straySweepAttempts === 0 && s.straySweepsLeft === 3)).toHaveLength(3); // untouched, still due

    // the next pass takes the next item (the failed one is backing off): again one call
    fake.destroyCalls.length = 0;
    await run();
    expect(fake.destroyCalls).toHaveLength(1);
  });

  it('an error that belongs to one item (not an outage) does not block the other items', async () => {
    const a = await uploadMedia(api, fake, ann);
    const b = await uploadMedia(api, fake, ann);
    const c = await uploadMedia(api, fake, ann);
    fake.failDestroy((key) => (key === b.key ? new fake.StorageError('unexpected answer', 'REJECTED', 'HTTP_400') : null));
    expect(await run()).toMatchObject({ swept: 2, sweepRetried: 1 });
    expect((await row(a.id)).straySweepsLeft).toBe(2);
    expect((await row(c.id)).straySweepsLeft).toBe(2);
    expect(await row(b.id)).toMatchObject({ status: 'READY', straySweepsLeft: 3, lastStrayError: 'HTTP_400' });
  });

  it('a pass handles at most maxStray sweeps (default 10); the rest wait for the next pass', async () => {
    const { MAX_STRAY_PER_RUN } = await worker();
    expect(MAX_STRAY_PER_RUN).toBe(10);
    for (let i = 0; i < 5; i++) await uploadMedia(api, fake, ann);
    expect(await run({ maxStray: 2 })).toMatchObject({ swept: 2 });
    expect(await run({ maxStray: 2 })).toMatchObject({ swept: 2 });
    expect(await run({ maxStray: 2 })).toMatchObject({ swept: 1 });
    expect(await run({ maxStray: 2 })).toMatchObject({ swept: 0 }); // the second sweeps are not due yet
    expect(await (await prisma()).mediaItem.count({ where: { straySweepsLeft: 2 } })).toBe(5);
  });

  it('the total cost per item is fixed: three sweeps, each one delete in the other media namespace and one raw sweep, and nothing more', async () => {
    const { id, key } = await uploadMedia(api, fake, ann);
    fake.destroyCalls.length = 0;
    for (let i = 0; i < 6; i++) {
      await run();
      if ((await row(id)).straySweepsLeft > 0) await dueNow(id); // after the last sweep nothing is scheduled (the database refuses a due time then)
    }
    expect(fake.destroyCalls.filter((c) => c.key === key)).toEqual([
      { key, type: 'video' },
      { key, type: 'raw' },
      { key, type: 'video' },
      { key, type: 'raw' },
      { key, type: 'video' },
      { key, type: 'raw' },
    ]);
  });
});

describe('together with deletion', () => {
  it('deleting an item with a sweep scheduled clears the schedule; the deletion worker then removes EVERY object under the key, strays included', async () => {
    const { id, key } = await uploadMedia(api, fake, ann);
    stray(key, 'raw');
    stray(key, 'video');
    expect((await api.call('DELETE', `${MEDIA}/${id}`, undefined, ann.token)).status).toBe(204);
    expect(await row(id)).toMatchObject({ status: 'DELETING', straySweepsLeft: 0, straySweepAt: null, straySweepAttempts: 0, lastStrayError: null });

    expect(await run()).toMatchObject({ deleted: 1, swept: 0 });
    expect(fake.objects.size).toBe(0);
    expect(await (await prisma()).mediaItem.count()).toBe(0);
  });

  it('admin removal and account deletion clear the schedule too', async () => {
    const admin = await makeUser(api, 'admin@example.com');
    await (await prisma()).user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
    const a = await uploadMedia(api, fake, ann);
    const bob = await makeUser(api, 'bob@example.com');
    const b = await uploadMedia(api, fake, bob);
    expect((await api.call('POST', `/api/v1/admin/media/${a.id}/remove`, {}, admin.token)).status).toBe(204);
    expect((await api.call('POST', '/api/v1/users/me/delete', { password: PASSWORD }, bob.token)).status).toBe(204);
    for (const id of [a.id, b.id]) expect(await row(id)).toMatchObject({ status: 'DELETING', straySweepsLeft: 0, straySweepAt: null });
    expect(await run()).toMatchObject({ deleted: 2, swept: 0 });
  });

  it('a sweep that races a deletion cannot resurrect or change the item: its updates are conditional on the READY step', async () => {
    const { id } = await uploadMedia(api, fake, ann);
    const { storage } = await (await import('./helpers/media')).cloud();
    // while the sweep talks to the provider the user deletes the item
    vi.spyOn(storage, 'destroy').mockImplementation(async () => {
      await api.call('DELETE', `${MEDIA}/${id}`, undefined, ann.token);
      return 'not_found';
    });
    const result = await run();
    expect(result.swept).toBe(0); // the READY step no longer exists: the advance matched nothing
    expect(await row(id)).toMatchObject({ status: 'DELETING', straySweepsLeft: 0, url: null });
  });
});

describe('a deleted row is kept until the upload window has closed (a still-valid signature cannot create an asset that has no row)', () => {
  /** The real default: hold the row for 70 minutes after its slot was created (the tests' helper defaults to no hold). */
  const production = { holdMinutes: undefined };

  it('delete a fresh slot, run the worker: the files are removed but the row is KEPT hidden; a LATE upload with the same signature is removed by the sweep after the window, then the row goes', async () => {
    const slot = await requestSlot(api, ann);
    const id = slot.body.media.id as string;
    const key = await keyOf(id);
    expect((await api.call('DELETE', `${MEDIA}/${id}`, undefined, ann.token)).status).toBe(204);

    fake.destroyCalls.length = 0;
    expect(await run(production)).toMatchObject({ held: 1, deleted: 0 });
    expect(fake.destroyCalls.map((c) => c.type)).toEqual(['image', 'video', 'raw']);
    const held = await row(id); // still there, hidden, with the provider's answer recorded as a finished attempt
    expect(held).toMatchObject({ status: 'DELETING', url: null, deletionAttempts: 0, lastDeletionError: null, deletionClaimId: null });
    const dueIn = held.nextDeletionAt!.getTime() - held.createdAt.getTime();
    expect(dueIn).toBeGreaterThan(69 * MIN);
    expect(dueIn).toBeLessThan(71 * MIN);

    // the client, still holding a valid signature, uploads AFTER the first sweep
    stray(key, 'raw');
    fake.put(key, 'image', photoAsset(key));
    fake.destroyCalls.length = 0;
    expect(await run(production)).toMatchObject({ held: 0, deleted: 0 }); // not due: the window is still open
    expect(fake.destroyCalls).toEqual([]);
    expect(keys()).toHaveLength(2);

    // the window closes
    await asIfTimePassed(`UPDATE media_item SET created_at = created_at - interval '71 minutes', next_deletion_at = now() - interval '1 second' WHERE id = $1::uuid`, id);
    expect(await run(production)).toMatchObject({ held: 0, deleted: 1 });
    expect(fake.objects.size).toBe(0); // the late upload is gone, in every namespace
    expect(await (await prisma()).mediaItem.count({ where: { id } })).toBe(0); // and only now the row
  });

  it('a failed confirmation is held the same way (the client may upload again with the same signature)', async () => {
    const slot = await requestSlot(api, ann);
    const id = slot.body.media.id as string;
    const key = await keyOf(id);
    fake.put(key, 'image', photoAsset(key, { bytes: 11 * 1024 * 1024 }));
    expect((await confirm(api, ann, id)).status).toBe(422); // too large -> DELETING
    expect(await run(production)).toMatchObject({ held: 1, deleted: 0 });
    expect(fake.objects.size).toBe(0);
    expect((await row(id)).status).toBe('DELETING');
  });

  it('a row older than the window is not held (the signature is long dead): the row goes at once', async () => {
    const { id } = await uploadMedia(api, fake, ann);
    await api.call('DELETE', `${MEDIA}/${id}`, undefined, ann.token);
    await asIfTimePassed(`UPDATE media_item SET created_at = created_at - interval '2 hours' WHERE id = $1::uuid`, id);
    expect(await run(production)).toMatchObject({ held: 0, deleted: 1 });
    expect(await (await prisma()).mediaItem.count({ where: { id } })).toBe(0);
  });

  it('a provider failure is a retry, not a hold; the hold applies only after a successful sweep', async () => {
    const slot = await requestSlot(api, ann);
    const id = slot.body.media.id as string;
    await api.call('DELETE', `${MEDIA}/${id}`, undefined, ann.token);
    fake.failDestroy(() => new fake.StorageError('down', 'TRANSIENT', 'NETWORK'));
    expect(await run(production)).toMatchObject({ held: 0, retried: 1 });
    expect(await row(id)).toMatchObject({ deletionAttempts: 1, lastDeletionError: 'NETWORK' });
    fake.failDestroy(null);
    await asIfTimePassed(`UPDATE media_item SET next_deletion_at = now() - interval '1 second' WHERE id = $1::uuid`, id);
    expect(await run(production)).toMatchObject({ held: 1 });
  });

  it('the stats do not count a held row as stuck (it is hidden and waiting on purpose)', async () => {
    const admin = await makeUser(api, 'admin@example.com');
    await (await prisma()).user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
    const slot = await requestSlot(api, ann);
    await api.call('DELETE', `${MEDIA}/${slot.body.media.id}`, undefined, ann.token);
    await run(production);
    expect((await api.call('GET', '/api/v1/admin/stats', undefined, admin.token)).body.mediaDeletionStuck).toBe(0);
  });
});

describe('items that exist before the migration (backfill)', () => {
  const migration = readFileSync(join(__dirname, '..', 'prisma', 'migrations', '20261125000100_media_stray_sweep', 'migration.sql'), 'utf8');
  const backfill = migration.slice(migration.indexOf('UPDATE media_item\n   SET stray_sweeps_left = CASE'));
  const ready = { status: 'READY', url: 'https://res.cloudinary.com/x/a', confirmedAt: new Date(), sizeBytes: 1n };

  it('the migration file really contains the backfill statement (so this test runs the real SQL)', () => {
    expect(backfill.startsWith('UPDATE media_item')).toBe(true);
    expect(backfill).toContain("WHERE status = 'READY' AND stray_sweeps_left = 0");
  });

  it('schedules READY items by age (3 / 2 / 1 sweeps), leaves other statuses alone, and the worker does only what each needs', async () => {
    const userId = ann.userId;
    const young = await insertRow({ ownerUserId: userId, uploadedById: userId, ...ready });
    const middle = await insertRow({ ownerUserId: userId, uploadedById: userId, ...ready });
    const old = await insertRow({ ownerUserId: userId, uploadedById: userId, ...ready });
    const pending = await insertRow({ ownerUserId: userId, uploadedById: userId });
    await asIfTimePassed(`UPDATE media_item SET created_at = now() - interval '3 hours' WHERE id = $1::uuid`, middle);
    await asIfTimePassed(`UPDATE media_item SET created_at = now() - interval '30 hours' WHERE id = $1::uuid`, old);
    expect((await row(old)).straySweepsLeft).toBe(0); // as if it had been confirmed before the migration

    expect(await raw(backfill)).toBe(3);
    expect(await Promise.all([young, middle, old].map(async (i) => (await row(i)).straySweepsLeft))).toEqual([3, 2, 1]);
    expect((await row(pending)).straySweepsLeft).toBe(0);
    for (const i of [young, middle, old]) expect((await row(i)).straySweepAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // each item gets exactly the sweeps it still needs: one pass handles all three (bounded: at most 10 per pass)
    fake.destroyCalls.length = 0;
    expect(await run()).toMatchObject({ swept: 3, sweepRetried: 0 });
    expect(await Promise.all([young, middle, old].map(async (i) => (await row(i)).straySweepsLeft))).toEqual([2, 1, 0]);
    expect(fake.destroyCalls).toHaveLength(6); // 3 items x 2 namespaces
    expect((await row(old)).straySweepAt).toBeNull(); // the old one is finished after a single sweep
    // a second pass finds nothing due (the young item's next sweep is 70 min after its slot, the middle one's a day after)
    fake.destroyCalls.length = 0;
    expect(await run()).toMatchObject({ swept: 0 });
    expect(fake.destroyCalls).toEqual([]);
  });

  it('running the backfill again changes nothing for items that already have a schedule', async () => {
    const { id } = await uploadMedia(api, fake, ann);
    const before = await row(id);
    expect(await raw(backfill)).toBe(0);
    expect((await row(id)).straySweepAt!.getTime()).toBe(before.straySweepAt!.getTime());
  });
});

describe('database rules for the sweep columns (chk_media_stray_shape, fym_media_guard)', () => {
  let userId: string;
  beforeEach(async () => {
    userId = ann.userId;
  });
  const ready = { status: 'READY', url: 'https://res.cloudinary.com/x/a', confirmedAt: new Date(), sizeBytes: 1n };

  it('a sweep exists only for a READY item, has a due time, and has 0 to 3 steps; with none left the bookkeeping is empty', async () => {
    for (const left of [1, 2, 3]) await expect(insertRow({ ownerUserId: userId, uploadedById: userId, ...ready, straySweepsLeft: left, straySweepAt: new Date() })).resolves.toBeTruthy();
    await expect(insertRow({ ownerUserId: userId, uploadedById: userId, ...ready, straySweepsLeft: 1, straySweepAt: null })).rejects.toThrow(/chk_media_stray_shape/);
    await expect(insertRow({ ownerUserId: userId, uploadedById: userId, ...ready, straySweepsLeft: 4, straySweepAt: new Date() })).rejects.toThrow(/chk_media_stray_shape/);
    await expect(insertRow({ ownerUserId: userId, uploadedById: userId, straySweepsLeft: 1, straySweepAt: new Date() })).rejects.toThrow(/chk_media_stray_shape/); // PENDING
    await expect(insertRow({ ownerUserId: userId, uploadedById: userId, ...ready, straySweepsLeft: 0, straySweepAt: new Date() })).rejects.toThrow(/chk_media_stray_shape/);
    await expect(insertRow({ ownerUserId: userId, uploadedById: userId, ...ready, straySweepsLeft: 0, lastStrayError: 'x' })).rejects.toThrow(/chk_media_stray_shape/);
    await expect(insertRow({ ownerUserId: userId, uploadedById: userId, ...ready, straySweepsLeft: 0, straySweepAttempts: 2 })).rejects.toThrow(/chk_media_stray_shape/);
  });

  it('a READY item may change its sweep columns (and caption / order) but nothing else; DELETING takes no sweep', async () => {
    const id = await insertRow({ ownerUserId: userId, uploadedById: userId, ...ready, straySweepsLeft: 3, straySweepAt: new Date() });
    await expect(raw(`UPDATE media_item SET stray_sweeps_left = 1, stray_sweep_at = now(), stray_sweep_attempts = 3, last_stray_error = 'E' WHERE id = $1::uuid`, id)).resolves.toBe(1);
    await expect(raw(`UPDATE media_item SET url = 'https://evil.test/x' WHERE id = $1::uuid`, id)).rejects.toThrow(/FYM_MEDIA_IMMUTABLE/);
    await expect(raw(`UPDATE media_item SET status = 'DELETING', url = NULL, deleting_since = now(), next_deletion_at = now() WHERE id = $1::uuid`, id)).rejects.toThrow(/chk_media_stray_shape/); // must clear the sweep
    await expect(
      raw(`UPDATE media_item SET status = 'DELETING', url = NULL, deleting_since = now(), next_deletion_at = now(), stray_sweeps_left = 0, stray_sweep_at = NULL, stray_sweep_attempts = 0, last_stray_error = NULL WHERE id = $1::uuid`, id),
    ).resolves.toBe(1);
  });
});
