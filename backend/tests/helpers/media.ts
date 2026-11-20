import { vi } from 'vitest';
import type { AssetPage, ProviderAsset, ResourceType } from '../../src/lib/cloudinary';
import type { startApp } from './client';
import { makeUser, type TestUser } from './users';

type Api = Awaited<ReturnType<typeof startApp>>;
export const MEDIA = '/api/v1/media';
export const TEAMS = '/api/v1/teams';

export const prismaP = async () => (await import('../../src/lib/prisma')).prisma;
export const cloud = () => import('../../src/lib/cloudinary');
/**
 * The media worker. In production a deleted row is kept (hidden) until the upload window has closed (70 minutes after its slot was created); a test
 * that wants a row gone at once would have to age it first. So the tests' default is NO hold (`holdMinutes: 0`); the tests of the hold itself pass
 * `holdMinutes: undefined` or a number explicitly.
 */
export const worker = async () => {
  const m = await import('../../src/jobs/media-worker');
  return { ...m, runMediaWorkerOnce: (opts: Parameters<typeof m.runMediaWorkerOnce>[0] = {}) => m.runMediaWorkerOnce({ holdMinutes: 0, ...opts }) };
};

/**
 * A fake storage provider. The tests never reach Cloudinary: describe / destroy are replaced (signing stays the real code, it is pure).
 * `objects` is what is "stored" at the provider, keyed "<resourceType>:<key>", so a test can put a file under ANY resource type (a client can).
 */
export async function fakeStorage() {
  const { storage, StorageError } = await cloud();
  const objects = new Map<string, ProviderAsset>();
  const describeCalls: Array<{ key: string; type: ResourceType }> = [];
  const destroyCalls: Array<{ key: string; type: ResourceType }> = [];
  // when the PROVIDER created each stored file ("<type>:<key>"): the reconciliation grace period is measured from it
  const created = new Map<string, Date>();
  const listCalls: Array<{ type: ResourceType; cursor: string | null; maxResults: number }> = [];
  const destroyAssetCalls: Array<{ publicId: string; type: ResourceType }> = [];
  type ListCall = { type: ResourceType; cursor: string | null; call: number };
  const state: {
    describeError: Error | null;
    destroyError: ((key: string, type: ResourceType) => Error | null) | null;
    listError: ((c: ListCall) => Error | null) | null;
    destroyAssetError: ((publicId: string, type: ResourceType) => Error | null) | null;
    /** Runs after a listing page was assembled and before it is returned (a test changes the provider "while the walk is in progress"). */
    afterList: ((c: ListCall, ids: string[]) => void | Promise<void>) | null;
    /** Runs when a reconciliation delete is about to reach the provider (a test changes the database "while the page is being worked through"). */
    beforeDestroyAsset: ((publicId: string, type: ResourceType) => void | Promise<void>) | null;
    rateRemaining: number | null;
    /** Every cursor the walk presents is refused, like a cursor the provider no longer knows. */
    rejectCursors: boolean;
  } = { describeError: null, destroyError: null, listError: null, destroyAssetError: null, beforeDestroyAsset: null, afterList: null, rateRemaining: null, rejectCursors: false };

  vi.spyOn(storage, 'describe').mockImplementation(async (key: string, type: ResourceType) => {
    describeCalls.push({ key, type });
    if (state.describeError) throw state.describeError;
    return objects.get(`${type}:${key}`) ?? null;
  });
  vi.spyOn(storage, 'destroy').mockImplementation(async (key: string, type: ResourceType) => {
    destroyCalls.push({ key, type });
    const err = state.destroyError?.(key, type);
    if (err) throw err;
    if (type === 'raw') {
      // like the real client (verified live): a raw file is stored as "<key>.<extension>", so the sweep matches the key and "<key>.*"
      const hits = [...objects.keys()].filter((k) => k === `raw:${key}` || k.startsWith(`raw:${key}.`));
      hits.forEach((k) => objects.delete(k));
      return hits.length > 0 ? 'deleted' : 'not_found';
    }
    return objects.delete(`${type}:${key}`) ? 'deleted' : 'not_found';
  });

  // the provider's listing, as verified live: ordered by public id, the cursor is a position in that order (deleting listed files shifts nothing)
  vi.spyOn(storage, 'listAssets').mockImplementation(async (type: ResourceType, args: { prefix: string; cursor?: string | null; maxResults: number }): Promise<AssetPage> => {
    const cursor = args.cursor ?? null;
    listCalls.push({ type, cursor, maxResults: args.maxResults });
    const call = listCalls.length;
    const err = state.listError?.({ type, cursor, call });
    if (err) throw err;
    if (cursor && state.rejectCursors) throw new StorageError('list: the cursor is no longer valid', 'REJECTED', 'INVALID_CURSOR');
    const after = cursor ? cursor.replace(/^c:/, '') : null;
    const ids = [...objects.keys()]
      .filter((k) => k.startsWith(`${type}:`))
      .map((k) => k.slice(type.length + 1))
      .filter((id) => id.startsWith(args.prefix) && (after === null || id > after))
      .sort();
    const page = ids.slice(0, args.maxResults);
    const more = ids.length > page.length;
    await state.afterList?.({ type, cursor, call }, page);
    return {
      assets: page.map((id) => ({ publicId: id, createdAt: created.get(`${type}:${id}`) ?? new Date() })),
      nextCursor: more ? `c:${page[page.length - 1]}` : null,
      rateRemaining: state.rateRemaining,
      rateResetAt: null,
    };
  });
  vi.spyOn(storage, 'destroyAsset').mockImplementation(async (publicId: string, type: ResourceType) => {
    destroyAssetCalls.push({ publicId, type });
    await state.beforeDestroyAsset?.(publicId, type);
    const err = state.destroyAssetError?.(publicId, type);
    if (err) throw err;
    created.delete(`${type}:${publicId}`);
    return objects.delete(`${type}:${publicId}`) ? 'deleted' : 'not_found';
  });

  return {
    objects,
    describeCalls,
    destroyCalls,
    listCalls,
    destroyAssetCalls,
    state,
    StorageError,
    /** "The client uploaded this file": stores it at the provider under the given resource type. */
    put(key: string, type: ResourceType, asset: ProviderAsset, ageMs = 0) {
      objects.set(`${type}:${key}`, asset);
      created.set(`${type}:${key}`, new Date(Date.now() - ageMs));
    },
    /** Makes a stored file look as if the provider had created it `ageMs` ago. */
    age(key: string, type: ResourceType, ageMs: number) {
      created.set(`${type}:${key}`, new Date(Date.now() - ageMs));
    },
    failDescribe(err: Error | null) {
      state.describeError = err;
    },
    failDestroy(fn: ((key: string, type: ResourceType) => Error | null) | null) {
      state.destroyError = fn;
    },
  };
}
export type FakeStorage = Awaited<ReturnType<typeof fakeStorage>>;

export const photoAsset = (key: string, over: Partial<ProviderAsset> = {}): ProviderAsset => ({
  publicId: key,
  resourceType: 'image',
  deliveryType: 'upload',
  format: 'jpg',
  version: 1_700_000_000,
  bytes: 500_000,
  width: 1200,
  height: 800,
  durationSec: null,
  ...over,
});

export const videoAsset = (key: string, over: Partial<ProviderAsset> = {}): ProviderAsset => ({
  publicId: key,
  resourceType: 'video',
  deliveryType: 'upload',
  format: 'mp4',
  version: 1_700_000_001,
  bytes: 20_000_000,
  width: 1280,
  height: 720,
  durationSec: 30,
  ...over,
});

export type Owner = { type: 'PLAYER' } | { type: 'TEAM'; teamId: string };

/** Asks for an upload slot. Returns the raw response; `keyOf(id)` reads the server-chosen storage key from the database. */
export const requestSlot = (api: Api, user: TestUser, over: Record<string, unknown> = {}) =>
  api.call('POST', `${MEDIA}/uploads`, { owner: { type: 'PLAYER' }, mimeType: 'image/jpeg', sizeBytes: 500_000, ...over }, user.token);

export async function keyOf(mediaId: string): Promise<string> {
  return (await (await prismaP()).mediaItem.findUniqueOrThrow({ where: { id: mediaId } })).storageKey;
}

export const confirm = (api: Api, user: TestUser, mediaId: string, body: unknown = {}) => api.call('POST', `${MEDIA}/${mediaId}/confirm`, body, user.token);

/**
 * The whole happy path in one call: slot, "client upload" (the provider now holds a matching file), confirm.
 * `asset` overrides what the provider reports; `as` is the resource type the file is stored under (default: the right one).
 */
export async function uploadMedia(
  api: Api,
  fake: FakeStorage,
  user: TestUser,
  opts: { owner?: Owner; kind?: 'PHOTO' | 'VIDEO'; caption?: string; asset?: Partial<ProviderAsset>; mimeType?: string } = {},
) {
  const kind = opts.kind ?? 'PHOTO';
  const slot = await requestSlot(api, user, {
    owner: opts.owner ?? { type: 'PLAYER' },
    mimeType: opts.mimeType ?? (kind === 'PHOTO' ? 'image/jpeg' : 'video/mp4'),
    sizeBytes: kind === 'PHOTO' ? 500_000 : 20_000_000,
    ...(opts.caption !== undefined ? { caption: opts.caption } : {}),
  });
  if (slot.status !== 201) throw new Error(`slot refused: ${slot.status} ${JSON.stringify(slot.body)}`);
  const id = slot.body.media.id as string;
  const key = await keyOf(id);
  fake.put(key, kind === 'PHOTO' ? 'image' : 'video', kind === 'PHOTO' ? photoAsset(key, opts.asset) : videoAsset(key, opts.asset));
  const res = await confirm(api, user, id);
  return { id, key, slot, res };
}

/** A team with a captain, a vice captain and one plain member, plus an outsider who is not in it. */
export async function smallTeam(api: Api, prefix: string) {
  const T = TEAMS;
  const captain = await makeUser(api, `${prefix}-cap@example.com`);
  const teamId = (await api.call('POST', T, { name: `Media team ${prefix}` }, captain.token)).body.team.id as string;
  const join = async (u: TestUser) => {
    const inv = await api.call('POST', `${T}/${teamId}/invitations`, { userId: u.userId }, captain.token);
    await api.call('POST', `${T}/invitations/${inv.body.invitation.id}/accept`, {}, u.token);
  };
  const vice = await makeUser(api, `${prefix}-vice@example.com`);
  const member = await makeUser(api, `${prefix}-mem@example.com`);
  const outsider = await makeUser(api, `${prefix}-out@example.com`);
  await join(vice);
  await join(member);
  await api.call('PATCH', `${T}/${teamId}/members/${vice.userId}`, { role: 'VICE_CAPTAIN' }, captain.token);
  return { teamId, captain, vice, member, outsider };
}
export type SmallTeam = Awaited<ReturnType<typeof smallTeam>>;

/** Inserts media rows directly (bypassing the API) for tests of the database rules and of the worker. */
export async function insertRow(over: Record<string, unknown> & { ownerUserId?: string | null; teamId?: string | null; uploadedById: string }) {
  const prisma = await prismaP();
  const id = crypto.randomUUID();
  await prisma.mediaItem.create({
    data: { id, kind: 'PHOTO', provider: 'CLOUDINARY', storageKey: `fym/media/${id}`, mimeType: 'image/jpeg', ...over } as never,
  });
  return id;
}

/** Simulates time passing (ages a row): runs a statement with triggers off, like moveMatchTime does for matches. Test setup only. */
export async function asIfTimePassed(statement: string, ...params: unknown[]) {
  const prisma = await prismaP();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRawUnsafe(statement, ...params);
  });
}

/**
 * Opens `n` database connections before a concurrency test. Connections are opened lazily, and on a development machine opening a burst of them
 * takes seconds, which would exceed Prisma's 2 s limit for STARTING a transaction and show up as a spurious 500 (P2028) that has nothing to do with
 * the rule under test. With a warm pool the same burst runs in milliseconds.
 */
export async function warmPool(n = 16) {
  const prisma = await prismaP();
  await Promise.all(Array.from({ length: n }, () => prisma.$executeRaw`select pg_sleep(0.3)`));
}
