import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, requireAdmin } from '../../middleware/authenticate';
import { canSeeMessage } from '../chat/chat.service';
import { notify } from '../notifications/notify';

/*
 * Safety: blocking (user-to-user, symmetric in effect) and reports (moderation queue).
 * Blocking is enforced where interactions happen: match visibility, join requests / invitations (DB trigger),
 * reviews, team invitations and challenges, player profiles. Blocked users are never told.
 */

const uid = (req: { auth?: { userId: string } }) => req.auth!.userId;

// ───────── /api/v1/users/me/blocks ─────────
export const blocksRouter = Router();
blocksRouter.use(authenticate);

blocksRouter.get('/', async (req, res) => {
  const rows = await prisma.blockedUser.findMany({
    where: { blockerId: uid(req) },
    orderBy: { createdAt: 'desc' },
    include: { blocked: { select: { id: true, fullName: true, avatarUrl: true } } },
  });
  res.json({ blocks: rows.map((b) => ({ user: b.blocked, blockedAt: b.createdAt })) });
});

blocksRouter.post('/', async (req, res) => {
  const { userId } = z.object({ userId: z.uuid() }).parse(req.body);
  if (userId === uid(req)) throw new AppError(400, 'INVALID_TARGET', 'You cannot block yourself');
  if (!(await prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  await prisma.$transaction(async (tx) => {
    await tx.blockedUser.upsert({
      where: { blockerId_blockedId: { blockerId: uid(req), blockedId: userId } },
      create: { blockerId: uid(req), blockedId: userId },
      update: {}, // idempotent
    });
    // Pending asks between the two stop being answerable: withdraw my requests to their matches and decline theirs to mine.
    await tx.matchRequest.updateMany({ where: { userId: uid(req), status: 'PENDING', match: { organizerId: userId } }, data: { status: 'WITHDRAWN' } });
    await tx.matchRequest.updateMany({ where: { userId, status: 'PENDING', match: { organizerId: uid(req) } }, data: { status: 'REJECTED', decidedById: uid(req) } });
  });
  res.status(204).end();
});

blocksRouter.delete('/:userId', async (req, res) => {
  const { userId } = z.object({ userId: z.uuid() }).parse(req.params);
  await prisma.blockedUser.deleteMany({ where: { blockerId: uid(req), blockedId: userId } });
  res.status(204).end();
});

// ───────── /api/v1/reports ─────────
const REASONS = ['SPAM', 'HARASSMENT', 'FAKE_PROFILE', 'NO_SHOW', 'INAPPROPRIATE_CONTENT', 'SAFETY', 'OTHER'] as const;
const createReportSchema = z.object({
  targetType: z.enum(['USER', 'MATCH', 'VENUE', 'TEAM', 'MESSAGE']),
  targetId: z.uuid(),
  reason: z.enum(REASONS),
  details: z.string().trim().max(1000).nullish(),
});
const DAILY_LIMIT = 20;

async function targetExists(type: 'USER' | 'MATCH' | 'VENUE' | 'TEAM' | 'MESSAGE', id: string, reporterId: string): Promise<boolean> {
  const where = { where: { id }, select: { id: true } };
  switch (type) {
    case 'USER': return !!(await prisma.user.findUnique(where));
    case 'MATCH': return !!(await prisma.match.findUnique(where));
    case 'VENUE': return !!(await prisma.venue.findUnique(where));
    case 'TEAM': return !!(await prisma.team.findUnique(where));
    case 'MESSAGE': return canSeeMessage(reporterId, id); // you can only report messages you can see
  }
}

export const reportsRouter = Router();
reportsRouter.use(authenticate);

reportsRouter.post('/', async (req, res) => {
  const input = createReportSchema.parse(req.body);
  if (input.targetType === 'USER' && input.targetId === uid(req)) throw new AppError(400, 'INVALID_TARGET', 'You cannot report yourself');
  if (!(await targetExists(input.targetType, input.targetId, uid(req)))) throw new AppError(404, 'TARGET_NOT_FOUND', 'Nothing to report here');

  const [open, today] = await Promise.all([
    prisma.report.count({ where: { reporterId: uid(req), targetType: input.targetType, targetId: input.targetId, status: { in: ['OPEN', 'IN_REVIEW'] } } }),
    prisma.report.count({ where: { reporterId: uid(req), createdAt: { gt: new Date(Date.now() - 86_400_000) } } }),
  ]);
  if (open > 0) throw new AppError(409, 'ALREADY_REPORTED', 'You already have an open report about this');
  if (today >= DAILY_LIMIT) throw new AppError(429, 'TOO_MANY_REPORTS', 'You have sent too many reports today');

  const r = await prisma.report.create({
    data: { reporterId: uid(req), targetType: input.targetType, targetId: input.targetId, reason: input.reason, details: input.details ?? undefined },
  });
  res.status(201).json({ report: { id: r.id, status: r.status, createdAt: r.createdAt } });
});

reportsRouter.get('/mine', async (req, res) => {
  const rows = await prisma.report.findMany({ where: { reporterId: uid(req) }, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json({
    reports: rows.map((r) => ({ id: r.id, targetType: r.targetType, targetId: r.targetId, reason: r.reason, status: r.status, createdAt: r.createdAt, resolvedAt: r.resolvedAt })),
  });
});

// ───────── /api/v1/admin/reports (moderation queue) ─────────
export const adminReportsRouter = Router();
adminReportsRouter.use(authenticate, requireAdmin);

adminReportsRouter.get('/', async (req, res) => {
  const q = z
    .object({
      status: z.enum(['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED']).optional(),
      targetType: z.enum(['USER', 'MATCH', 'VENUE', 'TEAM', 'MESSAGE']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(30),
    })
    .parse(req.query);
  const where = { ...(q.status ? { status: q.status } : {}), ...(q.targetType ? { targetType: q.targetType } : {}) };
  const [rows, total] = await Promise.all([
    prisma.report.findMany({
      where,
      orderBy: { createdAt: 'asc' }, // oldest first: work the queue
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: { reporter: { select: { id: true, fullName: true } } },
    }),
    prisma.report.count({ where }),
  ]);
  res.json({ reports: rows, page: q.page, pageSize: q.pageSize, total });
});

const NEXT: Record<string, string[]> = { OPEN: ['IN_REVIEW', 'RESOLVED', 'DISMISSED'], IN_REVIEW: ['RESOLVED', 'DISMISSED'], RESOLVED: [], DISMISSED: [] };

adminReportsRouter.patch('/:id', async (req, res) => {
  const { id } = z.object({ id: z.uuid() }).parse(req.params);
  const { status } = z.object({ status: z.enum(['IN_REVIEW', 'RESOLVED', 'DISMISSED']) }).parse(req.body);
  const r = await prisma.$transaction(async (tx) => {
    const cur = await tx.report.findUnique({ where: { id } });
    if (!cur) throw new AppError(404, 'REPORT_NOT_FOUND', 'Report not found');
    if (!NEXT[cur.status]!.includes(status)) throw new AppError(409, 'INVALID_STATE', 'This report cannot move to that status');
    const final = status !== 'IN_REVIEW';
    // Atomic claim on the current status: two admins cannot both close it.
    const res2 = await tx.report.updateMany({
      where: { id, status: cur.status },
      data: { status, ...(final ? { resolvedById: uid(req), resolvedAt: new Date() } : {}) },
    });
    if (res2.count === 0) throw new AppError(409, 'INVALID_STATE', 'This report was just updated by someone else');
    if (final) await notify(tx, [cur.reporterId], 'REPORT_RESOLVED', { reportId: id, status }, { type: 'report', id });
    return tx.report.findUniqueOrThrow({ where: { id } });
  });
  res.json({ report: r });
});
