import type { Prisma, Venue, VenuePermission, VenueStaff } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { Actor } from '../../types/actor';

export interface VenueRights {
  venue: Venue;
  isOwner: boolean;
  staff: VenueStaff | null;
  can: (permission: VenuePermission) => boolean;
}

const ALL: VenuePermission[] = ['MANAGE_BOOKINGS', 'MANAGE_FIELDS', 'MANAGE_AVAILABILITY', 'EDIT_VENUE', 'MANAGE_STAFF', 'VIEW_REPORTS'];

export const DEFAULT_PERMISSIONS: Record<'MANAGER' | 'STAFF', VenuePermission[]> = {
  MANAGER: ['MANAGE_BOOKINGS', 'MANAGE_FIELDS', 'MANAGE_AVAILABILITY', 'EDIT_VENUE', 'VIEW_REPORTS'],
  STAFF: ['MANAGE_BOOKINGS', 'MANAGE_AVAILABILITY'],
};

/**
 * Permissions are scoped PER VENUE (D2): the owner (Venue.ownerId) can do everything there,
 * staff only what their VenueStaff row grants, admins everything. Nothing is global.
 */
export async function venueRights(actor: Actor, venueId: string): Promise<VenueRights> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId } });
  if (!venue) throw new AppError(404, 'VENUE_NOT_FOUND', 'Venue not found');
  const isOwner = venue.ownerId === actor.userId;
  const staff = isOwner ? null : await prisma.venueStaff.findUnique({ where: { venueId_userId: { venueId, userId: actor.userId } } });
  const granted = new Set<VenuePermission>(isOwner || actor.role === 'ADMIN' ? ALL : (staff?.permissions ?? []));
  return { venue, isOwner, staff, can: (p) => granted.has(p) };
}

/**
 * AUD-07: an administrator changing a venue they do NOT own is an override and is written to the admin audit log. Owners and staff
 * (also when they happen to be admins on their own venue) are ordinary venue management and are never recorded.
 */
export const isVenueAdminOverride = (actor: Actor, rights: VenueRights): boolean => actor.role === 'ADMIN' && !rights.isOwner;

/** Loads the venue and requires the permission; 404 for strangers of a hidden venue, 403 otherwise. */
export async function requireVenuePermission(actor: Actor, venueId: string, permission: VenuePermission): Promise<VenueRights> {
  const rights = await venueRights(actor, venueId);
  if (!rights.can(permission)) throw new AppError(403, 'FORBIDDEN', 'You do not have permission for this venue');
  return rights;
}

/**
 * Everyone who should hear about booking requests: the owner plus staff who manage bookings.
 * Pass the transaction client when calling inside a transaction so the read uses the same connection.
 */
export async function bookingManagerIds(venueId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<string[]> {
  const venue = await db.venue.findUniqueOrThrow({ where: { id: venueId }, select: { ownerId: true } });
  const staff = await db.venueStaff.findMany({ where: { venueId, permissions: { has: 'MANAGE_BOOKINGS' } }, select: { userId: true } });
  return [venue.ownerId, ...staff.map((s) => s.userId)];
}
