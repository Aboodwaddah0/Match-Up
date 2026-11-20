import { randomUUID } from 'node:crypto';
import type { MediaItem, MediaKind, Prisma } from '@prisma/client';
import type { z } from 'zod';
import { env } from '../../config/env';
import { recordAdminAudit } from '../../lib/audit';
import { areBlocked } from '../../lib/blocks';
import { deliveryUrls, storage, StorageError, type ProviderAsset } from '../../lib/cloudinary';
import { withDeadlockRetry } from '../../lib/db-errors';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { toUserSummary, userSummarySelect, type UserSummaryRow } from '../../lib/user-summary';
import type { Actor } from '../../types/actor';
import { allowedFormats, maxBytes, MEDIA_LIMITS, mimeForFormat, resourceTypeFor, SUPPORTED_MIME } from './media.limits';
import type { updateMediaSchema, uploadInitSchema } from './media.schemas';

/*
 * Media: photos and videos of players and teams.
 *
 * LIFECYCLE (the database enforces the state machine, see migration 20261124000200_media_items):
 *   PENDING --confirm--> READY --delete / admin removal / account deletion--> DELETING --media worker--> row deleted
 *   PENDING --failed confirmation, or never confirmed within the TTL--------> DELETING
 *
 * WHO MAY DO WHAT
 *   player media  the owner only (upload, caption, order, delete). Others may view READY items unless blocked / the owner is not ACTIVE.
 *   team media    CAPTAIN and VICE_CAPTAIN (upload, caption, order, delete ANY item of their team). Members and outsiders only view.
 *   admin         removes any item through an audited action (adminRemoveMedia).
 * Team staff is re-checked INSIDE the transaction that confirms or deletes (with the membership row locked FOR SHARE, as challenge acceptance
 * does), so a demotion that races a confirm or a delete is serialized with it instead of being missed.
 *
 * LOCK ORDER (always the same, so these transactions cannot deadlock with each other or with account deletion): owner row first (the team row, or the
 * user row), then the membership row (teams only), then the media row. The insert trigger takes the same owner lock for the cap.
 */

type Tx = Prisma.TransactionClient;
type MediaWithUploader = MediaItem & { uploadedBy?: UserSummaryRow };

const PROVIDER_DOWN = () => new AppError(503, 'MEDIA_PROVIDER_UNAVAILABLE', 'The media storage is not reachable right now; try again in a moment');
const NOT_FOUND = () => new AppError(404, 'MEDIA_NOT_FOUND', 'Media not found');

function requireStorage(): void {
  if (!storage.configured()) throw new AppError(503, 'MEDIA_NOT_CONFIGURED', 'Media uploads are not available on this server');
}

/** What a client may see of one item. `status` is shown only to the person who just uploaded it (upload / confirm responses). */
function toDto(m: MediaWithUploader, opts: { withStatus?: boolean } = {}) {
  return {
    id: m.id,
    kind: m.kind,
    ...(opts.withStatus ? { status: m.status } : {}),
    url: m.url,
    thumbnailUrl: m.thumbnailUrl,
    mimeType: m.mimeType,
    sizeBytes: m.sizeBytes === null ? null : Number(m.sizeBytes), // at most 100 MiB: safe as a JSON number
    width: m.width,
    height: m.height,
    durationMs: m.durationMs,
    caption: m.caption,
    sortOrder: m.sortOrder,
    owner: m.teamId ? { type: 'TEAM' as const, teamId: m.teamId } : { type: 'PLAYER' as const, userId: m.ownerUserId },
    ...(m.uploadedBy ? { uploadedBy: toUserSummary(m.uploadedBy) } : {}),
    createdAt: m.createdAt,
  };
}

// ───────────────────────── locks and authorization ─────────────────────────

/**
 * Team staff gate, re-evaluated inside the caller's transaction. Optionally takes the team row first (FOR NO KEY UPDATE: parent before child, the
 * order challenge acceptance uses), then reads the caller's membership FOR SHARE: a captain transfer or removal that is in flight holds that row,
 * so this waits for it and decides on the committed role.
 */
async function requireTeamStaff(tx: Tx, teamId: string, userId: string, lockTeamRow: boolean): Promise<void> {
  if (lockTeamRow) {
    const team = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM team WHERE id = ${teamId}::uuid FOR NO KEY UPDATE`;
    if (team.length === 0) throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found');
  }
  const rows = await tx.$queryRaw<{ role: string }[]>`SELECT role::text AS role FROM team_member WHERE team_id = ${teamId}::uuid AND user_id = ${userId}::uuid FOR SHARE`;
  const role = rows[0]?.role;
  if (role !== 'CAPTAIN' && role !== 'VICE_CAPTAIN') {
    if (!lockTeamRow && !(await tx.team.findUnique({ where: { id: teamId }, select: { id: true } }))) throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found');
    throw new AppError(403, 'FORBIDDEN', 'Only the team captain or vice captain can manage team media');
  }
}

/**
 * Moves an item to DELETING: hidden at once (no URL), queued for the worker that deletes the file at the provider. Only PENDING / READY rows move.
 * A scheduled stray sweep is cleared: the deletion worker removes the object under EVERY resource type anyway.
 */
async function markDeleting(tx: Tx, mediaId: string): Promise<number> {
  return tx.$executeRaw`
    UPDATE media_item
       SET status = 'DELETING', url = NULL, thumbnail_url = NULL, deleting_since = now(), next_deletion_at = now(), updated_at = now(),
           stray_sweeps_left = 0, stray_sweep_at = NULL, stray_sweep_attempts = 0, last_stray_error = NULL
     WHERE id = ${mediaId}::uuid AND status IN ('PENDING', 'READY')`;
}

/**
 * PRIV-01 / D18: the account's own (player) media becomes DELETING in the deletion transaction, so it is hidden from every read the moment the
 * account is anonymized; the worker removes the files afterwards and the rows only after the provider confirmed. TEAM media is not touched: it
 * belongs to the team and stays, its uploader now shows as "Deleted user". The caller already holds the user row FOR NO KEY UPDATE, which is also
 * the first lock of every confirmation of this user's media, so a confirm cannot slip a READY item in after this statement.
 */
export async function markPlayerMediaForDeletion(tx: Tx, userId: string): Promise<number> {
  return tx.$executeRaw`
    UPDATE media_item
       SET status = 'DELETING', url = NULL, thumbnail_url = NULL, deleting_since = now(), next_deletion_at = now(), updated_at = now(),
           stray_sweeps_left = 0, stray_sweep_at = NULL, stray_sweep_attempts = 0, last_stray_error = NULL
     WHERE owner_user_id = ${userId}::uuid AND status IN ('PENDING', 'READY')`;
}

/**
 * Loads an item the actor is allowed to MANAGE (caption, order, delete) and locks it. Items the actor cannot see answer 404; items they can see but
 * may not manage answer 403. Runs inside a transaction (the staff check is part of it).
 */
async function loadManageable(tx: Tx, actor: Actor, mediaId: string): Promise<MediaItem> {
  const m = await tx.mediaItem.findUnique({ where: { id: mediaId } });
  if (!m || m.status === 'DELETING') throw NOT_FOUND();
  if (m.teamId) {
    // someone else's unconfirmed upload is invisible to the rest of the team
    if (m.status === 'PENDING' && m.uploadedById !== actor.userId) throw NOT_FOUND();
    await requireTeamStaff(tx, m.teamId, actor.userId, false);
  } else if (m.ownerUserId !== actor.userId) {
    if (m.status === 'PENDING' || !(await playerMediaVisibleTo(actor.userId, m.ownerUserId!))) throw NOT_FOUND();
    throw new AppError(403, 'FORBIDDEN', 'You can only manage your own media');
  }
  // Lock the row and read the status again: a removal, an account deletion or a confirmation that committed since the read above wins.
  const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM media_item WHERE id = ${mediaId}::uuid FOR UPDATE`;
  if (locked[0]?.status === 'DELETING') throw NOT_FOUND();
  return { ...m, status: locked[0]!.status as MediaItem['status'] };
}

/** Player media is visible to everyone except when the owner is not ACTIVE or the two users blocked each other (404, like profiles). */
async function playerMediaVisibleTo(viewerId: string, ownerId: string): Promise<boolean> {
  if (viewerId === ownerId) return true;
  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { status: true } });
  if (!owner || owner.status !== 'ACTIVE') return false;
  return !(await areBlocked(viewerId, ownerId));
}

/** Can this user see (and so report) this item? READY only; player media also needs the owner to be visible to them. Used by the report endpoint. */
export async function canSeeMedia(viewerId: string, mediaId: string): Promise<boolean> {
  const m = await prisma.mediaItem.findUnique({ where: { id: mediaId }, select: { status: true, ownerUserId: true } });
  if (!m || m.status !== 'READY') return false;
  return m.ownerUserId ? playerMediaVisibleTo(viewerId, m.ownerUserId) : true;
}

// ───────────────────────── upload: ask for a slot ─────────────────────────

/**
 * Step 1 of an upload. Creates a PENDING row with a server-chosen storage key ("<folder>/media/<row id>") and returns signed parameters for a
 * direct upload to Cloudinary. The client never chooses the key. The cap (30 per player, 50 per team) and the active-account rule are enforced by
 * database triggers under the owner row lock; for a team the staff check happens in the same transaction.
 */
export async function initUpload(actor: Actor, input: z.infer<typeof uploadInitSchema>) {
  requireStorage();
  const { kind } = SUPPORTED_MIME[input.mimeType];
  if (input.sizeBytes > maxBytes(kind)) {
    throw new AppError(400, 'MEDIA_TOO_LARGE', `A ${kind === 'PHOTO' ? 'photo' : 'video'} can be at most ${maxBytes(kind) / (1024 * 1024)} MB`);
  }
  const id = randomUUID();
  const storageKey = `${env.CLOUDINARY_FOLDER}/media/${id}`;

  const row = await withDeadlockRetry(() =>
    prisma.$transaction(async (tx) => {
      if (input.owner.type === 'TEAM') await requireTeamStaff(tx, input.owner.teamId, actor.userId, true);
      return tx.mediaItem.create({
        data: {
          id,
          ...(input.owner.type === 'TEAM' ? { teamId: input.owner.teamId } : { ownerUserId: actor.userId }),
          uploadedById: actor.userId,
          kind,
          provider: 'CLOUDINARY',
          storageKey,
          mimeType: input.mimeType,
          caption: input.caption ?? null,
        },
      });
    }),
  );
  const upload = storage.signUpload({ key: storageKey, resourceType: resourceTypeFor(kind), allowedFormats: allowedFormats(kind) });
  return { media: toDto(row, { withStatus: true }), upload };
}

// ───────────────────────── upload: confirm ─────────────────────────

export type RejectReason = 'NOT_FOUND' | 'WRONG_RESOURCE_TYPE' | 'WRONG_DELIVERY_TYPE' | 'WRONG_PUBLIC_ID' | 'UNSUPPORTED_FORMAT' | 'FORMAT_KIND_MISMATCH' | 'TOO_LARGE' | 'TOO_LONG' | 'MISSING_METADATA';

export type Verdict =
  | { ok: true; mimeType: string; sizeBytes: number; width: number | null; height: number | null; durationMs: number | null; version: number }
  | { ok: false; reason: RejectReason };

/**
 * Decides, from the PROVIDER's description alone, whether the stored file is what this row announced. Nothing the client sent is consulted: the row
 * supplies only the kind and the storage key (both chosen by the server). Pure function, so every rule is unit-tested.
 */
export function verifyAsset(row: { kind: MediaKind; storageKey: string }, asset: ProviderAsset | null): Verdict {
  const no = (reason: RejectReason): Verdict => ({ ok: false, reason });
  if (!asset) return no('NOT_FOUND'); // nothing under the expected resource type (an object stored under another type is treated the same way)
  if (asset.resourceType !== resourceTypeFor(row.kind)) return no('WRONG_RESOURCE_TYPE');
  if (asset.deliveryType !== 'upload') return no('WRONG_DELIVERY_TYPE');
  if (asset.publicId !== row.storageKey) return no('WRONG_PUBLIC_ID'); // binds the answer to THIS row's key
  const fmt = mimeForFormat(asset.format);
  if (!fmt) return no('UNSUPPORTED_FORMAT');
  if (fmt.kind !== row.kind) return no('FORMAT_KIND_MISMATCH');
  if (!Number.isInteger(asset.bytes) || asset.bytes <= 0) return no('MISSING_METADATA');
  if (asset.bytes > maxBytes(row.kind)) return no('TOO_LARGE');
  if (!Number.isInteger(asset.version) || asset.version <= 0) return no('MISSING_METADATA');
  if (row.kind === 'PHOTO') {
    if (!asset.width || !asset.height) return no('MISSING_METADATA');
    return { ok: true, mimeType: fmt.mime, sizeBytes: asset.bytes, width: asset.width, height: asset.height, durationMs: null, version: asset.version };
  }
  if (asset.durationSec === null || asset.durationSec <= 0) return no('MISSING_METADATA');
  const durationMs = Math.round(asset.durationSec * 1000);
  if (durationMs > MEDIA_LIMITS.videoMs) return no('TOO_LONG');
  return { ok: true, mimeType: fmt.mime, sizeBytes: asset.bytes, width: asset.width, height: asset.height, durationMs, version: asset.version };
}

type ConfirmOutcome = { type: 'ready'; row: MediaItem } | { type: 'failed'; error: AppError };

/**
 * Step 3 of an upload (after the app has uploaded the file). The caller sends only the row id; everything else comes from the database and the provider.
 *
 *  a. A short transaction loads the row (only the person who asked for the slot may confirm it; a READY item answers idempotently).
 *  b. NO database lock is held while the provider is asked (a network call must not hold row locks).
 *  c. The provider is asked for the asset stored under THIS row's key and the EXPECTED resource type. A file uploaded under another resource type
 *     (the signature does not cover the type) is simply not found there, which fails the upload; the deletion worker removes such strays.
 *  d. A second transaction decides: owner / team lock, staff re-check, row lock, state re-check, then READY or - for ANY failure after a legitimate
 *     request reached this point (rejected file, lost team role) - DELETING, so the object is cleaned up by the retryable worker.
 * A provider that cannot answer (network, rate limit, bad credentials) changes nothing: the row stays PENDING and the client may retry.
 */
export async function confirmUpload(actor: Actor, mediaId: string) {
  requireStorage();
  const row = await prisma.mediaItem.findUnique({ where: { id: mediaId } });
  // Only the person who asked for the slot confirms it; for everyone else the row does not exist (it is not visible to them yet).
  if (!row || row.uploadedById !== actor.userId || row.status === 'DELETING') throw NOT_FOUND();
  if (row.status === 'READY') return { media: toDto(row, { withStatus: true }) };

  let asset: ProviderAsset | null;
  try {
    asset = await storage.describe(row.storageKey, resourceTypeFor(row.kind));
  } catch (err) {
    if (err instanceof StorageError) throw PROVIDER_DOWN();
    throw err;
  }
  const verdict = verifyAsset(row, asset);

  const outcome = await withDeadlockRetry(() =>
    prisma.$transaction(async (tx): Promise<ConfirmOutcome> => {
      // owner row first (the same order as the insert trigger and account deletion), then the membership, then the media row
      let roleError: AppError | null = null;
      if (row.teamId) {
        try {
          await requireTeamStaff(tx, row.teamId, actor.userId, true);
        } catch (err) {
          if (!(err instanceof AppError) || err.status !== 403) throw err;
          roleError = err;
        }
      } else {
        await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${row.ownerUserId}::uuid FOR NO KEY UPDATE`;
      }
      const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM media_item WHERE id = ${mediaId}::uuid FOR UPDATE`;
      const status = locked[0]?.status;
      if (status === 'READY') return { type: 'ready', row: (await tx.mediaItem.findUniqueOrThrow({ where: { id: mediaId } })) };
      if (status !== 'PENDING') return { type: 'failed', error: NOT_FOUND() }; // removed meanwhile (account deletion, TTL sweep, deletion by the user)

      if (roleError || !verdict.ok) {
        await markDeleting(tx, mediaId);
        const error = roleError ?? new AppError(422, 'MEDIA_REJECTED', 'The uploaded file was rejected', { reason: (verdict as { reason: RejectReason }).reason });
        return { type: 'failed', error };
      }

      // next position: after the current READY items of the same owner, decided under the owner lock
      const next = await tx.mediaItem.aggregate({ where: { status: 'READY', ...(row.teamId ? { teamId: row.teamId } : { ownerUserId: row.ownerUserId }) }, _max: { sortOrder: true } });
      const urls = deliveryUrls(row.kind, row.storageKey, verdict.version);
      const ready = await tx.mediaItem.update({
        where: { id: mediaId },
        data: {
          status: 'READY',
          url: urls.url,
          thumbnailUrl: urls.thumbnailUrl,
          mimeType: verdict.mimeType,
          sizeBytes: BigInt(verdict.sizeBytes),
          width: verdict.width,
          height: verdict.height,
          durationMs: verdict.durationMs,
          sortOrder: (next._max.sortOrder ?? -1) + 1,
          confirmedAt: new Date(),
          // Three cleanups of stray provider objects (a file under another resource type, which the upload signature allows) are scheduled in the SAME
          // transaction as the publication: one due now, one when the upload window has closed, one a day later. They run in the media worker and can
          // never fail this confirmation.
          straySweepsLeft: 3,
          straySweepAt: new Date(),
        },
      });
      return { type: 'ready', row: ready };
    }),
  );
  if (outcome.type === 'failed') throw outcome.error;
  return { media: toDto(outcome.row, { withStatus: true }) };
}

// ───────────────────────── lists ─────────────────────────

const READY_ORDER = [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] as const satisfies Prisma.MediaItemOrderByWithRelationInput[];

/** A player's READY media. 404 (like the profile) when the player does not exist, is not ACTIVE, or the two users blocked each other. */
export async function listPlayerMedia(actor: Actor, userId: string) {
  if (!(await playerMediaVisibleTo(actor.userId, userId))) throw new AppError(404, 'PLAYER_NOT_FOUND', 'Player not found');
  const rows = await prisma.mediaItem.findMany({ where: { ownerUserId: userId, status: 'READY' }, orderBy: [...READY_ORDER] });
  return { media: rows.map((m) => toDto(m)), count: rows.length, limit: MEDIA_LIMITS.perPlayer };
}

/** A team's READY media (teams are readable by every signed-in user). `canManage` tells the app whether to show the edit controls. */
export async function listTeamMedia(actor: Actor, teamId: string) {
  if (!(await prisma.team.findUnique({ where: { id: teamId }, select: { id: true } }))) throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found');
  const [rows, membership] = await Promise.all([
    prisma.mediaItem.findMany({ where: { teamId, status: 'READY' }, orderBy: [...READY_ORDER], include: { uploadedBy: { select: userSummarySelect } } }),
    prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId: actor.userId } }, select: { role: true } }),
  ]);
  return {
    media: rows.map((m) => toDto(m)),
    count: rows.length,
    limit: MEDIA_LIMITS.perTeam,
    canManage: membership?.role === 'CAPTAIN' || membership?.role === 'VICE_CAPTAIN',
  };
}

// ───────────────────────── caption, order, delete ─────────────────────────

/** Changes the caption and / or the display position of a READY item. (Only these two fields are editable; the database refuses anything else.) */
export async function updateMedia(actor: Actor, mediaId: string, input: z.infer<typeof updateMediaSchema>) {
  const row = await withDeadlockRetry(() =>
    prisma.$transaction(async (tx) => {
      const m = await loadManageable(tx, actor, mediaId);
      if (m.status !== 'READY') throw new AppError(409, 'MEDIA_NOT_READY', 'This upload is not confirmed yet');
      return tx.mediaItem.update({
        where: { id: mediaId },
        data: { ...(input.caption !== undefined ? { caption: input.caption } : {}), ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}) },
      });
    }),
  );
  return { media: toDto(row, { withStatus: true }) };
}

/** Deletes an item: it disappears at once and the file is removed at the provider by the worker (the row goes only after that). Works on PENDING too. */
export async function deleteMedia(actor: Actor, mediaId: string): Promise<void> {
  await withDeadlockRetry(() =>
    prisma.$transaction(async (tx) => {
      await loadManageable(tx, actor, mediaId);
      await markDeleting(tx, mediaId);
    }),
  );
}

// ───────────────────────── admin ─────────────────────────

/**
 * An administrator removes any item (reported or not). Same effect as a delete, plus ONE immutable audit record in the same transaction
 * (MEDIA_REMOVED_BY_ADMIN). The status is decided under the row lock, so two simultaneous removals produce one record and one 409.
 * Metadata holds ids and small facts only; the caption (free text) is never copied into the audit log.
 */
export async function adminRemoveMedia(adminId: string, mediaId: string, reason: string | null | undefined, requestId?: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM media_item WHERE id = ${mediaId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw NOT_FOUND();
    if (rows[0]!.status === 'DELETING') throw new AppError(409, 'INVALID_STATE', 'This media is already being removed');
    const m = await tx.mediaItem.findUniqueOrThrow({ where: { id: mediaId } });
    await markDeleting(tx, mediaId);
    await recordAdminAudit(tx, {
      actorId: adminId,
      action: 'MEDIA_REMOVED_BY_ADMIN',
      targetType: 'MEDIA',
      targetId: mediaId,
      reason,
      metadata: {
        kind: m.kind,
        fromStatus: m.status,
        ownerType: m.teamId ? 'TEAM' : 'PLAYER',
        ...(m.teamId ? { teamId: m.teamId } : { ownerUserId: m.ownerUserId }),
        uploadedById: m.uploadedById,
      },
      requestId,
    });
  });
}
