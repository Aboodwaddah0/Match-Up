import { Prisma, type VenuePermission } from '@prisma/client';
import type { z } from 'zod';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { formatHm, timeColumnToMinutes } from '../../lib/time';
import type { Actor } from '../../types/actor';
import { DEFAULT_PERMISSIONS, requireVenuePermission, venueRights } from './venues.access';
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

/** Edits the venue's details (requires EDIT_VENUE on this venue). */
export async function updateVenue(actor: Actor, id: string, input: z.infer<typeof updateVenueSchema>) {
  await requireVenuePermission(actor, id, 'EDIT_VENUE');
  if (input.cityId) await assertCity(input.cityId);
  const v = await prisma.venue.update({ where: { id }, data: input, include: venueInclude });
  return venueDto(v, { canSeeInactive: true });
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

/** Adds (or updates) a staff member with a role and permissions; defaults come from the role. The owner cannot be added as staff. */
export async function addStaff(actor: Actor, venueId: string, input: z.infer<typeof staffSchema>) {
  const { venue } = await requireVenuePermission(actor, venueId, 'MANAGE_STAFF');
  if (input.userId === venue.ownerId) throw new AppError(400, 'INVALID_STAFF', 'The owner already has full access');
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, status: true } });
  if (!user || user.status !== 'ACTIVE') throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

  const permissions = input.permissions ?? DEFAULT_PERMISSIONS[input.role];
  const row = await prisma.venueStaff.upsert({
    where: { venueId_userId: { venueId, userId: input.userId } },
    create: { venueId, userId: input.userId, role: input.role, permissions },
    update: { role: input.role, permissions },
  });
  return { staff: { userId: row.userId, role: row.role, permissions: row.permissions } };
}

/** Staff of one venue (requires MANAGE_STAFF). */
export async function listStaff(actor: Actor, venueId: string) {
  await requireVenuePermission(actor, venueId, 'MANAGE_STAFF');
  const rows = await prisma.venueStaff.findMany({ where: { venueId }, include: { user: { select: { id: true, fullName: true, avatarUrl: true } } } });
  return { staff: rows.map((r) => ({ userId: r.userId, fullName: r.user.fullName, avatarUrl: r.user.avatarUrl, role: r.role, permissions: r.permissions })) };
}

/** Removes a staff member from this venue only (permissions are never global). */
export async function removeStaff(actor: Actor, venueId: string, userId: string): Promise<void> {
  await requireVenuePermission(actor, venueId, 'MANAGE_STAFF');
  const res = await prisma.venueStaff.deleteMany({ where: { venueId, userId } });
  if (res.count === 0) throw new AppError(404, 'STAFF_NOT_FOUND', 'This user is not staff at the venue');
}

// ───────────────────────── images ─────────────────────────

/** Adds an image URL (max 10 per venue, appended last). Upload comes later, so these are https links. */
export async function addImage(actor: Actor, venueId: string, url: string) {
  await requireVenuePermission(actor, venueId, 'EDIT_VENUE');
  const count = await prisma.venueImage.count({ where: { venueId } });
  if (count >= 10) throw new AppError(409, 'TOO_MANY_IMAGES', 'A venue can have up to 10 images');
  const image = await prisma.venueImage.create({ data: { venueId, url, sortOrder: count } });
  return { image: { id: image.id, url: image.url } };
}

/** Removes one image of this venue. */
export async function removeImage(actor: Actor, venueId: string, imageId: string): Promise<void> {
  await requireVenuePermission(actor, venueId, 'EDIT_VENUE');
  const res = await prisma.venueImage.deleteMany({ where: { id: imageId, venueId } });
  if (res.count === 0) throw new AppError(404, 'IMAGE_NOT_FOUND', 'Image not found');
}
