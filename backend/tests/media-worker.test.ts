import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from './helpers/client';
import { asIfTimePassed, cloud, fakeStorage, insertRow, photoAsset, prismaP, worker, type FakeStorage } from './helpers/media';

/*
 * The media deletion worker (jobs/media-worker.ts): hides nothing and decides nothing about people, it only removes files at the provider and then
 * their rows. Claims, leases, retries with backoff, "already gone" as success, stale uploads, several workers at once.
 */

let fake: FakeStorage;
let userId: string;

async function deletingRow(over: Record<string, unknown> = {}) {
  return insertRow({ ownerUserId: userId, uploadedById: userId, status: 'DELETING', deletingSince: new Date(), nextDeletionAt: new Date(Date.now() - 1000), ...over });
}
const row = async (id: string) => (await (await prismaP()).mediaItem.findUnique({ where: { id } })) ?? null;
const dueAgain = (id: string) => asIfTimePassed(`UPDATE media_item SET next_deletion_at = now() - interval '1 second' WHERE id = $1::uuid`, id);

beforeAll(async () => {
  await resetDb();
});
afterAll(async () => {
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
  fake = await fakeStorage();
  userId = (await (await prismaP()).user.create({ data: { email: 'w@example.com', passwordHash: 'x', fullName: 'W' } })).id;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('deleting files', () => {
  it('deletes the file under every resource type, then the row; "not found" at the provider counts as deleted (idempotent)', async () => {
    const { runMediaWorkerOnce } = await worker();
    const id = await deletingRow();
    const key = (await row(id))!.storageKey;
    fake.put(key, 'image', photoAsset(key));
    expect(await runMediaWorkerOnce()).toEqual({ expired: 0, deleted: 1, held: 0, retried: 0, lostClaim: 0, swept: 0, sweepRetried: 0 });
    expect(fake.objects.size).toBe(0);
    expect(await row(id)).toBeNull();

    // a row whose file is already gone (an earlier attempt, or never uploaded) is simply finished
    const gone = await deletingRow();
    expect(await runMediaWorkerOnce()).toMatchObject({ deleted: 1 });
    expect(await row(gone)).toBeNull();
    expect(await runMediaWorkerOnce()).toEqual({ expired: 0, deleted: 0, held: 0, retried: 0, lostClaim: 0, swept: 0, sweepRetried: 0 }); // nothing left: idempotent
  });

  it('never touches a row that is not DELETING, and not one that is not due yet', async () => {
    const { runMediaWorkerOnce } = await worker();
    const pending = await insertRow({ ownerUserId: userId, uploadedById: userId });
    const ready = await insertRow({
      ownerUserId: userId,
      uploadedById: userId,
      status: 'READY',
      url: 'https://res.cloudinary.com/x/a',
      confirmedAt: new Date(),
      sizeBytes: 1n,
    });
    const later = await deletingRow({ nextDeletionAt: new Date(Date.now() + 3_600_000) });
    expect(await runMediaWorkerOnce()).toMatchObject({ deleted: 0, retried: 0, expired: 0 });
    expect(await row(pending)).not.toBeNull();
    expect(await row(ready)).not.toBeNull();
    expect(await row(later)).not.toBeNull();
    expect(fake.destroyCalls).toEqual([]);
  });

  it('a failure on ANY resource type keeps the row and retries with growing delays; the next success finishes it', async () => {
    const { runMediaWorkerOnce, BACKOFF_MS } = await worker();
    const id = await deletingRow();
    fake.failDestroy((_k, type) => (type === 'video' ? new fake.StorageError('timeout', 'TRANSIENT', 'NETWORK') : null));
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      await dueAgain(id);
      expect(await runMediaWorkerOnce()).toMatchObject({ retried: 1, deleted: 0 });
      const r = (await row(id))!;
      expect(r).toMatchObject({ status: 'DELETING', deletionAttempts: attempt, lastDeletionError: 'NETWORK', deletionClaimId: null, deletionLeaseUntil: null });
      delays.push(r.nextDeletionAt!.getTime() - Date.now());
    }
    // roughly 1 min, 5 min, 30 min, 2 h (each jittered by +-20%): strictly growing
    delays.forEach((d, i) => {
      expect(d).toBeGreaterThan(BACKOFF_MS[i]! * 0.75);
      expect(d).toBeLessThan(BACKOFF_MS[i]! * 1.25);
    });
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    fake.failDestroy(null);
    await dueAgain(id);
    expect(await runMediaWorkerOnce()).toMatchObject({ deleted: 1 });
    expect(await row(id)).toBeNull();
  });

  it('the delay stops growing at 12 hours: the row is never abandoned', async () => {
    const { backoffMs } = await worker();
    const h12 = 12 * 3_600_000;
    for (const attempt of [6, 7, 20, 500]) {
      const d = backoffMs(attempt, () => 0.5);
      expect(d).toBe(h12);
    }
    expect(backoffMs(1, () => 0)).toBe(48_000); // 60 s - 20%
    expect(backoffMs(1, () => 1)).toBe(72_000); // 60 s + 20%
  });

  it('bad credentials push the row 30 minutes out (no hammering); a missing configuration, an hour', async () => {
    const { runMediaWorkerOnce } = await worker();
    const a = await deletingRow();
    fake.failDestroy(() => new fake.StorageError('refused', 'AUTH', 'HTTP_401'));
    await runMediaWorkerOnce();
    const ra = (await row(a))!;
    expect(ra.lastDeletionError).toBe('HTTP_401');
    expect(ra.nextDeletionAt!.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);

    const b = await deletingRow();
    fake.failDestroy(() => new fake.StorageError('no config', 'NOT_CONFIGURED', 'NOT_CONFIGURED'));
    await runMediaWorkerOnce();
    expect((await row(b))!.nextDeletionAt!.getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
  });

  it('an unexpected error (not a provider error) is a retry too, never a lost row', async () => {
    const { runMediaWorkerOnce } = await worker();
    const id = await deletingRow();
    fake.failDestroy(() => new Error('boom'));
    expect(await runMediaWorkerOnce()).toMatchObject({ retried: 1 });
    expect(await row(id)).toMatchObject({ status: 'DELETING', lastDeletionError: 'UNEXPECTED' });
  });
});

describe('several workers and crashed workers', () => {
  it('two workers at the same time never delete or call the provider twice for one row (claims use SKIP LOCKED)', async () => {
    const { runMediaWorkerOnce } = await worker();
    const ids = [await deletingRow(), await deletingRow(), await deletingRow(), await deletingRow()];
    const results = await Promise.all([runMediaWorkerOnce(), runMediaWorkerOnce(), runMediaWorkerOnce()]);
    expect(results.reduce((n, r) => n + r.deleted, 0)).toBe(4);
    expect(results.reduce((n, r) => n + r.lostClaim, 0)).toBe(0);
    for (const id of ids) expect(await row(id)).toBeNull();
    // each of the 4 rows was destroyed under 3 resource types exactly once
    expect(fake.destroyCalls).toHaveLength(12);
    expect(new Set(fake.destroyCalls.map((c) => `${c.type}:${c.key}`)).size).toBe(12);
  });

  it('a row claimed by a worker that died is taken over once its lease has expired, and not before', async () => {
    const { runMediaWorkerOnce } = await worker();
    const id = await deletingRow();
    const prisma = await prismaP();
    // a dead worker's claim, lease still valid: nobody else touches the row
    await prisma.$executeRawUnsafe(`UPDATE media_item SET deletion_claim_id = gen_random_uuid(), deletion_lease_until = now() + interval '2 minutes', deletion_attempts = 1 WHERE id = $1::uuid`, id);
    expect(await runMediaWorkerOnce()).toMatchObject({ deleted: 0 });
    expect(await row(id)).not.toBeNull();
    // lease expired: the next worker takes over, counts the attempt and finishes
    await prisma.$executeRawUnsafe(`UPDATE media_item SET deletion_lease_until = now() - interval '1 second' WHERE id = $1::uuid`, id);
    expect(await runMediaWorkerOnce()).toMatchObject({ deleted: 1 });
    expect(await row(id)).toBeNull();
  });

  it('a result is recorded only while the claim is still ours: a worker whose lease was taken over cannot delete or reschedule the row', async () => {
    const { runMediaWorkerOnce } = await worker();
    const id = await deletingRow();
    const prisma = await prismaP();
    // while "our" worker talks to the provider, another worker takes the row over (a new claim id) - the provider call itself succeeds
    const { storage } = await cloud();
    vi.spyOn(storage, 'destroy').mockImplementation(async () => {
      await prisma.$executeRawUnsafe(`UPDATE media_item SET deletion_claim_id = gen_random_uuid() WHERE id = '${id}'`);
      return 'not_found';
    });
    const result = await runMediaWorkerOnce();
    expect(result).toMatchObject({ deleted: 0, lostClaim: 1, retried: 0 });
    expect(await row(id)).toMatchObject({ status: 'DELETING' }); // untouched by the worker that lost the claim; the new owner finishes it

    // and the same for a FAILED attempt: it cannot reschedule a row it no longer owns
    const id2 = await deletingRow();
    vi.spyOn(storage, 'destroy').mockImplementation(async () => {
      await prisma.$executeRawUnsafe(`UPDATE media_item SET deletion_claim_id = gen_random_uuid() WHERE id = '${id2}'`);
      throw new fake.StorageError('timeout', 'TRANSIENT', 'NETWORK');
    });
    expect(await runMediaWorkerOnce()).toMatchObject({ deleted: 0, lostClaim: 1, retried: 0 });
    expect((await row(id2))!.lastDeletionError).toBeNull();
  });
});

describe('uploads that were never confirmed', () => {
  it('a PENDING slot older than the TTL (signature lifetime + grace) becomes DELETING and is then cleaned up like any other; fresh ones are left alone', async () => {
    const { runMediaWorkerOnce, PENDING_TTL_MINUTES } = await worker();
    const stale = await insertRow({ ownerUserId: userId, uploadedById: userId });
    const fresh = await insertRow({ ownerUserId: userId, uploadedById: userId });
    await asIfTimePassed(`UPDATE media_item SET created_at = now() - make_interval(mins => $2::int) WHERE id = $1::uuid`, stale, PENDING_TTL_MINUTES + 1);
    // the client did upload the file but never confirmed
    const key = (await row(stale))!.storageKey;
    fake.put(key, 'image', photoAsset(key));

    const first = await runMediaWorkerOnce();
    expect(first).toMatchObject({ expired: 1, deleted: 1 }); // expired and, in the same pass, deleted at the provider
    expect(fake.objects.size).toBe(0);
    expect(await row(stale)).toBeNull();
    expect(await row(fresh)).toMatchObject({ status: 'PENDING' });
    expect(PENDING_TTL_MINUTES).toBeGreaterThanOrEqual(60); // never shorter than the one-hour signature lifetime
    expect(await runMediaWorkerOnce()).toMatchObject({ expired: 0, deleted: 0 });
  });

  it('a slot just inside the TTL is not touched', async () => {
    const { runMediaWorkerOnce, PENDING_TTL_MINUTES } = await worker();
    const id = await insertRow({ ownerUserId: userId, uploadedById: userId });
    await asIfTimePassed(`UPDATE media_item SET created_at = now() - make_interval(mins => $2::int) WHERE id = $1::uuid`, id, PENDING_TTL_MINUTES - 5);
    expect(await runMediaWorkerOnce()).toMatchObject({ expired: 0 });
    expect((await row(id))!.status).toBe('PENDING');
  });

  it('a stale slot with a confirmation in flight is skipped (locked rows are not waited for) and picked up on the next pass', async () => {
    const { runMediaWorkerOnce, PENDING_TTL_MINUTES } = await worker();
    const prisma = await prismaP();
    const id = await insertRow({ ownerUserId: userId, uploadedById: userId });
    await asIfTimePassed(`UPDATE media_item SET created_at = now() - make_interval(mins => $2::int) WHERE id = $1::uuid`, id, PENDING_TTL_MINUTES + 1);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const confirming = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM media_item WHERE id = ${id}::uuid FOR UPDATE`;
        entered();
        await hold;
      },
      { timeout: 30_000 },
    );
    await inside;
    expect(await runMediaWorkerOnce()).toMatchObject({ expired: 0 }); // not blocked, not expired
    release();
    await confirming;
    expect(await runMediaWorkerOnce()).toMatchObject({ expired: 1, deleted: 1 });
  });
});
