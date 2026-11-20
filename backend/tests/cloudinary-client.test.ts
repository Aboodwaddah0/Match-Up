import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { ALL_RESOURCE_TYPES, deliveryUrls, signParams, storage, StorageError } from '../src/lib/cloudinary';

/*
 * The Cloudinary client (src/lib/cloudinary.ts) against a local stub server: what it sends (paths, auth, signatures, the video metadata option, the
 * raw prefix sweep) and how it classifies answers. The shapes were also checked once against the real service (see the report); these tests keep
 * them from drifting.
 */

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
  body: string;
}
type Handler = (req: Seen) => { status: number; json?: unknown; raw?: string; headers?: Record<string, string> } | undefined;

let server: Server;
let seen: Seen[];
let handler: Handler;
const saved = { base: env.CLOUDINARY_API_BASE_URL };

const SECRET = 'test-api-secret-0123456789';
const AUTH = `Basic ${Buffer.from(`test-api-key:${SECRET}`).toString('base64')}`;

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString();
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const call: Seen = { method: req.method ?? '', path: decodeURIComponent(url.pathname), query: url.searchParams, auth: req.headers.authorization, body: await readBody(req) };
    seen.push(call);
    const out = handler(call) ?? { status: 404, json: { error: { message: 'not found' } } };
    res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
    res.end(out.raw ?? JSON.stringify(out.json ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  env.CLOUDINARY_API_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  env.CLOUDINARY_API_BASE_URL = saved.base;
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  seen = [];
  handler = () => undefined;
});
afterEach(() => {
  env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
  env.CLOUDINARY_API_KEY = 'test-api-key';
  env.CLOUDINARY_API_SECRET = SECRET;
});

const KEY = 'fym/media/0b8f0d0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const fail = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as StorageError;

describe('signing', () => {
  it("matches Cloudinary's documented example (sorted key=value pairs joined by &, the secret appended, SHA-1)", () => {
    expect(signParams({ eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: '1315060510' }, 'abcd')).toBe('bfd09f95f331f558cbd1320e67aa8d488770583e');
  });

  it('sorts the parameters, skips empty ones, and changes with every value and with the secret', () => {
    const a = signParams({ b: '2', a: '1', empty: '' }, 's');
    expect(a).toBe(createHash('sha1').update('a=1&b=2s').digest('hex'));
    expect(signParams({ a: '1', b: '3' }, 's')).not.toBe(a);
    expect(signParams({ a: '1', b: '2' }, 'other')).not.toBe(a);
  });

  it('signUpload signs the key, the formats, overwrite=false and type=upload; the resource type is NOT in the fields; the window is one hour', () => {
    const now = new Date('2026-11-20T10:00:00Z');
    const t = storage.signUpload({ key: KEY, resourceType: 'video', allowedFormats: ['mp4', 'mov'], now });
    const { api_key, signature, ...signed } = t.fields;
    expect(api_key).toBe('test-api-key');
    expect(signed).toEqual({ allowed_formats: 'mp4,mov', overwrite: 'false', public_id: KEY, timestamp: String(now.getTime() / 1000), type: 'upload' });
    expect(signature).toBe(signParams(signed, SECRET));
    expect(t.url).toBe(`${env.CLOUDINARY_API_BASE_URL}/v1_1/test-cloud/video/upload`);
    expect(t.expiresAt).toBe('2026-11-20T11:00:00.000Z');
  });
});

describe('describe()', () => {
  it('asks the Admin API for ONE asset under ONE resource type, with Basic auth; photos need no metadata option', async () => {
    handler = () => ({ status: 200, json: { public_id: KEY, resource_type: 'image', type: 'upload', format: 'heic', version: 1700000000, bytes: 4321, width: 100, height: 50 } });
    const a = await storage.describe(KEY, 'image');
    expect(a).toEqual({ publicId: KEY, resourceType: 'image', deliveryType: 'upload', format: 'heic', version: 1700000000, bytes: 4321, width: 100, height: 50, durationSec: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', path: `/v1_1/test-cloud/resources/image/upload/${KEY}`, auth: AUTH });
    expect(seen[0]!.query.size).toBe(0);
  });

  it('for a video it asks with image_metadata=true, because the plain answer has no duration (found on the live service)', async () => {
    handler = () => ({ status: 200, json: { public_id: KEY, resource_type: 'video', type: 'upload', format: 'mp4', version: 5, bytes: 9094354, width: 854, height: 480, duration: 13.4134 } });
    const a = await storage.describe(KEY, 'video');
    expect(seen[0]!.query.get('image_metadata')).toBe('true');
    expect(a).toMatchObject({ durationSec: 13.4134, resourceType: 'video' });
  });

  it('falls back to video_duration when duration is absent', async () => {
    handler = () => ({ status: 200, json: { public_id: KEY, resource_type: 'video', type: 'upload', format: 'mp4', version: 5, bytes: 10, video_duration: 7.5 } });
    expect((await storage.describe(KEY, 'video'))!.durationSec).toBe(7.5);
  });

  it('404 means "not there" (null), not a failure', async () => {
    handler = () => ({ status: 404, json: { error: { message: 'Resource not found' } } });
    expect(await storage.describe(KEY, 'raw')).toBeNull();
  });

  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [420, 'TRANSIENT'],
    [429, 'TRANSIENT'],
    [500, 'TRANSIENT'],
    [503, 'TRANSIENT'],
    [400, 'REJECTED'],
  ])('HTTP %i is classified as %s', async (status, kind) => {
    handler = () => ({ status, json: {} });
    const err = await fail(storage.describe(KEY, 'image'));
    expect(err).toBeInstanceOf(StorageError);
    expect(err.kind).toBe(kind);
  });

  it('an unreadable answer is REJECTED, a refused connection is TRANSIENT', async () => {
    handler = () => ({ status: 200, raw: 'not json' });
    expect((await fail(storage.describe(KEY, 'image'))).kind).toBe('REJECTED');
    handler = () => ({ status: 200, json: { nothing: true } });
    expect((await fail(storage.describe(KEY, 'image'))).kind).toBe('REJECTED');
    const saved2 = env.CLOUDINARY_API_BASE_URL;
    env.CLOUDINARY_API_BASE_URL = 'http://127.0.0.1:1'; // nothing listens there
    try {
      const err = await fail(storage.describe(KEY, 'image'));
      expect(err).toMatchObject({ kind: 'TRANSIENT', code: 'NETWORK' });
    } finally {
      env.CLOUDINARY_API_BASE_URL = saved2;
    }
  });
});

describe('destroy() for image and video', () => {
  it('posts a signed form (key, type=upload, invalidate=true) and treats "ok" as deleted and "not found" as already gone', async () => {
    handler = () => ({ status: 200, json: { result: 'ok' } });
    expect(await storage.destroy(KEY, 'image')).toBe('deleted');
    const form = new URLSearchParams(seen[0]!.body);
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/v1_1/test-cloud/image/destroy' });
    expect(Object.fromEntries(form)).toMatchObject({ public_id: KEY, type: 'upload', invalidate: 'true', api_key: 'test-api-key' });
    const { api_key, signature, ...signed } = Object.fromEntries(form);
    expect(api_key).toBe('test-api-key');
    expect(signature).toBe(signParams(signed as Record<string, string>, SECRET)); // Cloudinary would accept it

    handler = () => ({ status: 200, json: { result: 'not found' } });
    expect(await storage.destroy(KEY, 'video')).toBe('not_found');
    expect(seen[1]!.path).toBe('/v1_1/test-cloud/video/destroy');
    handler = () => ({ status: 404, json: {} });
    expect(await storage.destroy(KEY, 'image')).toBe('not_found');
  });

  it('anything else is an error: a surprising result is REJECTED, bad credentials AUTH, a rate limit TRANSIENT', async () => {
    handler = () => ({ status: 200, json: { result: 'weird' } });
    expect((await fail(storage.destroy(KEY, 'image'))).kind).toBe('REJECTED');
    handler = () => ({ status: 401, json: {} });
    expect((await fail(storage.destroy(KEY, 'image'))).kind).toBe('AUTH');
    handler = () => ({ status: 420, json: {} });
    expect((await fail(storage.destroy(KEY, 'image'))).kind).toBe('TRANSIENT');
  });
});

describe('destroy() for raw: the sweep by prefix (a raw upload is stored as "<key>.<extension>")', () => {
  const listing = (ids: string[], next?: string) => ({ status: 200, json: { resources: ids.map((public_id) => ({ public_id })), ...(next ? { next_cursor: next } : {}) } });

  it('lists by prefix, deletes the key and "<key>.*" only (never a different media row), and answers deleted', async () => {
    handler = (r) => {
      if (r.method === 'GET') return listing([`${KEY}.png`, `${KEY}.html`, KEY, `${KEY}0`, 'fym/media/other.png']);
      if (r.method === 'DELETE') return { status: 200, json: { deleted: {} } };
    };
    expect(await storage.destroy(KEY, 'raw')).toBe('deleted');
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/v1_1/test-cloud/resources/raw/upload', auth: AUTH });
    expect(seen[0]!.query.get('prefix')).toBe(KEY);
    const del = new URL(`http://x/?${seen[1]!.body || ''}`);
    void del;
    expect(seen[1]).toMatchObject({ method: 'DELETE', path: '/v1_1/test-cloud/resources/raw/upload', auth: AUTH });
    expect(seen[1]!.query.getAll('public_ids[]').sort()).toEqual([KEY, `${KEY}.html`, `${KEY}.png`].sort()); // NOT "<key>0" and NOT another media id
    expect(seen[1]!.query.get('invalidate')).toBe('true');
  });

  it('nothing found: not_found and no DELETE is sent', async () => {
    handler = () => listing([]);
    expect(await storage.destroy(KEY, 'raw')).toBe('not_found');
    expect(seen.map((s) => s.method)).toEqual(['GET']);
  });

  it('follows next_cursor across pages and deletes on each', async () => {
    handler = (r) => {
      if (r.method === 'DELETE') return { status: 200, json: { deleted: {} } };
      return r.query.get('next_cursor') ? listing([`${KEY}.b`]) : listing([`${KEY}.a`], 'cursor-2');
    };
    expect(await storage.destroy(KEY, 'raw')).toBe('deleted');
    expect(seen.map((s) => s.method)).toEqual(['GET', 'DELETE', 'GET', 'DELETE']);
    expect(seen[2]!.query.get('next_cursor')).toBe('cursor-2');
  });

  it('gives up after 10 pages with a TRANSIENT error so the next attempt continues (what was deleted is gone from the listing)', async () => {
    handler = (r) => (r.method === 'DELETE' ? { status: 200, json: {} } : listing([`${KEY}.x`], 'more'));
    const err = await fail(storage.destroy(KEY, 'raw'));
    expect(err).toMatchObject({ kind: 'TRANSIENT', code: 'MORE_RAW_FILES' });
    expect(seen.filter((s) => s.method === 'GET')).toHaveLength(10);
  });

  it('a failing list or delete is an error (the row stays and is retried), never a silent "not found"', async () => {
    handler = () => ({ status: 500, json: {} });
    expect((await fail(storage.destroy(KEY, 'raw'))).kind).toBe('TRANSIENT');
    handler = (r) => (r.method === 'GET' ? listing([`${KEY}.png`]) : { status: 401, json: {} });
    expect((await fail(storage.destroy(KEY, 'raw'))).kind).toBe('AUTH');
  });

  it('the worker covers every namespace: image, video and raw', () => {
    expect([...ALL_RESOURCE_TYPES]).toEqual(['image', 'video', 'raw']);
  });
});

describe('listAssets(): one validated page of the Admin API listing (used by the daily reconciliation)', () => {
  const entry = (id: string, over: Record<string, unknown> = {}) => ({ public_id: id, resource_type: 'image', type: 'upload', created_at: '2026-11-20T02:49:35Z', ...over });
  const ARGS = { prefix: 'fym/media/', maxResults: 500 };

  it('asks for ONE namespace by prefix with the page size and the cursor, with Basic auth, and returns ids, creation times and the rate-limit headers', async () => {
    handler = () => ({
      status: 200,
      json: { resources: [entry(`${KEY}`), entry('fym/media/zzz')], next_cursor: 'abc123' },
      headers: { 'x-featureratelimit-remaining': '412', 'x-featureratelimit-reset': 'Fri, 20 Nov 2026 03:00:00 GMT' },
    });
    const page = await storage.listAssets('image', { ...ARGS, cursor: 'prev-cursor' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/v1_1/test-cloud/resources/image/upload', auth: AUTH });
    expect(Object.fromEntries(seen[0]!.query)).toEqual({ prefix: 'fym/media/', max_results: '500', next_cursor: 'prev-cursor' });
    expect(page.assets.map((a) => a.publicId)).toEqual([KEY, 'fym/media/zzz']);
    expect(page.assets[0]!.createdAt.toISOString()).toBe('2026-11-20T02:49:35.000Z');
    expect(page).toMatchObject({ nextCursor: 'abc123', rateRemaining: 412 });
    expect(page.rateResetAt?.toISOString()).toBe('2026-11-20T03:00:00.000Z');
  });

  it('the first page sends no cursor; the last page has no next cursor; missing rate headers are null; an empty listing is a valid page', async () => {
    handler = () => ({ status: 200, json: { resources: [] } });
    const page = await storage.listAssets('raw', ARGS);
    expect(seen[0]!.query.has('next_cursor')).toBe(false);
    expect(seen[0]!.path).toBe('/v1_1/test-cloud/resources/raw/upload');
    expect(page).toEqual({ assets: [], nextCursor: null, rateRemaining: null, rateResetAt: null });
    handler = () => ({ status: 200, json: { resources: [entry(KEY)], next_cursor: '' } });
    expect((await storage.listAssets('image', ARGS)).nextCursor).toBeNull();
  });

  it('one bad entry rejects the WHOLE page as unreadable (nothing partial is returned): no id, bad time, wrong namespace, wrong delivery type', async () => {
    const bad: Array<[string, unknown]> = [
      ['no public id', entry('x', { public_id: undefined })],
      ['empty public id', entry('', {})],
      ['no creation time', entry(KEY, { created_at: undefined })],
      ['unreadable creation time', entry(KEY, { created_at: 'yesterday' })],
      ['another namespace', entry(KEY, { resource_type: 'video' })],
      ['another delivery type', entry(KEY, { type: 'private' })],
      ['not an object', null],
    ];
    for (const [why, e] of bad) {
      handler = () => ({ status: 200, json: { resources: [entry('fym/media/fine'), e] } });
      const err = await fail(storage.listAssets('image', ARGS));
      expect(err, why).toMatchObject({ kind: 'REJECTED', code: 'BAD_PAGE' });
    }
  });

  it('an unreadable body is rejected: not JSON, no resources array, more entries than asked, a cursor on an empty page, a cursor that is not a string', async () => {
    const answers: Array<[string, { raw?: string; json?: unknown }]> = [
      ['not json', { raw: '<html>' }],
      ['no resources', { json: { next_cursor: 'x' } }],
      ['resources is not an array', { json: { resources: 'nope' } }],
      ['too many', { json: { resources: [entry('a'), entry('b'), entry('c')] } }],
      ['cursor on an empty page', { json: { resources: [], next_cursor: 'x' } }],
      ['cursor is a number', { json: { resources: [entry('a')], next_cursor: 5 } }],
    ];
    for (const [why, a] of answers) {
      handler = () => ({ status: 200, ...a });
      const err = await fail(storage.listAssets('image', { prefix: 'fym/media/', maxResults: 2 }));
      expect(err, why).toMatchObject({ kind: 'REJECTED', code: 'BAD_PAGE' });
    }
  });

  it('a cursor the provider refuses (HTTP 400 "Invalid next_cursor") is INVALID_CURSOR; a 400 without a cursor is an ordinary rejection', async () => {
    handler = () => ({ status: 400, json: { error: { message: 'Invalid next_cursor' } } });
    expect(await fail(storage.listAssets('image', { ...ARGS, cursor: 'stale' }))).toMatchObject({ kind: 'REJECTED', code: 'INVALID_CURSOR' });
    expect(await fail(storage.listAssets('image', ARGS))).toMatchObject({ kind: 'REJECTED', code: 'HTTP_400' });
    handler = () => ({ status: 400, json: { error: { message: 'something else' } } });
    expect(await fail(storage.listAssets('image', { ...ARGS, cursor: 'stale' }))).toMatchObject({ code: 'HTTP_400' });
  });

  it('bad credentials are AUTH, a rate limit or a server error TRANSIENT, a refused connection TRANSIENT, no credentials NOT_CONFIGURED (no request)', async () => {
    handler = () => ({ status: 401, json: {} });
    expect((await fail(storage.listAssets('image', ARGS))).kind).toBe('AUTH');
    handler = () => ({ status: 429, json: {} });
    expect((await fail(storage.listAssets('image', ARGS))).kind).toBe('TRANSIENT');
    handler = () => ({ status: 503, json: {} });
    expect((await fail(storage.listAssets('image', ARGS))).kind).toBe('TRANSIENT');
    const saved2 = env.CLOUDINARY_API_BASE_URL;
    env.CLOUDINARY_API_BASE_URL = 'http://127.0.0.1:1';
    try {
      expect(await fail(storage.listAssets('image', ARGS))).toMatchObject({ kind: 'TRANSIENT', code: 'NETWORK' });
    } finally {
      env.CLOUDINARY_API_BASE_URL = saved2;
    }
    seen = [];
    env.CLOUDINARY_API_SECRET = undefined;
    expect((await fail(storage.listAssets('image', ARGS))).kind).toBe('NOT_CONFIGURED');
    expect(seen).toEqual([]);
  });
});

describe('destroyAsset(): delete by the EXACT public id (upload API, not the Admin API)', () => {
  it('a raw stray is deleted under its full id "<key>.<extension>" in one signed POST, and "not found" is already gone', async () => {
    handler = () => ({ status: 200, json: { result: 'ok' } });
    expect(await storage.destroyAsset(`${KEY}.png`, 'raw')).toBe('deleted');
    expect(seen).toHaveLength(1); // no listing first
    const form = new URLSearchParams(seen[0]!.body);
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/v1_1/test-cloud/raw/destroy' });
    expect(Object.fromEntries(form)).toMatchObject({ public_id: `${KEY}.png`, type: 'upload', invalidate: 'true' });
    const { api_key, signature, ...signed } = Object.fromEntries(form);
    expect(api_key).toBe('test-api-key');
    expect(signature).toBe(signParams(signed as Record<string, string>, SECRET));
    handler = () => ({ status: 200, json: { result: 'not found' } });
    expect(await storage.destroyAsset(`${KEY}.png`, 'raw')).toBe('not_found');
  });

  it('errors are classified like every other call', async () => {
    handler = () => ({ status: 200, json: { result: 'weird' } });
    expect((await fail(storage.destroyAsset(KEY, 'image'))).kind).toBe('REJECTED');
    handler = () => ({ status: 401, json: {} });
    expect((await fail(storage.destroyAsset(KEY, 'video'))).kind).toBe('AUTH');
    handler = () => ({ status: 500, json: {} });
    expect((await fail(storage.destroyAsset(KEY, 'image'))).kind).toBe('TRANSIENT');
  });
});

describe('configuration and delivery URLs', () => {
  it('without credentials every call fails as NOT_CONFIGURED (no request is sent) and configured() says so', async () => {
    env.CLOUDINARY_API_SECRET = undefined;
    expect(storage.configured()).toBe(false);
    expect((await fail(storage.describe(KEY, 'image'))).kind).toBe('NOT_CONFIGURED');
    expect((await fail(storage.destroy(KEY, 'image'))).kind).toBe('NOT_CONFIGURED');
    expect((await fail(storage.destroy(KEY, 'raw'))).kind).toBe('NOT_CONFIGURED');
    expect(() => storage.signUpload({ key: KEY, resourceType: 'image', allowedFormats: ['jpg'] })).toThrow(StorageError);
    expect(seen).toEqual([]);
  });

  it('builds the delivery URLs from the verified version and OUR key, https only', () => {
    const photo = deliveryUrls('PHOTO', KEY, 42);
    expect(photo.url).toBe(`https://res.cloudinary.com/test-cloud/image/upload/c_limit,w_2048,f_auto,q_auto/v42/${KEY}`);
    expect(photo.thumbnailUrl).toBe(`https://res.cloudinary.com/test-cloud/image/upload/c_limit,w_480,f_auto,q_auto/v42/${KEY}`);
    const video = deliveryUrls('VIDEO', KEY, 43);
    expect(video.url).toBe(`https://res.cloudinary.com/test-cloud/video/upload/vc_h264,q_auto/v43/${KEY}.mp4`);
    expect(video.thumbnailUrl).toBe(`https://res.cloudinary.com/test-cloud/video/upload/so_0,c_limit,w_480,f_jpg,q_auto/v43/${KEY}.jpg`);
    for (const u of [photo.url, photo.thumbnailUrl, video.url, video.thumbnailUrl]) expect(u).toMatch(/^https:\/\//);
  });
});
