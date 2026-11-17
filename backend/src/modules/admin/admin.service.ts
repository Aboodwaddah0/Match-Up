import type { z } from 'zod';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { notify } from '../notifications/notify';
import { statsFor } from '../players/players.service';
import type { listUsersSchema, listVenuesSchema } from './admin.schemas';

/*
 * Minimal platform administration: find users, suspend / reactivate them, take a venue off the platform
 * (or put it back), and a few counters. The report queue lives in the safety module.
 * Callers are already checked to be admins by the routes (requireAdmin).
 */

const userFields = { id: true, email: true, fullName: true, platformRole: true, status: true, emailVerifiedAt: true, lastLoginAt: true, createdAt: true } as const;

// ───────────────────────── users ─────────────────────────

/** Searches users by e-mail or name (case-insensitive), newest first. Never returns the password hash. */
export async function listUsers(q: z.infer<typeof listUsersSchema>) {
  const where = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.q ? { OR: [{ email: { contains: q.q, mode: 'insensitive' as const } }, { fullName: { contains: q.q, mode: 'insensitive' as const } }] } : {}),
  };
  const [users, total] = await Promise.all([
    prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: userFields }),
    prisma.user.count({ where }),
  ]);
  return { users, page: q.page, pageSize: q.pageSize, total };
}

/** One user with history counters (what an admin needs to judge a report). */
export async function getUser(id: string) {
  const user = await prisma.user.findUnique({ where: { id }, select: userFields });
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  const [matchesOrganized, playerStats, reportsAgainst, venuesOwned] = await Promise.all([
    prisma.match.count({ where: { organizerId: id } }),
    statsFor(id), // same numbers (and the same D16 rule) as the player's own profile
    prisma.report.count({ where: { targetType: 'USER', targetId: id } }),
    prisma.venue.count({ where: { ownerId: id } }),
  ]);
  return { user, stats: { matchesOrganized, matchesPlayed: playerStats.matchesPlayed, noShows: playerStats.noShows, reportsAgainst, venuesOwned } };
}

/**
 * Suspends an account (idempotent). Effective immediately: `authenticate` re-reads the account on every request,
 * so the access token stops working, and every refresh token is revoked so the user cannot silently get a new one.
 * Admins cannot suspend themselves or each other.
 */
export async function suspendUser(adminId: string, id: string): Promise<void> {
  if (id === adminId) throw new AppError(400, 'INVALID_TARGET', 'You cannot suspend yourself');
  await prisma.$transaction(async (tx) => {
    const u = await tx.user.findUnique({ where: { id }, select: { status: true, platformRole: true } });
    if (!u) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    if (u.platformRole === 'ADMIN') throw new AppError(403, 'FORBIDDEN', 'Administrators cannot be suspended here');
    if (u.status === 'DELETED') throw new AppError(409, 'INVALID_STATE', 'This account is deleted');
    await tx.user.update({ where: { id }, data: { status: 'SUSPENDED' } });
    await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
  });
}

/** Lifts a suspension. Only a SUSPENDED account can be reactivated (409 otherwise). */
export async function reactivateUser(id: string): Promise<void> {
  const r = await prisma.user.updateMany({ where: { id, status: 'SUSPENDED' }, data: { status: 'ACTIVE' } });
  if (r.count === 0) throw new AppError(409, 'INVALID_STATE', 'Only a suspended account can be reactivated');
}

// ───────────────────────── venues ─────────────────────────

/** Venues with their owner, newest first. */
export async function listVenues(q: z.infer<typeof listVenuesSchema>) {
  const where = { ...(q.status ? { status: q.status } : {}), ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}) };
  const [venues, total] = await Promise.all([
    prisma.venue.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: { id: true, name: true, status: true, createdAt: true, city: { select: { id: true, nameEn: true, nameAr: true } }, owner: { select: { id: true, fullName: true, email: true } } },
    }),
    prisma.venue.count({ where }),
  ]);
  return { venues, page: q.page, pageSize: q.pageSize, total };
}

/**
 * Moves a venue between ACTIVE and SUSPENDED and tells its owner.
 * A suspended venue is hidden from search and takes no new bookings; existing bookings are NOT touched.
 * The status change is a conditional update (`status = from`), so the transition is atomic and a repeat gets a 409.
 */
export async function setVenueStatus(id: string, to: 'ACTIVE' | 'SUSPENDED', reason: string | null | undefined): Promise<void> {
  const from = to === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED';
  await prisma.$transaction(async (tx) => {
    const r = await tx.venue.updateMany({ where: { id, status: from }, data: { status: to } });
    if (r.count === 0) {
      if (!(await tx.venue.findUnique({ where: { id }, select: { id: true } }))) throw new AppError(404, 'VENUE_NOT_FOUND', 'Venue not found');
      throw new AppError(409, 'INVALID_STATE', `Only an ${from.toLowerCase()} venue can be set to ${to.toLowerCase()}`);
    }
    const v = await tx.venue.findUniqueOrThrow({ where: { id }, select: { ownerId: true, name: true } });
    await notify(tx, [v.ownerId], to === 'SUSPENDED' ? 'VENUE_SUSPENDED' : 'VENUE_REACTIVATED', { venueId: id, name: v.name, reason: reason ?? null }, { type: 'venue', id });
  });
}

// ───────────────────────── counters ─────────────────────────

/** Platform counters for the admin dashboard. */
export async function getStats() {
  const day = new Date(Date.now() - 86_400_000);
  const [users, newUsers24h, matchesUpcoming, matchesCreated24h, activeVenues, pendingBookings, openReports] = await Promise.all([
    prisma.user.count({ where: { status: 'ACTIVE' } }),
    prisma.user.count({ where: { createdAt: { gt: day } } }),
    prisma.match.count({ where: { status: { in: ['OPEN', 'FULL', 'SCHEDULED'] } } }),
    prisma.match.count({ where: { createdAt: { gt: day } } }),
    prisma.venue.count({ where: { status: 'ACTIVE' } }),
    prisma.booking.count({ where: { status: 'PENDING' } }),
    prisma.report.count({ where: { status: { in: ['OPEN', 'IN_REVIEW'] } } }),
  ]);
  return { users, newUsers24h, matchesUpcoming, matchesCreated24h, activeVenues, pendingBookings, openReports };
}
