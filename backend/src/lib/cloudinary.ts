import { createHash } from 'node:crypto';
import { env } from '../config/env';

/*
 * Cloudinary, spoken to directly over HTTPS (no SDK: three small calls, no new dependency).
 *
 *  - signUpload: the parameters a mobile app needs to upload straight to Cloudinary, signed with the API secret. The binary never touches this API.
 *  - describe:   the Admin API's view of ONE stored asset. It is the only source of truth for size, type and duration; nothing the client says counts.
 *  - destroy:    removes one asset (and invalidates the CDN copy).
 *
 * SECURITY FACTS this file is built around (Cloudinary documentation, "Generating authentication signatures"):
 *  - The signature covers `timestamp` and every optional parameter that is sent (here: public_id, allowed_formats, overwrite, type), but NOT `file`,
 *    `cloud_name`, `api_key` or `resource_type`. The resource type is part of the upload URL, so a client may upload to a DIFFERENT resource type
 *    (image / video / raw) than the one we expect and still carry a valid signature. Public ids are separate namespaces per resource type.
 *    => confirmation looks the asset up under the EXPECTED type only (a file stored elsewhere is "not found" and the upload is rejected), and the
 *       deletion path always tries ALL resource types (`ALL_RESOURCE_TYPES`), so such a stray object can never be orphaned. Found by a live check:
 *       a `raw` upload is stored as "<key>.<file extension>", so the raw sweep matches by prefix (see destroyRawStrays).
 *  - Neither file size nor video duration can be limited by the signature. They are verified after the upload, from the Admin API.
 *  - The signature stays valid for one hour. `overwrite=false` is signed so that the same signature cannot be used to replace a verified file.
 */

export type ResourceType = 'image' | 'video' | 'raw';
/** Every namespace a public id can live in. The deletion path tries each of them, whatever type the upload was meant to use. */
export const ALL_RESOURCE_TYPES: readonly ResourceType[] = ['image', 'video', 'raw'];

/** Lifetime of an upload signature, as Cloudinary enforces it. A PENDING media row is cleaned up only after this plus a grace period. */
export const SIGNATURE_TTL_SECONDS = 3600;
const REQUEST_TIMEOUT_MS = 15_000;

export type StorageErrorKind = 'NOT_CONFIGURED' | 'AUTH' | 'TRANSIENT' | 'REJECTED';

/** A failure talking to the provider. `AUTH` = the credentials are refused; `TRANSIENT` = try again later (network, 5xx, rate limit). */
export class StorageError extends Error {
  constructor(
    message: string,
    public readonly kind: StorageErrorKind,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** What Cloudinary reports about a stored asset (only the fields we verify or use). */
export interface ProviderAsset {
  publicId: string;
  resourceType: string;
  deliveryType: string;
  format: string;
  version: number;
  bytes: number;
  width: number | null;
  height: number | null;
  /** Video length in seconds as reported by the provider (absent for photos). */
  durationSec: number | null;
}

/** One entry of the provider's listing (only the fields the reconciliation uses). */
export interface ListedAsset {
  publicId: string;
  /** When the PROVIDER created the asset (second precision, UTC): the grace period is measured from it, not from our slot. */
  createdAt: Date;
}

/** One COMPLETE, validated page of a listing. `nextCursor` is null on the last page. */
export interface AssetPage {
  assets: ListedAsset[];
  nextCursor: string | null;
  /** Admin API calls left in the provider's current rate-limit window, when it said so. */
  rateRemaining: number | null;
  /** When that window resets, when it said so. */
  rateResetAt: Date | null;
}

export interface UploadTicket {
  /** POST multipart/form-data here, with every field below plus the `file`. */
  url: string;
  method: 'POST';
  fields: Record<string, string>;
  expiresAt: string;
}

/** Cloudinary's signature: SHA-1 of the sorted "key=value" pairs joined with "&", followed directly by the API secret. */
export function signParams(params: Record<string, string>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .filter((k) => params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1').update(toSign + apiSecret).digest('hex');
}

interface Credentials {
  cloud: string;
  key: string;
  secret: string;
}

function credentials(): Credentials {
  const { CLOUDINARY_CLOUD_NAME: cloud, CLOUDINARY_API_KEY: key, CLOUDINARY_API_SECRET: secret } = env;
  if (!cloud || !key || !secret) throw new StorageError('Cloudinary is not configured', 'NOT_CONFIGURED', 'NOT_CONFIGURED');
  return { cloud, key, secret };
}

const encodeKey = (publicId: string) => publicId.split('/').map(encodeURIComponent).join('/');

/** Maps an HTTP failure to a StorageError. 404 is handled by the callers (it means "not there", not "failed"). */
function failure(status: number, what: string): StorageError {
  if (status === 401 || status === 403) return new StorageError(`${what}: credentials refused (HTTP ${status})`, 'AUTH', `HTTP_${status}`);
  if (status === 408 || status === 420 || status === 429 || status >= 500) return new StorageError(`${what}: provider unavailable (HTTP ${status})`, 'TRANSIENT', `HTTP_${status}`);
  return new StorageError(`${what}: unexpected answer (HTTP ${status})`, 'REJECTED', `HTTP_${status}`);
}

async function request(url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    // Network failure or timeout: the provider's state is unknown, so the caller must treat it as "try again".
    throw new StorageError(`${what}: ${(err as Error).name === 'TimeoutError' ? 'timed out' : 'network error'}`, 'TRANSIENT', 'NETWORK');
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const basicAuth = (c: Credentials) => `Basic ${Buffer.from(`${c.key}:${c.secret}`).toString('base64')}`;
const RAW_PAGE_SIZE = 100;
const RAW_MAX_PAGES = 10;

/**
 * Deletes every raw object that belongs to `key`: the key itself and "<key>.<anything>". The id of a media row is a UUID of fixed length, so a prefix
 * search for it cannot match another row's files. Pages through the listing (a client could have uploaded several files with one signature);
 * if more remain after RAW_MAX_PAGES pages it fails as TRANSIENT so the next retry continues (what was deleted is gone from the listing).
 */
async function destroyRawStrays(c: Credentials, key: string): Promise<'deleted' | 'not_found'> {
  const base = `${env.CLOUDINARY_API_BASE_URL}/v1_1/${c.cloud}/resources/raw/upload`;
  let deleted = false;
  let cursor: string | undefined;
  for (let page = 0; page < RAW_MAX_PAGES; page++) {
    const query = new URLSearchParams({ prefix: key, max_results: String(RAW_PAGE_SIZE) });
    if (cursor) query.set('next_cursor', cursor);
    const list = await request(`${base}?${query}`, { method: 'GET', headers: { authorization: basicAuth(c) } }, 'list raw');
    if (!list.ok) throw failure(list.status, 'list raw');
    const body = (await list.json().catch(() => null)) as { resources?: Array<{ public_id?: unknown }>; next_cursor?: unknown } | null;
    if (!body || !Array.isArray(body.resources)) throw new StorageError('list raw: unreadable answer', 'REJECTED', 'BAD_BODY');
    const ids = body.resources.map((r) => r.public_id).filter((id): id is string => typeof id === 'string' && (id === key || id.startsWith(`${key}.`)));
    if (ids.length > 0) {
      const del = await request(
        `${base}?${ids.map((id) => `public_ids[]=${encodeURIComponent(id)}`).join('&')}&invalidate=true`,
        { method: 'DELETE', headers: { authorization: basicAuth(c) } },
        'delete raw',
      );
      if (!del.ok) throw failure(del.status, 'delete raw');
      deleted = true;
    }
    cursor = typeof body.next_cursor === 'string' && body.next_cursor ? body.next_cursor : undefined;
    if (!cursor) return deleted ? 'deleted' : 'not_found';
  }
  throw new StorageError('delete raw: more files remain, continuing on the next attempt', 'TRANSIENT', 'MORE_RAW_FILES');
}

/** Upload-API destroy of ONE exact public id in ONE namespace (not an Admin API call). Idempotent: "not found" is an answer. */
async function destroyExact(c: Credentials, publicId: string, resourceType: ResourceType): Promise<'deleted' | 'not_found'> {
  const signed = { invalidate: 'true', public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'upload' };
  const form = new URLSearchParams({ ...signed, api_key: c.key, signature: signParams(signed, c.secret) });
  const res = await request(
    `${env.CLOUDINARY_API_BASE_URL}/v1_1/${c.cloud}/${resourceType}/destroy`,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form },
    'destroy',
  );
  if (res.status === 404) return 'not_found';
  if (!res.ok) throw failure(res.status, 'destroy');
  const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
  if (body?.result === 'ok') return 'deleted';
  if (body?.result === 'not found') return 'not_found';
  throw new StorageError(`destroy: unexpected result "${String(body?.result)}"`, 'REJECTED', 'BAD_RESULT');
}

export const storage = {
  configured(): boolean {
    return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
  },

  /**
   * Signed direct-upload parameters for ONE storage key. The key, the allowed file formats, `overwrite=false` and `type=upload` are all signed:
   * the client can neither pick another key nor widen the formats nor overwrite an existing asset. It can still choose the resource type in the URL
   * (not covered by the signature); see the header for how that is handled.
   */
  signUpload(args: { key: string; resourceType: 'image' | 'video'; allowedFormats: string[]; now?: Date }): UploadTicket {
    const c = credentials();
    const timestamp = Math.floor((args.now ?? new Date()).getTime() / 1000);
    const signed = {
      allowed_formats: args.allowedFormats.join(','),
      overwrite: 'false',
      public_id: args.key,
      timestamp: String(timestamp),
      type: 'upload',
    };
    return {
      url: `${env.CLOUDINARY_API_BASE_URL}/v1_1/${c.cloud}/${args.resourceType}/upload`,
      method: 'POST',
      fields: { ...signed, api_key: c.key, signature: signParams(signed, c.secret) },
      expiresAt: new Date((timestamp + SIGNATURE_TTL_SECONDS) * 1000).toISOString(),
    };
  },

  /**
   * The asset stored under `key` in ONE resource-type namespace, or null when there is none ("not found" is an answer, not an error).
   * Throws StorageError for anything that does not give a definite answer (network, rate limit, bad credentials), so a caller never rejects a
   * good upload because the provider hiccuped.
   */
  async describe(key: string, resourceType: ResourceType): Promise<ProviderAsset | null> {
    const c = credentials();
    // Found by a live check: for a video the plain answer has NO duration. It is included only with image_metadata=true (the option's name is
    // historical; it returns the media metadata). Photos do not need it, and it would add a large EXIF block.
    const detail = resourceType === 'video' ? '?image_metadata=true' : '';
    const res = await request(
      `${env.CLOUDINARY_API_BASE_URL}/v1_1/${c.cloud}/resources/${resourceType}/upload/${encodeKey(key)}${detail}`,
      { method: 'GET', headers: { authorization: basicAuth(c) } },
      'describe',
    );
    if (res.status === 404) return null;
    if (!res.ok) throw failure(res.status, 'describe');
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.public_id !== 'string') throw new StorageError('describe: unreadable answer', 'REJECTED', 'BAD_BODY');
    return {
      publicId: body.public_id,
      resourceType: String(body.resource_type ?? ''),
      deliveryType: String(body.type ?? ''),
      format: String(body.format ?? ''),
      version: num(body.version) ?? 0,
      bytes: num(body.bytes) ?? 0,
      width: num(body.width),
      height: num(body.height),
      durationSec: num(body.duration) ?? num(body.video_duration),
    };
  },

  /**
   * Deletes the asset under `key` in ONE resource-type namespace and invalidates its CDN copy. Idempotent: an asset that is already gone answers
   * "not_found", which the caller treats as success.
   *
   * The `raw` namespace is special (verified against the live service): a raw upload is stored under the key PLUS THE FILE EXTENSION of the uploaded
   * file ("fym/media/<id>.png"), chosen by the client, so deleting the bare key finds nothing. For `raw` every object whose id is the key or starts
   * with "<key>." is listed (Admin API, by prefix) and deleted.
   */
  async destroy(key: string, resourceType: ResourceType): Promise<'deleted' | 'not_found'> {
    const c = credentials();
    if (resourceType === 'raw') return destroyRawStrays(c, key);
    return destroyExact(c, key, resourceType);
  },

  /**
   * Deletes ONE asset by its exact public id in ONE namespace (the id exactly as a listing reported it, so a raw file's extension is included).
   * Upload API, not Admin API: it does not count against the Admin API rate limit. Idempotent. Used by the reconciliation job.
   */
  async destroyAsset(publicId: string, resourceType: ResourceType): Promise<'deleted' | 'not_found'> {
    return destroyExact(credentials(), publicId, resourceType);
  },

  /**
   * ONE page of the Admin API listing of a resource-type namespace under `prefix` (verified against the live service: ordered by public id, which makes
   * the cursor a position in that order, so deleting listed assets does not shift later pages; the cursor stays usable for at least tens of seconds; an
   * unknown cursor is refused with HTTP 400 "Invalid next_cursor"; the Admin API allows 500 calls per hour on this plan and says how many are left).
   *
   * The page is VALIDATED AS A WHOLE before anything is returned: any entry without a string public id, a readable creation time or the expected
   * resource type (or a next cursor on an empty page, or more entries than asked) makes the whole page "unreadable" (REJECTED / BAD_PAGE), so a
   * caller never acts on part of an ambiguous answer. A cursor the provider no longer accepts is reported as REJECTED / INVALID_CURSOR.
   */
  async listAssets(resourceType: ResourceType, args: { prefix: string; cursor?: string | null; maxResults: number }): Promise<AssetPage> {
    const c = credentials();
    const query = new URLSearchParams({ prefix: args.prefix, max_results: String(args.maxResults) });
    if (args.cursor) query.set('next_cursor', args.cursor);
    const res = await request(
      `${env.CLOUDINARY_API_BASE_URL}/v1_1/${c.cloud}/resources/${resourceType}/upload?${query}`,
      { method: 'GET', headers: { authorization: basicAuth(c) } },
      'list',
    );
    const raw = await res.text().catch(() => '');
    if (res.status === 400 && args.cursor && /next_cursor/i.test(raw)) throw new StorageError('list: the cursor is no longer valid', 'REJECTED', 'INVALID_CURSOR');
    if (!res.ok) throw failure(res.status, 'list');
    const body = ((): { resources?: unknown; next_cursor?: unknown } | null => {
      try {
        return JSON.parse(raw) as { resources?: unknown; next_cursor?: unknown } | null;
      } catch {
        return null;
      }
    })();
    const bad = (why: string) => new StorageError(`list: unreadable page (${why})`, 'REJECTED', 'BAD_PAGE');
    if (!body || !Array.isArray(body.resources)) throw bad('no resources array');
    if (body.resources.length > args.maxResults) throw bad('more entries than requested');
    const assets: ListedAsset[] = [];
    for (const r of body.resources as Array<Record<string, unknown>>) {
      const createdAt = typeof r?.created_at === 'string' ? new Date(r.created_at) : null;
      if (typeof r?.public_id !== 'string' || r.public_id === '') throw bad('entry without a public id');
      if (!createdAt || Number.isNaN(createdAt.getTime())) throw bad('entry without a creation time');
      if (r.resource_type !== resourceType || r.type !== 'upload') throw bad('entry of another namespace');
      assets.push({ publicId: r.public_id, createdAt });
    }
    const next = typeof body.next_cursor === 'string' && body.next_cursor !== '' ? body.next_cursor : null;
    if (body.next_cursor != null && typeof body.next_cursor !== 'string') throw bad('next cursor is not a string');
    if (next && assets.length === 0) throw bad('a next cursor on an empty page');
    const remaining = Number(res.headers.get('x-featureratelimit-remaining'));
    const reset = res.headers.get('x-featureratelimit-reset');
    const resetAt = reset ? new Date(reset) : null;
    return {
      assets,
      nextCursor: next,
      rateRemaining: res.headers.get('x-featureratelimit-remaining') !== null && Number.isFinite(remaining) ? remaining : null,
      rateResetAt: resetAt && !Number.isNaN(resetAt.getTime()) ? resetAt : null,
    };
  },
};

/**
 * Delivery URLs for a verified asset, built from the verified version and OUR storage key (never from a client-supplied value).
 *  - photos: width-limited and sent in the best format for the device (f_auto), which is how a HEIC original reaches a browser or phone as
 *    JPEG / WebP / AVIF; the original file and its MIME type stay at the provider and in the row. A transformed delivery also drops most
 *    embedded metadata (EXIF location included).
 *  - videos: H.264 MP4 whatever the original container (a QuickTime .mov is converted on delivery), plus a JPEG poster frame as the thumbnail.
 */
export function deliveryUrls(kind: 'PHOTO' | 'VIDEO', key: string, version: number): { url: string; thumbnailUrl: string } {
  const base = `${env.CLOUDINARY_DELIVERY_BASE_URL}/${env.CLOUDINARY_CLOUD_NAME}`;
  const path = `v${version}/${encodeKey(key)}`;
  if (kind === 'PHOTO') {
    return {
      url: `${base}/image/upload/c_limit,w_2048,f_auto,q_auto/${path}`,
      thumbnailUrl: `${base}/image/upload/c_limit,w_480,f_auto,q_auto/${path}`,
    };
  }
  return {
    url: `${base}/video/upload/vc_h264,q_auto/${path}.mp4`,
    thumbnailUrl: `${base}/video/upload/so_0,c_limit,w_480,f_jpg,q_auto/${path}.jpg`,
  };
}
