import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { cloud, confirm, fakeStorage, insertRow, keyOf, MEDIA, photoAsset, prismaP, requestSlot, uploadMedia, videoAsset, type FakeStorage } from './helpers/media';
import { makeUser, type TestUser } from './helpers/users';

/*
 * The upload lifecycle through the API: slot (signed parameters) -> the client uploads to the provider -> confirm (the server verifies the file
 * with the provider and only then publishes it). The provider is replaced by a fake (tests/helpers/media.ts); signing is the real code.
 */

let api: Awaited<ReturnType<typeof startApp>>;
let fake: FakeStorage;
let ann: TestUser;

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

describe('asking for an upload slot', () => {
  it('creates a PENDING row with a SERVER-chosen key and returns signed parameters; nothing is visible yet', async () => {
    const res = await requestSlot(api, ann, { caption: '  First goal  ' });
    expect(res.status).toBe(201);
    const { media, upload } = res.body;
    expect(media).toMatchObject({ kind: 'PHOTO', status: 'PENDING', url: null, thumbnailUrl: null, caption: 'First goal', owner: { type: 'PLAYER', userId: ann.userId } });
    const key = await keyOf(media.id);
    expect(key).toBe(`fym/media/${media.id}`);

    expect(upload.method).toBe('POST');
    expect(upload.url).toBe('https://api.cloudinary.com/v1_1/test-cloud/image/upload');
    expect(upload.fields).toMatchObject({ public_id: key, allowed_formats: 'jpg,jpeg,png,webp,heic', overwrite: 'false', type: 'upload', api_key: 'test-api-key' });
    expect(upload.fields).not.toHaveProperty('resource_type'); // part of the URL, not of the signature
    expect(new Date(upload.expiresAt).getTime() - Date.now()).toBeGreaterThan(55 * 60_000);

    // the signature is exactly what Cloudinary will recompute: SHA-1 over the sorted signed fields + the secret
    const { signParams } = await cloud();
    const { api_key, signature, ...signed } = upload.fields;
    expect(api_key).toBe('test-api-key');
    expect(signature).toBe(signParams(signed, 'test-api-secret-0123456789'));
    expect(signature).not.toBe(signParams({ ...signed, public_id: 'fym/media/other' }, 'test-api-secret-0123456789')); // a different key would not verify

    // not in any list until it is confirmed
    expect((await api.call('GET', `/api/v1/players/${ann.userId}/media`, undefined, ann.token)).body.media).toEqual([]);
  });

  it('a video slot is signed for the video resource type and the video formats only', async () => {
    const res = await requestSlot(api, ann, { mimeType: 'video/quicktime', sizeBytes: 5_000_000 });
    expect(res.status).toBe(201);
    expect(res.body.media.kind).toBe('VIDEO');
    expect(res.body.upload.url).toBe('https://api.cloudinary.com/v1_1/test-cloud/video/upload');
    expect(res.body.upload.fields.allowed_formats).toBe('mp4,mov');
  });

  it.each([
    ['an unsupported type', { mimeType: 'image/gif' }, 400],
    ['a photo above 10 MB', { sizeBytes: 10 * 1024 * 1024 + 1 }, 400],
    ['a video above 100 MB', { mimeType: 'video/mp4', sizeBytes: 100 * 1024 * 1024 + 1 }, 400],
    ['a zero size', { sizeBytes: 0 }, 400],
    ['a caption above 300 characters', { caption: 'x'.repeat(301) }, 400],
    ['a team owner without a team id', { owner: { type: 'TEAM' } }, 400],
    ['an unknown owner type', { owner: { type: 'VENUE' } }, 400],
  ])('refuses %s', async (_name, over, status) => {
    expect((await requestSlot(api, ann, over)).status).toBe(status);
    expect(await (await prismaP()).mediaItem.count()).toBe(0);
  });

  it('accepts exactly the size limits (10 MB photo, 100 MB video)', async () => {
    expect((await requestSlot(api, ann, { sizeBytes: 10 * 1024 * 1024 })).status).toBe(201);
    expect((await requestSlot(api, ann, { mimeType: 'video/mp4', sizeBytes: 100 * 1024 * 1024 })).status).toBe(201);
  });

  it('needs a verified e-mail and a signed-in user', async () => {
    const raw = await makeUser(api, 'raw@example.com', { verified: false });
    expect((await requestSlot(api, raw)).body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await api.call('POST', `${MEDIA}/uploads`, { owner: { type: 'PLAYER' }, mimeType: 'image/jpeg', sizeBytes: 1000 })).status).toBe(401);
  });

  it('answers 503 MEDIA_NOT_CONFIGURED when Cloudinary credentials are missing, and creates nothing', async () => {
    const { env } = await import('../src/config/env');
    const saved = env.CLOUDINARY_API_KEY;
    env.CLOUDINARY_API_KEY = undefined;
    try {
      const res = await requestSlot(api, ann);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('MEDIA_NOT_CONFIGURED');
    } finally {
      env.CLOUDINARY_API_KEY = saved;
    }
    expect(await (await prismaP()).mediaItem.count()).toBe(0);
  });

  it('refuses with 409 MEDIA_LIMIT_REACHED at 30 items (pending ones count), and a deleted item frees a slot', async () => {
    const prisma = await prismaP();
    for (let i = 0; i < 30; i++) await insertRow({ ownerUserId: ann.userId, uploadedById: ann.userId });
    const res = await requestSlot(api, ann);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MEDIA_LIMIT_REACHED');
    const any = await prisma.mediaItem.findFirstOrThrow({ where: { ownerUserId: ann.userId } });
    expect((await api.call('DELETE', `${MEDIA}/${any.id}`, undefined, ann.token)).status).toBe(204); // PENDING -> DELETING
    expect((await requestSlot(api, ann)).status).toBe(201);
  });
});

describe('confirming an upload', () => {
  it('verifies the file with the provider, publishes it and stores what the PROVIDER reported', async () => {
    const { id, key, res } = await uploadMedia(api, fake, ann, { caption: 'Derby day', asset: { bytes: 734_003, width: 4032, height: 3024, version: 1_700_000_123 } });
    expect(res.status).toBe(200);
    expect(res.body.media).toMatchObject({
      id,
      kind: 'PHOTO',
      status: 'READY',
      mimeType: 'image/jpeg',
      sizeBytes: 734_003,
      width: 4032,
      height: 3024,
      durationMs: null,
      caption: 'Derby day',
      sortOrder: 0,
    });
    expect(res.body.media.url).toBe(`https://res.cloudinary.com/test-cloud/image/upload/c_limit,w_2048,f_auto,q_auto/v1700000123/${key}`);
    expect(res.body.media.thumbnailUrl).toContain('/image/upload/c_limit,w_480,f_auto,q_auto/');
    // the provider was asked about THIS row's key, under the expected resource type, and only that
    expect(fake.describeCalls).toEqual([{ key, type: 'image' }]);
    const row = await (await prismaP()).mediaItem.findUniqueOrThrow({ where: { id } });
    expect(row.confirmedAt).not.toBeNull();
  });

  it('publishes a video with its verified duration, an mp4 delivery URL and a poster thumbnail', async () => {
    const { key, res } = await uploadMedia(api, fake, ann, { kind: 'VIDEO', mimeType: 'video/quicktime', asset: { format: 'mov', durationSec: 42.4, bytes: 60_000_000 } });
    expect(res.status).toBe(200);
    expect(res.body.media).toMatchObject({ kind: 'VIDEO', mimeType: 'video/quicktime', durationMs: 42_400, sizeBytes: 60_000_000 });
    expect(res.body.media.url).toBe(`https://res.cloudinary.com/test-cloud/video/upload/vc_h264,q_auto/v1700000001/${key}.mp4`);
    expect(res.body.media.thumbnailUrl).toBe(`https://res.cloudinary.com/test-cloud/video/upload/so_0,c_limit,w_480,f_jpg,q_auto/v1700000001/${key}.jpg`);
  });

  it('HEIC: the original type is kept in the row, delivery goes through f_auto so phones and browsers get a compatible format', async () => {
    const { res } = await uploadMedia(api, fake, ann, { mimeType: 'image/heic', asset: { format: 'heic' } });
    expect(res.status).toBe(200);
    expect(res.body.media.mimeType).toBe('image/heic');
    expect(res.body.media.url).toContain('/image/upload/c_limit,w_2048,f_auto,q_auto/'); // never a raw .heic URL
    expect(res.body.media.url).not.toMatch(/\.heic/);
  });

  it('the stored type is the verified one, not the declared one (declared JPEG, actually PNG)', async () => {
    const { res } = await uploadMedia(api, fake, ann, { mimeType: 'image/jpeg', asset: { format: 'png' } });
    expect(res.status).toBe(200);
    expect(res.body.media.mimeType).toBe('image/png');
  });

  it('IGNORES anything the client sends when confirming: size, type, url and key come from the provider and the database', async () => {
    const slot = await requestSlot(api, ann);
    const id = slot.body.media.id as string;
    const key = await keyOf(id);
    fake.put(key, 'image', photoAsset(key, { bytes: 123_456 }));
    const res = await confirm(api, ann, id, { sizeBytes: 1, mimeType: 'image/png', url: 'https://evil.example/x.jpg', storageKey: 'fym/media/someone-else', durationMs: 5 });
    expect(res.status).toBe(200);
    expect(res.body.media).toMatchObject({ sizeBytes: 123_456, mimeType: 'image/jpeg', durationMs: null });
    expect(res.body.media.url).toContain(key);
    expect(res.body.media.url).not.toContain('evil.example');
    expect(fake.describeCalls.every((c) => c.key === key)).toBe(true);
  });

  it('is idempotent: confirming a READY item again returns it unchanged; simultaneous confirms publish it once', async () => {
    const slot = await requestSlot(api, ann);
    const id = slot.body.media.id as string;
    const key = await keyOf(id);
    fake.put(key, 'image', photoAsset(key));
    const results = await Promise.all([confirm(api, ann, id), confirm(api, ann, id), confirm(api, ann, id)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(results.map((r) => r.body.media.id)).size).toBe(1);
    expect(await (await prismaP()).mediaItem.count({ where: { status: 'READY' } })).toBe(1);
    expect((await confirm(api, ann, id)).body.media.status).toBe('READY');
  });

  it('numbers the items in the order they were confirmed', async () => {
    const a = await uploadMedia(api, fake, ann);
    const b = await uploadMedia(api, fake, ann, { kind: 'VIDEO' });
    const c = await uploadMedia(api, fake, ann);
    expect([a, b, c].map((x) => x.res.body.media.sortOrder)).toEqual([0, 1, 2]);
    const list = await api.call('GET', `/api/v1/players/${ann.userId}/media`, undefined, ann.token);
    expect(list.body.media.map((m: { id: string }) => m.id)).toEqual([a.id, b.id, c.id]);
    expect(list.body).toMatchObject({ count: 3, limit: 30 });
  });

  it('a provider that cannot answer leaves the slot PENDING (nothing is rejected or deleted) and the client can retry', async () => {
    const slot = await requestSlot(api, ann);
    const id = slot.body.media.id as string;
    const key = await keyOf(id);
    fake.put(key, 'image', photoAsset(key));
    fake.failDescribe(new fake.StorageError('rate limited', 'TRANSIENT', 'HTTP_420'));
    const res = await confirm(api, ann, id);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MEDIA_PROVIDER_UNAVAILABLE');
    expect((await (await prismaP()).mediaItem.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
    fake.failDescribe(null);
    expect((await confirm(api, ann, id)).status).toBe(200);
  });
});

describe('caption, order and deletion', () => {
  it('edits the caption and the position; an empty caption removes it; only those fields', async () => {
    const { id } = await uploadMedia(api, fake, ann, { caption: 'old' });
    const res = await api.call('PATCH', `${MEDIA}/${id}`, { caption: '  new caption  ', sortOrder: 7 }, ann.token);
    expect(res.status).toBe(200);
    expect(res.body.media).toMatchObject({ caption: 'new caption', sortOrder: 7 });
    expect((await api.call('PATCH', `${MEDIA}/${id}`, { caption: '' }, ann.token)).body.media.caption).toBeNull();
    expect((await api.call('PATCH', `${MEDIA}/${id}`, { caption: null }, ann.token)).body.media.caption).toBeNull();
    // validation
    expect((await api.call('PATCH', `${MEDIA}/${id}`, {}, ann.token)).status).toBe(400);
    expect((await api.call('PATCH', `${MEDIA}/${id}`, { caption: 'x'.repeat(301) }, ann.token)).status).toBe(400);
    expect((await api.call('PATCH', `${MEDIA}/${id}`, { sortOrder: -1 }, ann.token)).status).toBe(400);
    // an unconfirmed upload has nothing to edit yet
    const pending = (await requestSlot(api, ann)).body.media.id as string;
    expect((await api.call('PATCH', `${MEDIA}/${pending}`, { caption: 'x' }, ann.token)).body.error.code).toBe('MEDIA_NOT_READY');
  });

  it('reorders: the list follows sortOrder, ties broken by upload time', async () => {
    const a = await uploadMedia(api, fake, ann);
    const b = await uploadMedia(api, fake, ann);
    await api.call('PATCH', `${MEDIA}/${b.id}`, { sortOrder: 0 }, ann.token);
    await api.call('PATCH', `${MEDIA}/${a.id}`, { sortOrder: 5 }, ann.token);
    const list = await api.call('GET', `/api/v1/players/${ann.userId}/media`, undefined, ann.token);
    expect(list.body.media.map((m: { id: string }) => m.id)).toEqual([b.id, a.id]);
  });

  it('delete: the item disappears at once (no URL), the row waits for the worker; a second delete is 404', async () => {
    const { id } = await uploadMedia(api, fake, ann);
    expect((await api.call('DELETE', `${MEDIA}/${id}`, undefined, ann.token)).status).toBe(204);
    const row = await (await prismaP()).mediaItem.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'DELETING', url: null, thumbnailUrl: null });
    expect(row.deletingSince).not.toBeNull();
    expect((await api.call('GET', `/api/v1/players/${ann.userId}/media`, undefined, ann.token)).body.media).toEqual([]);
    expect((await api.call('DELETE', `${MEDIA}/${id}`, undefined, ann.token)).status).toBe(404);
    expect((await api.call('PATCH', `${MEDIA}/${id}`, { caption: 'x' }, ann.token)).status).toBe(404);
    expect((await confirm(api, ann, id)).status).toBe(404);
  });

  it('a video above the cap of items counts like a photo: 30 per player in total', async () => {
    for (let i = 0; i < 29; i++) await insertRow({ ownerUserId: ann.userId, uploadedById: ann.userId });
    expect((await uploadMedia(api, fake, ann, { kind: 'VIDEO' })).res.status).toBe(200);
    expect((await requestSlot(api, ann)).body.error.code).toBe('MEDIA_LIMIT_REACHED');
    void videoAsset; // (kept imported for the helpers' symmetry)
  });
});
