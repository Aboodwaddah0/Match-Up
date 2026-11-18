import { Prisma, type VenuePermission } from '@prisma/client';
import type { z } from 'zod';
import { recordAdminAudit } from '../../lib/audit';
import { AppError } from '../../lib/errors';
import { lockVenue } from '../../lib/locks';
import { prisma } from '../../lib/prisma';
import { formatHm, timeColumnToMinutes } from '../../lib/time';
import type { Actor } from '../../types/actor';
import { DEFAULT_PERMISSIONS, isVenueAdminOverride, requireVenuePermission, venueRights, type VenueRights } from './venues.access';
import type { createVenueSchema, staffSchema, updateVenueSchema, venueSearchSchema } from './venues.schemas';

const venueInclude = {
  city: { select: { id: true, nameAr: true, nameEn: true } },
  images: { orderBy: { sortOrder: 'asc' } },
  fields: { include: { openingHours: true }, orderBy: { name: 'asc' } },
} satisfies Prisma.VenueInclude;
type VenueRow = Prisma.VenueGetPayload<{ include: typeof venueInclude }>;

function fieldDto(f: VenueRow['fields'][number]) {
  return {
    id: f.id,
    name: f.name,
    format: f.format,
    capacity: f.capacity,
    pricePerHour: Number(f.pricePerHour),
    currency: f.currency,
    slotMinutes: f.slotMinutes,
    isActive: f.isActive,
    openingHours: f.openingHours
      .map((h) => ({ weekday: h.weekday, open: formatHm(timeColumnToMinutes(h.openTime)), close: formatHm(timeColumnToMinutes(h.closeTime)) }))
      .sort((a, b) => a.weekday - b.weekday || a.open.localeCompare(b.open)),
  };
}

function venueDto(v: VenueRow, viewer?: { canSeeInactive: boolean; distanceKm?: number }) {
  return {
    id: v.id,
    name: v.name,
    description: v.description,
    status: v.status,
    city: v.city,
    address: v.address,
    latitude: v.latitude,
    longitude: v.longitude,
    contactPhone: v.contactPhone,
    timezone: v.timezone,
    distanceKm: viewer?.distanceKm === undefined ? undefined : Math.round(viewer.distanceKm * 10) / 10,
    images: v.images.map((i) => ({ id: i.id, url: i.url })),
    fields: v.fields.filter((f) => f.isActive || viewer?.canSeeInactive).map(fieldDto),
  };
}

/** Loads a venue with images and fields; 404 if it does not exist. */
async function load(id: string): Promise<VenueRow> {
  const v = await prisma.venue.findUnique({ where: { id }, include: venueInclude });
  if (!v) throw new AppError(404, 'VENUE_NOT_FOUND', 'Venue not found');
  return v;
}

async function assertCity(cityId: string) {
  if (!(await prisma.city.findUnique({ where: { id: cityId } }))) throw new AppError(400, 'INVALID_CITY', 'Unknown city');
}

/** Registers a venue; the caller becomes its owner (Venue.ownerId) and gets full rights on it. */
export async function createVenue(actor: Actor, input: z.infer<typeof createVenueSchema>) {
  await assertCity(input.cityId);
  const v = await prisma.venue.create({ data: { ...input, ownerId: actor.userId }, include: venueInclude });
  return venueDto(v, { canSeeInactive: true });
}

/**
 * Venue details. A venue that is not ACTIVE (inactive / suspended) is visible only to its owner, its staff and admins;
 * everyone else gets 404. `myAccess` tells staff what they may do here (permissions are per venue, D2).
 */
export async function getVenue(actor: Actor, id: string) {
  const v = await load(id);
  const rights = await venueRights(actor, id);
  const isStaff = rights.isOwner || rights.staff !== null || actor.role === 'ADMIN';
  if (v.status !== 'ACTIVE' && !isStaff) throw new AppError(404, 'VENUE_NOT_FOUND', 'Venue not found');
  return {
    ...venueDto(v, { canSeeInactive: isStaff }),
    myAccess: isStaff
      ? { owner: rights.isOwner, role: rights.staff?.role ?? (rights.isOwner ? 'OWNER' : 'ADMIN'), permissions: (['MANAGE_BOOKINGS', 'MANAGE_FIELDS', 'MANAGE_AVAILABILITY', 'EDIT_VENUE', 'MANAGE_STAFF', 'VIEW_REPORTS'] as VenuePermission[]).filter(rights.can) }
      : null,
  };
}

/**
 * Edits the venue's details (requires EDIT_VENUE on this venue). An administrator editing a venue they do not own leaves an audit
 * record (AUD-07) naming the fields that really changed (never their values), in the same transaction; an edit that changes nothing
 * is not recorded.
 */
export async function updateVenue(actor: Actor, id: string, input: z.infer<typeof updateVenueSchema>, requestId?: string) {
  const rights = await requireVenuePermission(actor, id, 'EDIT_VENUE');
  if (input.cityId) await assertCity(input.cityId);
  const audited = isVenueAdminOverride(actor, rights);

  await prisma.$transaction(async (tx) => {
    if (audited) await lockVenue(tx, id);
    const before = audited ? await tx.venue.findUniqueOrThrow({ where: { id } }) : null;
    if (input.status !== undefined) {
      // An owner may switch the venue ACTIVE <-> INACTIVE, but must never undo an administrator's suspension (moderation
      // would be meaningless). The "not SUSPENDED" condition is part of the UPDATE itself, so it is atomic: it also holds
      // when an admin suspends the venue between our permission check and this write.
      const r = await tx.venue.updateMany({ where: { id, status: { not: 'SUSPENDED' } }, data: input });
      if (r.count === 0) throw new AppError(403, 'VENUE_SUSPENDED', 'This venue was suspended by an administrator; contact support');
    } else {
      await tx.venue.update({ where: { id }, data: input });
    }
    if (before) {
      const changed = Object.entries(input).filter(([k, val]) => (before as Record<string, unknown>)[k] !== (val ?? null)).map(([k]) => k);
      if (changed.length > 0) {
        const statusChange = changed.includes('status') ? { fromStatus: before.status, toStatus: input.status! } : {};
        await recordAdminAudit(tx, { actorId: actor.userId, action: 'VENUE_UPDATED_BY_ADMIN', targetType: 'VENUE', targetId: id, metadata: { changedFields: changed, ...statusChange }, requestId });
      }
    }
  });
  return venueDto(await load(id), { canSeeInactive: true });
}

/** Venues I own or work at. */
export async function myVenues(actor: Actor) {
  const rows = await prisma.venue.findMany({
    where: { OR: [{ ownerId: actor.userId }, { staff: { some: { userId: actor.userId } } }] },
    include: venueInclude,
    orderBy: { name: 'asc' },
  });
  return { venues: rows.map((v) => ({ ...venueDto(v, { canSeeInactive: true }), owner: v.ownerId === actor.userId })) };
}

/**
 * Searches ACTIVE venues by name, city, field format and distance. Distance uses the earthdistance extension:
 * `earth_box` first narrows candidates with an index-friendly box, then `earth_distance` applies the exact radius.
 * The name filter escapes LIKE wildcards so user input is matched literally.
 */
export async function searchVenues(q: z.infer<typeof venueSearchSchema>) {
  const conds: Prisma.Sql[] = [Prisma.sql`v.status = 'ACTIVE'`];
  if (q.cityId) conds.push(Prisma.sql`v.city_id = ${q.cityId}::uuid`);
  if (q.q) conds.push(Prisma.sql`v.name ILIKE ${'%' + q.q.replace(/[%_\\]/g, '\\$&') + '%'}`);
  if (q.format) conds.push(Prisma.sql`EXISTS (SELECT 1 FROM venue_field f WHERE f.venue_id = v.id AND f.is_active AND f.format = ${q.format}::match_format)`);

  let distance = Prisma.sql`NULL::float8`;
  let order = Prisma.sql`v.name ASC, v.id ASC`;
  if (q.lat !== undefined && q.lng !== undefined) {
    const meters = q.radiusKm * 1000;
    const here = Prisma.sql`ll_to_earth(${q.lat}::float8, ${q.lng}::float8)`;
    const there = Prisma.sql`ll_to_earth(v.latitude, v.longitude)`;
    conds.push(Prisma.sql`earth_box(${here}, ${meters}::float8) @> ${there} AND earth_distance(${here}, ${there}) <= ${meters}::float8`);
    distance = Prisma.sql`earth_distance(${here}, ${there}) / 1000.0`;
    order = Prisma.sql`distance_km ASC, v.id ASC`;
  }

  const found = await prisma.$queryRaw<{ id: string; distance_km: number | null }[]>`
    SELECT v.id, ${distance} AS distance_km FROM venue v
     WHERE ${Prisma.join(conds, ' AND ')}
     ORDER BY ${order} LIMIT ${q.pageSize + 1} OFFSET ${(q.page - 1) * q.pageSize}`;

  const page = found.slice(0, q.pageSize);
  const rows = await prisma.venue.findMany({ where: { id: { in: page.map((r) => r.id) } }, include: venueInclude });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const venues = page.flatMap((r) => {
    const v = byId.get(r.id);
    return v ? [venueDto(v, { canSeeInactive: false, distanceKm: r.distance_km === null ? undefined : Number(r.distance_km) })] : [];
  });
  return { venues, page: q.page, pageSize: q.pageSize, hasMore: found.length > q.pageSize };
}

// ───────────────────────── staff (per-venue permissions, D2) ─────────────────────────

/**
 * Rules that stop staff-management from becoming a way to escalate (audit AUTHZ-01). They apply to staff who are NOT the
 * owner (or an admin); the owner may do anything:
 *  1. nobody edits their own access;
 *  2. only the owner grants MANAGE_STAFF (it is the permission to hand out permissions);
 *  3. delegation never exceeds what you hold yourself: you cannot give a permission you do not have;
 *  4. you cannot change or remove someone who holds MANAGE_STAFF, or a permission you do not hold (they are your equal or senior).
 * Before this, a staff member holding only MANAGE_STAFF could give themselves every permission and strip other managers.
 */
async function assertCanDelegate(rights: VenueRights, actor: Actor, venueId: string, targetUserId: string, granted: VenuePermission[] | null) {
  if (rights.isOwner || actor.role === 'ADMIN') return;
  if (granted !== null) {
    if (targetUserId === actor.userId) throw new AppError(403, 'CANNOT_EDIT_OWN_ACCESS', 'You cannot change your own access to this venue');
    if (granted.includes('MANAGE_STAFF')) throw new AppError(403, 'ONLY_OWNER_GRANTS_STAFF_MANAGEMENT', 'Only the venue owner can give the permission to manage staff');
    const unheld = granted.filter((p) => !rights.can(p));
    if (unheld.length > 0) throw new AppError(403, 'CANNOT_GRANT_UNHELD_PERMISSION', `You cannot give permissions you do not have: ${unheld.join(', ')}`);
  }
  const existing = await prisma.venueStaff.findUnique({ where: { venueId_userId: { venueId, userId: targetUserId } } });
  if (existing && targetUserId !== actor.userId && (existing.permissions.includes('MANAGE_STAFF') || existing.permissions.some((p) => !rights.can(p)))) {
    throw new AppError(403, 'CANNOT_MANAGE_SENIOR_STAFF', 'You cannot change or remove someone who has permissions you do not have');
  }
}

/**
 * Adds (or updates) a staff member with a role and permissions; defaults come from the role. The owner cannot be added as staff. See assertCanDelegate for who may do what.
 * An administrator doing this on a venue they do not own leaves an audit record (AUD-07) when the staff row is new or its role / permissions change.
 */
export async function addStaff(actor: Actor, venueId: string, input: z.infer<typeof staffSchema>, requestId?: string) {
  const rights = await requireVenuePermission(actor, venueId, 'MANAGE_STAFF');
  const { venue } = rights;
  if (input.userId === venue.ownerId) throw new AppError(400, 'INVALID_STAFF', 'The owner already has full access');
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, status: true } });
  if (!user || user.status !== 'ACTIVE') throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

  const permissions = input.permissions ?? DEFAULT_PERMISSIONS[input.role];
  await assertCanDelegate(rights, actor, venueId, input.userId, permissions);
  const audited = isVenueAdminOverride(actor, rights);
  const row = await prisma.$transaction(async (tx) => {
    if (audited) await lockVenue(tx, venueId);
    const before = audited ? await tx.venueStaff.findUnique({ where: { venueId_userId: { venueId, userId: input.userId } } }) : null;
    const saved = await tx.venueStaff.upsert({
      where: { venueId_userId: { venueId, userId: input.userId } },
      create: { venueId, userId: input.userId, role: input.role, permissions },
      update: { role: input.role, permissions },
    });
    if (audited) {
      const same = before && before.role === saved.role && before.permissions.length === saved.permissions.length && before.permissions.every((p) => saved.permissions.includes(p));
      if (!same) {
        await recordAdminAudit(tx, {
          actorId: actor.userId,
          action: before ? 'VENUE_STAFF_UPDATED_BY_ADMIN' : 'VENUE_STAFF_ADDED_BY_ADMIN',
          targetType: 'VENUE',
          targetId: venueId,
          metadata: { subjectUserId: input.userId, role: saved.role, permissions: saved.permissions },
          requestId,
        });
      }
    }
    return saved;
  });
  return { staff: { userId: row.userId, role: row.role, permissions: row.permissions } };
}

/** Staff of one venue (requires MANAGE_STAFF). */
export async function listStaff(actor: Actor, venueId: string) {
  await requireVenuePermission(actor, venueId, 'MANAGE_STAFF');
  const rows = await prisma.venueStaff.findMany({ where: { venueId }, include: { user: { select: { id: true, fullName: true, avatarUrl: true } } } });
  return { staff: rows.map((r) => ({ userId: r.userId, fullName: r.user.fullName, avatarUrl: r.user.avatarUrl, role: r.role, permissions: r.permissions })) };
}

/** Removes a staff member from this venue only (permissions are never global). A staff member may always remove THEMSELVES; removing others follows assertCanDelegate. An administrator's removal on a venue they do not own is audited (AUD-07). */
export async function removeStaff(actor: Actor, venueId: string, userId: string, requestId?: string): Promise<void> {
  const rights = await requireVenuePermission(actor, venueId, 'MANAGE_STAFF');
  await assertCanDelegate(rights, actor, venueId, userId, null);
  await prisma.$transaction(async (tx) => {
    const res = await tx.venueStaff.deleteMany({ where: { venueId, userId } });
    if (res.count === 0) throw new AppError(404, 'STAFF_NOT_FOUND', 'This user is not staff at the venue');
    if (isVenueAdminOverride(actor, rights)) {
      await recordAdminAudit(tx, { actorId: actor.userId, action: 'VENUE_STAFF_REMOVED_BY_ADMIN', targetType: 'VENUE', targetId: venueId, metadata: { subjectUserId: userId }, requestId });
    }
  });
}

// ───────────────────────── images ─────────────────────────

/** Adds an image URL (max 10 per venue, appended last). Upload comes later, so these are https links. An administrator's addition on a venue they do not own is audited (AUD-07; the image id, never the URL). */
export async function addImage(actor: Actor, venueId: string, url: string, requestId?: string) {
  const rights = await requireVenuePermission(actor, venueId, 'EDIT_VENUE');
  const image = await prisma.$transaction(async (tx) => {
    const audited = isVenueAdminOverride(actor, rights);
    if (audited) await lockVenue(tx, venueId);
    const count = await tx.venueImage.count({ where: { venueId } });
    if (count >= 10) throw new AppError(409, 'TOO_MANY_IMAGES', 'A venue can have up to 10 images');
    const created = await tx.venueImage.create({ data: { venueId, url, sortOrder: count } });
    if (audited) await recordAdminAudit(tx, { actorId: actor.userId, action: 'VENUE_IMAGE_ADDED_BY_ADMIN', targetType: 'VENUE', targetId: venueId, metadata: { imageId: created.id }, requestId });
    return created;
  });
  return { image: { id: image.id, url: image.url } };
}

/** Removes one image of this venue. An administrator's removal on a venue they do not own is audited (AUD-07). */
export async function removeImage(actor: Actor, venueId: string, imageId: string, requestId?: string): Promise<void> {
  const rights = await requireVenuePermission(actor, venueId, 'EDIT_VENUE');
  await prisma.$transaction(async (tx) => {
    const res = await tx.venueImage.deleteMany({ where: { id: imageId, venueId } });
    if (res.count === 0) throw new AppError(404, 'IMAGE_NOT_FOUND', 'Image not found');
    if (isVenueAdminOverride(actor, rights)) {
      await recordAdminAudit(tx, { actorId: actor.userId, action: 'VENUE_IMAGE_REMOVED_BY_ADMIN', targetType: 'VENUE', targetId: venueId, metadata: { imageId }, requestId });
    }
  });
}
