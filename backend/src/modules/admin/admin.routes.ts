import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, requireAdmin } from '../../middleware/authenticate';
import { notify } from '../notifications/notify';

/*
 * Minimal platform administration: find users, suspend / reactivate them, take a venue off the
 * platform (or put it back), and a few counters. Reports are in the safety module.
 * Suspension is effective immediately: authenticate() re-reads the account on every request,
 * and all refresh tokens are revoked so the user cannot silently get a new access token.
 */

export const adminRouter = Router();
adminRouter.use(authenticate, requireAdmin);

const idParams = z.object({ id: z.uuid() });
const reasonSchema = z.object({ reason: z.string().trim().max(500).nullish() });
const paging = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30) });

// ── users ──
adminRouter.get('/users', async (req, res) => {
  const q = paging
    .extend({ q: z.string().trim().min(1).max(100).optional(), status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']).optional() })
    .parse(req.query);
  const where = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.q ? { OR: [{ email: { contains: q.q, mode: 'insensitive' as const } }, { fullName: { contains: q.q, mode: 'insensitive' as const } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: { id: true, email: true, fullName: true, platformRole: true, status: true, emailVerifiedAt: true, lastLoginAt: true, createdAt: true },
    }),
    prisma.user.count({ where }),
  ]);
  res.json({ users: rows, page: q.page, pageSize: q.pageSize, total });
});

adminRouter.get('/users/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const u = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, fullName: true, platformRole: true, status: true, emailVerifiedAt: true, lastLoginAt: true, createdAt: true },
  });
  if (!u) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  const [matchesOrganized, matchesPlayed, noShows, reportsAgainst, venuesOwned] = await Promise.all([
    prisma.match.count({ where: { organizerId: id } }),
    prisma.matchParticipant.count({ where: { userId: id, status: 'CONFIRMED', attendanceStatus: 'ATTENDED' } }),
    prisma.matchParticipant.count({ where: { userId: id, attendanceStatus: 'NO_SHOW' } }),
    prisma.report.count({ where: { targetType: 'USER', targetId: id } }),
    prisma.venue.count({ where: { ownerId: id } }),
  ]);
  res.json({ user: u, stats: { matchesOrganized, matchesPlayed, noShows, reportsAgainst, venuesOwned } });
});

adminRouter.post('/users/:id/suspend', async (req, res) => {
  const { id } = idParams.parse(req.params);
  reasonSchema.parse(req.body ?? {});
  if (id === req.auth!.userId) throw new AppError(400, 'INVALID_TARGET', 'You cannot suspend yourself');
  await prisma.$transaction(async (tx) => {
    const u = await tx.user.findUnique({ where: { id }, select: { status: true, platformRole: true } });
    if (!u) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    if (u.platformRole === 'ADMIN') throw new AppError(403, 'FORBIDDEN', 'Administrators cannot be suspended here');
    if (u.status === 'DELETED') throw new AppError(409, 'INVALID_STATE', 'This account is deleted');
    await tx.user.update({ where: { id }, data: { status: 'SUSPENDED' } });
    await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
  });
  res.status(204).end();
});

adminRouter.post('/users/:id/reactivate', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const r = await prisma.user.updateMany({ where: { id, status: 'SUSPENDED' }, data: { status: 'ACTIVE' } });
  if (r.count === 0) throw new AppError(409, 'INVALID_STATE', 'Only a suspended account can be reactivated');
  res.status(204).end();
});

// ── venues ──
adminRouter.get('/venues', async (req, res) => {
  const q = paging.extend({ q: z.string().trim().min(1).max(100).optional(), status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional() }).parse(req.query);
  const where = { ...(q.status ? { status: q.status } : {}), ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}) };
  const [rows, total] = await Promise.all([
    prisma.venue.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: { id: true, name: true, status: true, createdAt: true, city: { select: { id: true, nameEn: true, nameAr: true } }, owner: { select: { id: true, fullName: true, email: true } } },
    }),
    prisma.venue.count({ where }),
  ]);
  res.json({ venues: rows, page: q.page, pageSize: q.pageSize, total });
});

// SUSPENDED: hidden from search, no new bookings. Existing bookings are not touched (staff / players handle them).
adminRouter.post('/venues/:id/suspend', async (req, res) => {
  await setVenueStatus(req.params.id!, 'SUSPENDED', 'ACTIVE', req.body);
  res.status(204).end();
});
adminRouter.post('/venues/:id/reactivate', async (req, res) => {
  await setVenueStatus(req.params.id!, 'ACTIVE', 'SUSPENDED', req.body);
  res.status(204).end();
});

async function setVenueStatus(rawId: string, to: 'ACTIVE' | 'SUSPENDED', from: 'ACTIVE' | 'SUSPENDED', body: unknown) {
  const id = z.uuid().parse(rawId);
  const { reason } = reasonSchema.parse(body ?? {});
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

// ── counters ──
adminRouter.get('/stats', async (_req, res) => {
  const day = new Date(Date.now() - 86_400_000);
  const [users, newUsers24h, matchesOpen, matchesToday, venues, bookingsPending, reportsOpen] = await Promise.all([
    prisma.user.count({ where: { status: 'ACTIVE' } }),
    prisma.user.count({ where: { createdAt: { gt: day } } }),
    prisma.match.count({ where: { status: { in: ['OPEN', 'FULL', 'SCHEDULED'] } } }),
    prisma.match.count({ where: { createdAt: { gt: day } } }),
    prisma.venue.count({ where: { status: 'ACTIVE' } }),
    prisma.booking.count({ where: { status: 'PENDING' } }),
    prisma.report.count({ where: { status: { in: ['OPEN', 'IN_REVIEW'] } } }),
  ]);
  res.json({ users, newUsers24h, matchesUpcoming: matchesOpen, matchesCreated24h: matchesToday, activeVenues: venues, pendingBookings: bookingsPending, openReports: reportsOpen });
});
