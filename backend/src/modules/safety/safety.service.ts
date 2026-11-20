import type { z } from 'zod';
import { recordAdminAudit } from '../../lib/audit';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { canSeeMessage } from '../chat/chat.service';
import { canSeeMedia } from '../media/media.service';
import { notify } from '../notifications/notify';
import type { adminListReportsSchema, createReportSchema } from './safety.schemas';

/*
 * Safety: blocking (user to user, symmetric in effect) and reports (moderation queue).
 * Blocking is ENFORCED elsewhere, where interactions happen: match visibility, join requests / invitations
 * (DB trigger), reviews, team invitations and challenges, player profiles, chat. Blocked users are never told.
 */

// ───────────────────────── blocking ─────────────────────────

/** Users I have blocked, newest first. */
export async function listBlocks(userId: string) {
  const rows = await prisma.blockedUser.findMany({
    where: { blockerId: userId },
    orderBy: { createdAt: 'desc' },
    include: { blocked: { select: { id: true, fullName: true, avatarUrl: true } } },
  });
  return { blocks: rows.map((b) => ({ user: b.blocked, blockedAt: b.createdAt })) };
}

/**
 * Blocks a user (idempotent). In the same transaction, pending join requests between the two stop being
 * answerable: my requests to their matches are withdrawn, and their requests to my matches are declined.
 */
export async function blockUser(userId: string, targetId: string): Promise<void> {
  if (targetId === userId) throw new AppError(400, 'INVALID_TARGET', 'You cannot block yourself');
  if (!(await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } }))) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  await prisma.$transaction(async (tx) => {
    await tx.blockedUser.upsert({
      where: { blockerId_blockedId: { blockerId: userId, blockedId: targetId } },
      create: { blockerId: userId, blockedId: targetId },
      update: {}, // already blocked: nothing to do
    });
    await tx.matchRequest.updateMany({ where: { userId, status: 'PENDING', match: { organizerId: targetId } }, data: { status: 'WITHDRAWN' } });
    await tx.matchRequest.updateMany({ where: { userId: targetId, status: 'PENDING', match: { organizerId: userId } }, data: { status: 'REJECTED', decidedById: userId } });
  });
}

/** Removes my block (no error if there was none). */
export async function unblockUser(userId: string, targetId: string): Promise<void> {
  await prisma.blockedUser.deleteMany({ where: { blockerId: userId, blockedId: targetId } });
}

// ───────────────────────── reports ─────────────────────────

const DAILY_REPORT_LIMIT = 20;

async function targetExists(type: z.infer<typeof createReportSchema>['targetType'], id: string, reporterId: string): Promise<boolean> {
  const where = { where: { id }, select: { id: true } };
  switch (type) {
    case 'USER': return !!(await prisma.user.findUnique(where));
    case 'MATCH': return !!(await prisma.match.findUnique(where));
    case 'VENUE': return !!(await prisma.venue.findUnique(where));
    case 'TEAM': return !!(await prisma.team.findUnique(where));
    case 'MESSAGE': return canSeeMessage(reporterId, id); // you can only report messages you can see
    case 'MEDIA': return canSeeMedia(reporterId, id); // only a READY photo / video the reporter can see (never a pending or removed one)
  }
}

/**
 * Files a report. Rules: not about yourself, the target must exist, one OPEN / IN_REVIEW report per
 * reporter and target, and at most 20 reports per user per day (abuse protection).
 * The duplicate check is done here, not by a DB constraint: two simultaneous identical reports could both pass, which is harmless.
 */
export async function createReport(reporterId: string, input: z.infer<typeof createReportSchema>) {
  if (input.targetType === 'USER' && input.targetId === reporterId) throw new AppError(400, 'INVALID_TARGET', 'You cannot report yourself');
  if (!(await targetExists(input.targetType, input.targetId, reporterId))) throw new AppError(404, 'TARGET_NOT_FOUND', 'Nothing to report here');

  const [open, today] = await Promise.all([
    prisma.report.count({ where: { reporterId, targetType: input.targetType, targetId: input.targetId, status: { in: ['OPEN', 'IN_REVIEW'] } } }),
    prisma.report.count({ where: { reporterId, createdAt: { gt: new Date(Date.now() - 86_400_000) } } }),
  ]);
  if (open > 0) throw new AppError(409, 'ALREADY_REPORTED', 'You already have an open report about this');
  if (today >= DAILY_REPORT_LIMIT) throw new AppError(429, 'TOO_MANY_REPORTS', 'You have sent too many reports today');

  const r = await prisma.report.create({
    data: { reporterId, targetType: input.targetType, targetId: input.targetId, reason: input.reason, details: input.details ?? undefined },
  });
  return { report: { id: r.id, status: r.status, createdAt: r.createdAt } };
}

/** My reports and their status (the moderation details are not shown to the reporter). */
export async function myReports(userId: string) {
  const rows = await prisma.report.findMany({ where: { reporterId: userId }, orderBy: { createdAt: 'desc' }, take: 100 });
  return {
    reports: rows.map((r) => ({ id: r.id, targetType: r.targetType, targetId: r.targetId, reason: r.reason, status: r.status, createdAt: r.createdAt, resolvedAt: r.resolvedAt })),
  };
}

// ───────────────────────── moderation queue (admin) ─────────────────────────

/** The moderation queue, oldest first so the longest-waiting report is handled first. */
export async function adminListReports(q: z.infer<typeof adminListReportsSchema>) {
  const where = { ...(q.status ? { status: q.status } : {}), ...(q.targetType ? { targetType: q.targetType } : {}) };
  const [rows, total] = await Promise.all([
    prisma.report.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: { reporter: { select: { id: true, fullName: true } } },
    }),
    prisma.report.count({ where }),
  ]);
  return { reports: rows, page: q.page, pageSize: q.pageSize, total };
}

/** Allowed status changes. RESOLVED and DISMISSED are final. */
const NEXT_STATUS: Record<string, string[]> = { OPEN: ['IN_REVIEW', 'RESOLVED', 'DISMISSED'], IN_REVIEW: ['RESOLVED', 'DISMISSED'], RESOLVED: [], DISMISSED: [] };

/** Moves a report through the queue; closing it (RESOLVED / DISMISSED) records the admin and notifies the reporter. */
export async function updateReportStatus(adminId: string, reportId: string, status: 'IN_REVIEW' | 'RESOLVED' | 'DISMISSED', requestId?: string) {
  const report = await prisma.$transaction(async (tx) => {
    const cur = await tx.report.findUnique({ where: { id: reportId } });
    if (!cur) throw new AppError(404, 'REPORT_NOT_FOUND', 'Report not found');
    if (!NEXT_STATUS[cur.status]!.includes(status)) throw new AppError(409, 'INVALID_STATE', 'This report cannot move to that status');
    const final = status !== 'IN_REVIEW';
    // Atomic claim on the status we read: if two admins act at once only one update matches, the other gets a 409.
    const claimed = await tx.report.updateMany({
      where: { id: reportId, status: cur.status },
      data: { status, ...(final ? { resolvedById: adminId, resolvedAt: new Date() } : {}) },
    });
    if (claimed.count === 0) throw new AppError(409, 'INVALID_STATE', 'This report was just updated by someone else');
    await recordAdminAudit(tx, { actorId: adminId, action: 'REPORT_STATUS_CHANGED', targetType: 'REPORT', targetId: reportId, metadata: { fromStatus: cur.status, toStatus: status }, requestId });
    if (final) await notify(tx, [cur.reporterId], 'REPORT_RESOLVED', { reportId, status }, { type: 'report', id: reportId });
    return tx.report.findUniqueOrThrow({ where: { id: reportId } });
  });
  return { report };
}
