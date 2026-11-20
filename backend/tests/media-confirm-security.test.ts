import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyAsset } from '../src/modules/media/media.service';
import { resetDb, startApp } from './helpers/client';
import { asIfTimePassed, confirm, fakeStorage, keyOf, photoAsset, prismaP, requestSlot, videoAsset, worker, type FakeStorage } from './helpers/media';
import { makeUser, type TestUser } from './helpers/users';

/*
 * The Cloudinary upload signature does NOT cover the resource type (it is part of the upload URL), and a `raw` upload is stored under "<key>.<extension>".
 * So a client can put a file under a resource type other than the expected one. These tests pin down the mitigation:
 *   1. the server validates the real resource type (confirmation asks for the EXPECTED type only);
 *   2. a file under an unexpected type never becomes READY and leaves no orphan: the row goes DELETING, and
 *   3. the worker deletes the object under EVERY resource type (so it is found wherever it was put);
 *   4. confirmation never trusts client-provided metadata (verifyAsset uses only the provider's description and the server-chosen key);
 *   5. a failed confirmation ends in DELETING and the cleanup stays retryable.
 */

let api: Awaited<ReturnType<typeof startApp>>;
let fake: FakeStorage;
let ann: TestUser;

const state = async (id: string) => (await (await prismaP()).mediaItem.findUnique({ where: { id } })) ?? null;

async function slot(over: Record<string, unknown> = {}) {
  const res = await requestSlot(api, ann, over);
  const id = res.body.media.id as string;
  return { id, key: await keyOf(id) };
}

beforeAll(async () => {
  api = await startApp();
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

describe('a file stored under an unexpected resource type', () => {
  it.each([
    ['a photo slot, file stored as raw', 'image/jpeg', 'raw'],
    ['a photo slot, file stored as video', 'image/jpeg', 'video'],
    ['a video slot, file stored as image', 'video/mp4', 'image'],
    ['a video slot, file stored as raw', 'video/mp4', 'raw'],
  ] as const)('%s: rejected (422), never published, marked DELETING, and the worker removes it from wherever it was put', async (_name, mimeType, storedAs) => {
    const { id, key } = await slot({ mimeType, sizeBytes: 1000 });
    // the client used the signature against another resource type; for raw the provider stores it as "<key>.<ext>"
    const storedKey = storedAs === 'raw' ? `${key}.png` : key;
    fake.put(storedKey, storedAs, photoAsset(storedKey, { resourceType: storedAs }));

    const res = await confirm(api, ann, id);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'MEDIA_REJECTED', details: { reason: 'NOT_FOUND' } });
    // ONLY the expected namespace was asked, and with the server's key (never anything the client could influence)
    expect(fake.describeCalls).toEqual([{ key, type: mimeType.startsWith('image') ? 'image' : 'video' }]);
    const row = await state(id);
    expect(row).toMatchObject({ status: 'DELETING', url: null, thumbnailUrl: null });
    expect(row!.nextDeletionAt).not.toBeNull();

    // the stray is still at the provider until the worker runs: nothing is orphaned because the row is kept
    expect(fake.objects.has(`${storedAs}:${storedKey}`)).toBe(true);
    const result = await (await worker()).runMediaWorkerOnce();
    expect(result).toMatchObject({ deleted: 1, retried: 0 });
    expect(fake.objects.size).toBe(0);
    expect(await state(id)).toBeNull(); // the row goes only after the provider answered
  });

  it('the worker tries EVERY resource type for a key (image, video, raw), whatever the row announced', async () => {
    const { id, key } = await slot();
    await (await prismaP()).$executeRawUnsafe(`UPDATE media_item SET status = 'DELETING', deleting_since = now(), next_deletion_at = now() WHERE id = $1::uuid`, id);
    await (await worker()).runMediaWorkerOnce();
    expect(fake.destroyCalls).toEqual([
      { key, type: 'image' },
      { key, type: 'video' },
      { key, type: 'raw' },
    ]);
  });

  it('a stray that is READY-looking under another type does not turn a rejected slot into a published item', async () => {
    const { id, key } = await slot();
    fake.put(`${key}.png`, 'raw', photoAsset(`${key}.png`, { resourceType: 'raw' }));
    expect((await confirm(api, ann, id)).status).toBe(422);
    expect((await confirm(api, ann, id)).status).toBe(404); // DELETING: gone for the client
    expect(await (await prismaP()).mediaItem.count({ where: { status: 'READY' } })).toBe(0);
  });
});

describe('verifyAsset: what the provider reports decides, nothing else', () => {
  const photo = { kind: 'PHOTO' as const, storageKey: 'fym/media/p1' };
  const video = { kind: 'VIDEO' as const, storageKey: 'fym/media/v1' };
  const ok = (r: ReturnType<typeof verifyAsset>) => r.ok;
  const reason = (r: ReturnType<typeof verifyAsset>) => (r.ok ? null : r.reason);

  it('accepts a well-formed photo and video and reports the verified values', () => {
    expect(verifyAsset(photo, photoAsset(photo.storageKey, { format: 'heic', bytes: 9_000_000 }))).toMatchObject({ ok: true, mimeType: 'image/heic', sizeBytes: 9_000_000 });
    expect(verifyAsset(video, videoAsset(video.storageKey, { format: 'mov', durationSec: 59.99 }))).toMatchObject({ ok: true, mimeType: 'video/quicktime', durationMs: 59_990 });
  });

  it.each([
    ['nothing at the provider', () => null, 'NOT_FOUND'],
    ['another resource type', () => photoAsset(photo.storageKey, { resourceType: 'raw' }), 'WRONG_RESOURCE_TYPE'],
    ['a private / authenticated asset', () => photoAsset(photo.storageKey, { deliveryType: 'private' }), 'WRONG_DELIVERY_TYPE'],
    ["another upload's asset (different public id)", () => photoAsset('fym/media/someone-else'), 'WRONG_PUBLIC_ID'],
    ['an unsupported format', () => photoAsset(photo.storageKey, { format: 'gif' }), 'UNSUPPORTED_FORMAT'],
    ['a video format for a photo slot', () => photoAsset(photo.storageKey, { format: 'mp4' }), 'FORMAT_KIND_MISMATCH'],
    ['a photo above 10 MiB', () => photoAsset(photo.storageKey, { bytes: 10 * 1024 * 1024 + 1 }), 'TOO_LARGE'],
    ['zero bytes', () => photoAsset(photo.storageKey, { bytes: 0 }), 'MISSING_METADATA'],
    ['no version', () => photoAsset(photo.storageKey, { version: 0 }), 'MISSING_METADATA'],
    ['a photo without dimensions', () => photoAsset(photo.storageKey, { width: null }), 'MISSING_METADATA'],
  ])('rejects %s', (_n, make, expected) => {
    expect(reason(verifyAsset(photo, make()))).toBe(expected);
  });

  it.each([
    ['a video above 100 MiB', () => videoAsset(video.storageKey, { bytes: 100 * 1024 * 1024 + 1 }), 'TOO_LARGE'],
    ['a video above 60 s', () => videoAsset(video.storageKey, { durationSec: 60.01 }), 'TOO_LONG'],
    ['a video without a duration', () => videoAsset(video.storageKey, { durationSec: null }), 'MISSING_METADATA'],
    ['a zero-length video', () => videoAsset(video.storageKey, { durationSec: 0 }), 'MISSING_METADATA'],
    ['a photo format for a video slot', () => videoAsset(video.storageKey, { format: 'png' }), 'FORMAT_KIND_MISMATCH'],
    ['a video stored as an image', () => videoAsset(video.storageKey, { resourceType: 'image' }), 'WRONG_RESOURCE_TYPE'],
  ])('rejects %s', (_n, make, expected) => {
    expect(reason(verifyAsset(video, make()))).toBe(expected);
  });

  it('accepts exactly the limits (10 MiB, 100 MiB, 60 s)', () => {
    expect(ok(verifyAsset(photo, photoAsset(photo.storageKey, { bytes: 10 * 1024 * 1024 })))).toBe(true);
    expect(ok(verifyAsset(video, videoAsset(video.storageKey, { bytes: 100 * 1024 * 1024, durationSec: 60 })))).toBe(true);
  });
});

describe('failed confirmations through the API', () => {
  it.each([
    ['too large', { bytes: 10 * 1024 * 1024 + 1 }, 'TOO_LARGE'],
    ['an unsupported format', { format: 'gif' }, 'UNSUPPORTED_FORMAT'],
    ["someone else's asset (wrong public id)", { publicId: 'fym/media/another-slot' }, 'WRONG_PUBLIC_ID'],
  ])('%s: 422, the row is DELETING with no URL, and nothing is published', async (_n, asset, expected) => {
    const { id, key } = await slot();
    fake.put(key, 'image', photoAsset(key, asset));
    const res = await confirm(api, ann, id, { sizeBytes: 100, mimeType: 'image/jpeg' }); // the client's claims change nothing
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe(expected);
    expect(await state(id)).toMatchObject({ status: 'DELETING', url: null });
  });

  it('a video that is too long fails the same way', async () => {
    const { id, key } = await slot({ mimeType: 'video/mp4', sizeBytes: 1000 });
    fake.put(key, 'video', videoAsset(key, { durationSec: 75 }));
    const res = await confirm(api, ann, id);
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('TOO_LONG');
    expect((await state(id))!.status).toBe('DELETING');
  });

  it('cannot confirm ANOTHER user\'s slot, even knowing its id: the row does not exist for anyone but the uploader', async () => {
    const mallory = await makeUser(api, 'mallory@example.com');
    const { id, key } = await slot();
    fake.put(key, 'image', photoAsset(key));
    expect((await confirm(api, mallory, id)).status).toBe(404);
    expect(fake.describeCalls).toEqual([]); // the provider was not even asked
    expect((await state(id))!.status).toBe('PENDING'); // and the rightful uploader's slot is untouched
    expect((await confirm(api, ann, id)).status).toBe(200);
  });

  it('cannot publish an asset by pointing at another slot\'s file: the answer must carry THIS row\'s key', async () => {
    const a = await slot();
    const b = await slot();
    // the provider (wrongly) answers slot A's request with slot B's asset
    fake.put(a.key, 'image', photoAsset(b.key));
    const res = await confirm(api, ann, a.id);
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('WRONG_PUBLIC_ID');
  });
});

describe('the cleanup of a failed confirmation stays retryable', () => {
  it('a provider failure leaves the row DELETING and hidden; it is retried with backoff and removed only after the provider confirms', async () => {
    const { runMediaWorkerOnce } = await worker();
    const { id, key } = await slot();
    fake.put(key, 'image', photoAsset(key, { bytes: 11 * 1024 * 1024 }));
    expect((await confirm(api, ann, id)).status).toBe(422);

    fake.failDestroy(() => new fake.StorageError('provider unavailable', 'TRANSIENT', 'HTTP_503'));
    expect(await runMediaWorkerOnce()).toMatchObject({ deleted: 0, retried: 1 });
    let row = (await state(id))!;
    expect(row).toMatchObject({ status: 'DELETING', deletionAttempts: 1, lastDeletionError: 'HTTP_503', deletionClaimId: null, url: null });
    expect(row.nextDeletionAt!.getTime()).toBeGreaterThan(Date.now() + 30_000); // backoff: not due again at once
    expect(await runMediaWorkerOnce()).toMatchObject({ deleted: 0, retried: 0 }); // not due: untouched
    expect(fake.objects.size).toBe(1); // the file is still at the provider, and the row still knows its key

    await asIfTimePassed(`UPDATE media_item SET next_deletion_at = now() - interval '1 second' WHERE id = $1::uuid`, id);
    fake.failDestroy(null);
    expect(await runMediaWorkerOnce()).toMatchObject({ deleted: 1, retried: 0 });
    expect(fake.objects.size).toBe(0);
    expect(await state(id)).toBeNull();
  });
});
