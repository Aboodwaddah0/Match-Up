import type { z } from 'zod';
import { recordAdminAudit } from '../../lib/audit';
import { lockVenue } from '../../lib/locks';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { disconnectUser } from '../../lib/realtime';
import { notify } from '../notifications/notify';
import { statsFor } from '../players/players.service';
import type { listAuditLogSchema, listUsersSchema, listVenuesSchema } from './admin.schemas';

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
 * Admins cannot suspend themselves or each other. An audit record is written (same transaction) only when the status
 * really changes, so repeating the call does not fill the log with no-ops.
 */
export async function suspendUser(adminId: string, id: string, reason: string | null | undefined, requestId?: string): Promise<void> {
  if (id === adminId) throw new AppError(400, 'INVALID_TARGET', 'You cannot suspend yourself');
  await prisma.$transaction(async (tx) => {
    const u = await tx.user.findUnique({ where: { id }, select: { status: true, platformRole: true } });
    if (!u) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    if (u.platformRole === 'ADMIN') throw new AppError(403, 'FORBIDDEN', 'Administrators cannot be suspended here');
    if (u.status === 'DELETED') throw new AppError(409, 'INVALID_STATE', 'This account is deleted');
    await tx.user.update({ where: { id }, data: { status: 'SUSPENDED' } });
    if (u.status !== 'SUSPENDED') {
      await recordAdminAudit(tx, { actorId: adminId, action: 'USER_SUSPENDED', targetType: 'USER', targetId: id, reason, metadata: { fromStatus: u.status, toStatus: 'SUSPENDED' }, requestId });
    }
    await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
  });
  disconnectUser(id); // a suspended user must stop receiving live chat immediately, not at the next reconnect
}

/** Lifts a suspension. Only a SUSPENDED account can be reactivated (409 otherwise). */
export async function reactivateUser(adminId: string, id: string, requestId?: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const r = await tx.user.updateMany({ where: { id, status: 'SUSPENDED' }, data: { status: 'ACTIVE' } });
    if (r.count === 0) throw new AppError(409, 'INVALID_STATE', 'Only a suspended account can be reactivated');
    await recordAdminAudit(tx, { actorId: adminId, action: 'USER_REACTIVATED', targetType: 'USER', targetId: id, metadata: { fromStatus: 'SUSPENDED', toStatus: 'ACTIVE' }, requestId });
  });
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
 * Moves a venue to SUSPENDED (from ACTIVE) or back to ACTIVE (from SUSPENDED or from INACTIVE, PRIV-01: an owner who deleted their account
 * leaves a deactivated venue that an admin must be able to bring back), records it in the audit log and tells its owner (all in one
 * transaction; a deleted owner is simply not notified, see notify). A suspended venue is hidden from search and takes no new bookings;
 * existing bookings are NOT touched. The venue row is locked first and the transition is decided on the status found under that lock, so
 * two simultaneous requests leave one record and the repeat gets a 409.
 */
export async function setVenueStatus(adminId: string, id: string, to: 'ACTIVE' | 'SUSPENDED', reason: string | null | undefined, requestId?: string): Promise<void> {
  const allowedFrom = to === 'SUSPENDED' ? ['ACTIVE'] : ['SUSPENDED', 'INACTIVE'];
  await prisma.$transaction(async (tx) => {
    await lockVenue(tx, id); // 404 VENUE_NOT_FOUND when it does not exist
    const cur = await tx.venue.findUniqueOrThrow({ where: { id }, select: { status: true, ownerId: true, name: true } });
    if (!allowedFrom.includes(cur.status)) {
      throw new AppError(409, 'INVALID_STATE', to === 'SUSPENDED' ? 'Only an active venue can be suspended' : 'Only a suspended or inactive venue can be reactivated');
    }
    await tx.venue.update({ where: { id }, data: { status: to } });
    await recordAdminAudit(tx, { actorId: adminId, action: to === 'SUSPENDED' ? 'VENUE_SUSPENDED' : 'VENUE_REACTIVATED', targetType: 'VENUE', targetId: id, reason, metadata: { fromStatus: cur.status, toStatus: to }, requestId });
    await notify(tx, [cur.ownerId], to === 'SUSPENDED' ? 'VENUE_SUSPENDED' : 'VENUE_REACTIVATED', { venueId: id, name: cur.name, reason: reason ?? null }, { type: 'venue', id });
  });
}

// ───────────────────────── audit log (read only) ─────────────────────────

/**
 * Reads the audit log, newest first. Read only: there is deliberately no way to change or delete a record. Only the stored
 * audit fields are returned (ids, not names or e-mails; look a user up with GET /admin/users/:id).
 */
export async function listAuditLog(q: z.infer<typeof listAuditLogSchema>) {
  const where = {
    ...(q.actorId ? { actorId: q.actorId } : {}),
    ...(q.action ? { action: q.action } : {}),
    ...(q.targetType ? { targetType: q.targetType } : {}),
    ...(q.targetId ? { targetId: q.targetId } : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {}),
  };
  const [entries, total] = await Promise.all([
    prisma.adminAuditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: { id: true, actorId: true, action: true, targetType: true, targetId: true, reason: true, metadata: true, requestId: true, createdAt: true },
    }),
    prisma.adminAuditLog.count({ where }),
  ]);
  return { entries, page: q.page, pageSize: q.pageSize, total };
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
