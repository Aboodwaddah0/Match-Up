import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MEDIA_LIMITS } from '../src/modules/media/media.limits';
import { resetDb } from './helpers/client';
import { prismaP } from './helpers/media';

/*
 * The database rules of media_item (migration 20261124000200_media_items), tested directly on the table, bypassing the API: the DATABASE is the last
 * line of defence, so every rule must hold even if a service forgets it. The limits are read from MEDIA_LIMITS, which ties the TypeScript constants
 * to the SQL numbers: if one side changes without the other, a boundary test below fails.
 */

let userA: string;
let userB: string;
let teamId: string;

const raw = async (sql: string, ...params: unknown[]) => (await prismaP()).$executeRawUnsafe(sql, ...params);

/** Inserts one row through Prisma. `over` may override anything; a player row by default. */
async function insert(over: Record<string, unknown> = {}) {
  const prisma = await prismaP();
  const id = randomUUID();
  const base = { id, ownerUserId: userA, uploadedById: userA, kind: 'PHOTO', provider: 'CLOUDINARY', storageKey: `fym/media/${id}`, mimeType: 'image/jpeg' };
  await prisma.mediaItem.create({ data: { ...base, ...over } as never });
  return id;
}
const ready = (over: Record<string, unknown> = {}) => ({ status: 'READY', url: 'https://res.cloudinary.com/x/image/upload/a', confirmedAt: new Date(), sizeBytes: 1000n, width: 10, height: 10, ...over });
const readyVideo = (over: Record<string, unknown> = {}) => ({ kind: 'VIDEO', mimeType: 'video/mp4', ...ready({ durationMs: 1000 }), ...over });
const deleting = (over: Record<string, unknown> = {}) => ({ status: 'DELETING', deletingSince: new Date(), nextDeletionAt: new Date(), ...over });

beforeAll(async () => {
  await resetDb();
});
afterAll(async () => {
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
  const prisma = await prismaP();
  const mk = (n: string) => prisma.user.create({ data: { email: `${n}@example.com`, passwordHash: 'x', fullName: n } });
  userA = (await mk('a')).id;
  userB = (await mk('b')).id;
  teamId = (await prisma.team.create({ data: { name: 'T' } })).id;
});

describe('shape and value constraints', () => {
  it('exactly one owner: a user (player media) or a team', async () => {
    await expect(insert({ ownerUserId: userA, teamId })).rejects.toThrow(/chk_media_one_owner/);
    await expect(insert({ ownerUserId: null, teamId: null })).rejects.toThrow(/chk_media_one_owner/);
    await expect(insert({ ownerUserId: null, teamId })).resolves.toBeTruthy();
  });

  it('player media is uploaded by its owner; team media may be uploaded by any user (the service checks the role)', async () => {
    await expect(insert({ ownerUserId: userA, uploadedById: userB })).rejects.toThrow(/chk_media_player_self_upload/);
    await expect(insert({ ownerUserId: null, teamId, uploadedById: userB })).resolves.toBeTruthy();
  });

  it.each([
    ['a photo with a video type', { kind: 'PHOTO', mimeType: 'video/mp4' }],
    ['a video with an image type', { kind: 'VIDEO', mimeType: 'image/jpeg' }],
    ['an unsupported image type', { mimeType: 'image/gif' }],
    ['an unsupported video type', { kind: 'VIDEO', mimeType: 'video/webm' }],
  ])('refuses %s', async (_n, over) => {
    await expect(insert(over)).rejects.toThrow(/chk_media_kind_mime/);
  });

  it.each([
    ['PHOTO', 'image/jpeg'],
    ['PHOTO', 'image/png'],
    ['PHOTO', 'image/webp'],
    ['PHOTO', 'image/heic'],
    ['VIDEO', 'video/mp4'],
    ['VIDEO', 'video/quicktime'],
  ])('accepts %s %s', async (kind, mimeType) => {
    await expect(insert({ kind, mimeType })).resolves.toBeTruthy();
  });

  it('size: at most 10 MiB per photo and 100 MiB per video, and positive', async () => {
    await expect(insert({ sizeBytes: BigInt(MEDIA_LIMITS.photoBytes) })).resolves.toBeTruthy();
    await expect(insert({ sizeBytes: BigInt(MEDIA_LIMITS.photoBytes + 1) })).rejects.toThrow(/chk_media_size/);
    await expect(insert({ kind: 'VIDEO', mimeType: 'video/mp4', sizeBytes: BigInt(MEDIA_LIMITS.videoBytes) })).resolves.toBeTruthy();
    await expect(insert({ kind: 'VIDEO', mimeType: 'video/mp4', sizeBytes: BigInt(MEDIA_LIMITS.videoBytes + 1) })).rejects.toThrow(/chk_media_size/);
    await expect(insert({ sizeBytes: 0n })).rejects.toThrow(/chk_media_size/);
  });

  it('duration: videos only, 1 ms to 60 s', async () => {
    await expect(insert({ kind: 'VIDEO', mimeType: 'video/mp4', durationMs: MEDIA_LIMITS.videoMs })).resolves.toBeTruthy();
    await expect(insert({ kind: 'VIDEO', mimeType: 'video/mp4', durationMs: MEDIA_LIMITS.videoMs + 1 })).rejects.toThrow(/chk_media_duration/);
    await expect(insert({ kind: 'VIDEO', mimeType: 'video/mp4', durationMs: 0 })).rejects.toThrow(/chk_media_duration/);
    await expect(insert({ durationMs: 1000 })).rejects.toThrow(/chk_media_duration/); // a photo has none
  });

  it('caption: at most 300 characters, never blank', async () => {
    await expect(insert({ caption: 'x'.repeat(MEDIA_LIMITS.captionChars) })).resolves.toBeTruthy();
    await expect(insert({ caption: 'x'.repeat(MEDIA_LIMITS.captionChars + 1) })).rejects.toThrow(/chk_media_caption/);
    await expect(insert({ caption: '   ' })).rejects.toThrow(/chk_media_caption/);
    await expect(insert({ caption: '' })).rejects.toThrow(/chk_media_caption/);
  });

  it('the storage reference is unique per provider, and not blank', async () => {
    const key = `fym/media/${randomUUID()}`;
    await insert({ storageKey: key });
    await expect(insert({ storageKey: key })).rejects.toThrow(/Unique constraint|media_item_provider_storage_key_key/);
    await expect(insert({ storageKey: key, provider: 'S3' })).resolves.toBeTruthy(); // another provider, another namespace
    await expect(insert({ storageKey: '  ' })).rejects.toThrow(/chk_media_storage_key/);
  });
});

describe('URL lifecycle', () => {
  it('PENDING has no delivery URL, thumbnail or confirmation time', async () => {
    await expect(insert({ url: 'https://res.cloudinary.com/x/a' })).rejects.toThrow(/chk_media_pending_shape/);
    await expect(insert({ thumbnailUrl: 'https://res.cloudinary.com/x/t' })).rejects.toThrow(/chk_media_pending_shape/);
    await expect(insert({ confirmedAt: new Date() })).rejects.toThrow(/chk_media_pending_shape/);
  });

  it('READY needs an https URL, a confirmation time and the verified size (and a duration for videos)', async () => {
    await expect(insert(ready())).resolves.toBeTruthy();
    await expect(insert(ready({ url: null }))).rejects.toThrow(/chk_media_ready_shape/);
    await expect(insert(ready({ url: 'http://res.cloudinary.com/x/a' }))).rejects.toThrow(/chk_media_ready_shape/);
    await expect(insert(ready({ url: 'javascript:alert(1)' }))).rejects.toThrow(/chk_media_ready_shape/);
    await expect(insert(ready({ confirmedAt: null }))).rejects.toThrow(/chk_media_ready_shape/);
    await expect(insert(ready({ sizeBytes: null }))).rejects.toThrow(/chk_media_ready_shape/);
    await expect(insert(readyVideo())).resolves.toBeTruthy();
    await expect(insert(readyVideo({ durationMs: null }))).rejects.toThrow(/chk_media_ready_shape/);
  });

  it('a thumbnail must be https too', async () => {
    await expect(insert(ready({ thumbnailUrl: 'http://res.cloudinary.com/x/t' }))).rejects.toThrow(/chk_media_thumbnail_https/);
    await expect(insert(ready({ thumbnailUrl: 'https://res.cloudinary.com/x/t' }))).resolves.toBeTruthy();
  });

  it('DELETING has no URL and is scheduled; deletion bookkeeping exists only while DELETING', async () => {
    await expect(insert(deleting())).resolves.toBeTruthy();
    await expect(insert(deleting({ url: 'https://res.cloudinary.com/x/a' }))).rejects.toThrow(/chk_media_deleting_shape/);
    await expect(insert(deleting({ nextDeletionAt: null }))).rejects.toThrow(/chk_media_deleting_shape/);
    await expect(insert({ deletingSince: new Date() })).rejects.toThrow(/chk_media_deletion_columns/);
    await expect(insert({ deletionAttempts: 2 })).rejects.toThrow(/chk_media_deletion_columns/);
    await expect(insert({ lastDeletionError: 'x' })).rejects.toThrow(/chk_media_deletion_columns/);
  });
});

describe('state machine and immutability (fym_media_guard)', () => {
  it('PENDING -> READY -> DELETING is allowed; nothing leaves DELETING; READY never goes back to PENDING', async () => {
    const prisma = await prismaP();
    const id = await insert();
    await expect(prisma.mediaItem.update({ where: { id }, data: ready() as never })).resolves.toBeTruthy();
    await expect(raw(`UPDATE media_item SET status = 'PENDING', url = NULL, confirmed_at = NULL WHERE id = $1::uuid`, id)).rejects.toThrow(/FYM_MEDIA_BAD_TRANSITION/);
    await expect(raw(`UPDATE media_item SET status = 'DELETING', url = NULL, deleting_since = now(), next_deletion_at = now() WHERE id = $1::uuid`, id)).resolves.toBe(1);
    await expect(raw(`UPDATE media_item SET status = 'READY', url = 'https://x.test/a', confirmed_at = now(), size_bytes = 1 WHERE id = $1::uuid`, id)).rejects.toThrow(/FYM_MEDIA_BAD_TRANSITION/);
    await expect(raw(`UPDATE media_item SET status = 'PENDING', deleting_since = NULL, next_deletion_at = NULL WHERE id = $1::uuid`, id)).rejects.toThrow(/FYM_MEDIA_BAD_TRANSITION/);
  });

  it('PENDING -> DELETING is allowed (a failed or abandoned upload)', async () => {
    const id = await insert();
    await expect(raw(`UPDATE media_item SET status = 'DELETING', deleting_since = now(), next_deletion_at = now() WHERE id = $1::uuid`, id)).resolves.toBe(1);
  });

  it('who, what and where never change: owner, team, uploader, kind, provider, storage key, creation time', async () => {
    const id = await insert(ready());
    await expect(raw(`UPDATE media_item SET owner_user_id = $2::uuid, uploaded_by_id = $2::uuid WHERE id = $1::uuid`, id, userB)).rejects.toThrow(/FYM_MEDIA_IMMUTABLE/);
    await expect(raw(`UPDATE media_item SET owner_user_id = NULL, team_id = $2::uuid WHERE id = $1::uuid`, id, teamId)).rejects.toThrow(/FYM_MEDIA_IMMUTABLE/);
    await expect(raw(`UPDATE media_item SET storage_key = 'fym/media/other' WHERE id = $1::uuid`, id)).rejects.toThrow(/FYM_MEDIA_IMMUTABLE/);
    await expect(raw(`UPDATE media_item SET provider = 'S3' WHERE id = $1::uuid`, id)).rejects.toThrow(/FYM_MEDIA_IMMUTABLE/);
    await expect(raw(`UPDATE media_item SET created_at = now() - interval '1 day' WHERE id = $1::uuid`, id)).rejects.toThrow(/FYM_MEDIA_IMMUTABLE/);
    const pending = await insert();
    await expect(raw(`UPDATE media_item SET kind = 'VIDEO', mime_type = 'video/mp4' WHERE id = $1::uuid`, pending)).rejects.toThrow(/FYM_MEDIA_IMMUTABLE/);
  });

  it('a READY item keeps its verified metadata: only the caption and the order can change', async () => {
    const id = await insert(ready());
    await expect(raw(`UPDATE media_item SET caption = 'hi', sort_order = 3 WHERE id = $1::uuid`, id)).resolves.toBe(1);
    await expect(raw(`UPDATE media_item SET url = 'https://evil.test/x' WHERE id = $1::uuid`, id)).rejects.toThrow(/FYM_MEDIA_IMMUTABLE/);
    await expect(raw(`UPDATE media_item SET size_bytes = 5 WHERE id = $1::uuid`, id)).rejects.toThrow(/FYM_MEDIA_IMMUTABLE/);
    await expect(raw(`UPDATE media_item SET mime_type = 'image/png' WHERE id = $1::uuid`, id)).rejects.toThrow(/FYM_MEDIA_IMMUTABLE/);
    await expect(raw(`UPDATE media_item SET confirmed_at = now() WHERE id = $1::uuid`, id)).rejects.toThrow(/FYM_MEDIA_IMMUTABLE/);
  });

  it('a PENDING item cannot be edited at all (no caption or order before it is confirmed)', async () => {
    const id = await insert();
    await expect(raw(`UPDATE media_item SET caption = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(/FYM_MEDIA_IMMUTABLE/);
  });

  it('a DELETING row changes only its deletion bookkeeping', async () => {
    const id = await insert(deleting());
    await expect(raw(`UPDATE media_item SET deletion_attempts = 2, last_deletion_error = 'HTTP_500', next_deletion_at = now() + interval '1 hour' WHERE id = $1::uuid`, id)).resolves.toBe(1);
    await expect(raw(`UPDATE media_item SET caption = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(/FYM_MEDIA_IMMUTABLE/);
  });
});

describe('a row is deleted only after its file (fym_media_delete_guard) and never cascaded away', () => {
  it('DELETE is refused for PENDING and READY rows and allowed for DELETING rows', async () => {
    const pending = await insert();
    const rdy = await insert(ready());
    const gone = await insert(deleting());
    await expect(raw(`DELETE FROM media_item WHERE id = $1::uuid`, pending)).rejects.toThrow(/FYM_MEDIA_NOT_DELETING/);
    await expect(raw(`DELETE FROM media_item WHERE id = $1::uuid`, rdy)).rejects.toThrow(/FYM_MEDIA_NOT_DELETING/);
    await expect(raw(`DELETE FROM media_item WHERE id = $1::uuid`, gone)).resolves.toBe(1);
  });

  it('a user or a team that still has media rows cannot be deleted (RESTRICT): the storage keys cannot be lost', async () => {
    await insert();
    await insert({ ownerUserId: null, teamId, uploadedById: userB });
    await expect(raw(`DELETE FROM "user" WHERE id = $1::uuid`, userA)).rejects.toThrow(/foreign key|violates/i);
    await expect(raw(`DELETE FROM team WHERE id = $1::uuid`, teamId)).rejects.toThrow(/foreign key|violates/i);
    await expect(raw(`DELETE FROM "user" WHERE id = $1::uuid`, userB)).rejects.toThrow(/foreign key|violates/i); // uploader of the team item
  });
});

describe('the cap per owner (fym_media_cap)', () => {
  it('30 items per player (pending and ready count), the 31st is refused; a DELETING item frees a slot', async () => {
    const ids: string[] = [];
    for (let i = 0; i < MEDIA_LIMITS.perPlayer; i++) ids.push(await insert(i % 2 ? ready() : {}));
    await expect(insert()).rejects.toThrow(/FYM_MEDIA_LIMIT/);
    await raw(`UPDATE media_item SET status = 'DELETING', url = NULL, deleting_since = now(), next_deletion_at = now() WHERE id = $1::uuid`, ids[0]);
    await expect(insert()).resolves.toBeTruthy();
    await expect(insert()).rejects.toThrow(/FYM_MEDIA_LIMIT/);
  });

  it('50 items per team; the player and the team counters are independent; another player is unaffected', async () => {
    for (let i = 0; i < MEDIA_LIMITS.perTeam; i++) await insert({ ownerUserId: null, teamId, uploadedById: userB });
    await expect(insert({ ownerUserId: null, teamId, uploadedById: userA })).rejects.toThrow(/FYM_MEDIA_LIMIT/);
    await expect(insert()).resolves.toBeTruthy(); // userA's own player media: another counter
    await expect(insert({ ownerUserId: userB, uploadedById: userB })).resolves.toBeTruthy();
  });

  it('a DELETED account gains no media, as owner or as uploader (PRIV-01 guard)', async () => {
    await raw(`UPDATE "user" SET status = 'DELETED' WHERE id = $1::uuid`, userB);
    await expect(insert({ ownerUserId: userB, uploadedById: userB })).rejects.toThrow(/FYM_USER_DELETED/);
    await expect(insert({ ownerUserId: null, teamId, uploadedById: userB })).rejects.toThrow(/FYM_USER_DELETED/);
    await expect(insert({ ownerUserId: null, teamId, uploadedById: userA })).resolves.toBeTruthy();
  });
});
