import type { z } from 'zod';
import { areBlocked } from '../../lib/blocks';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { Actor } from '../../types/actor';
import { loadViewableMatch } from '../matches/matches.service';
import { notify } from '../notifications/notify';
import type { createReviewSchema, listReviewsSchema } from './reviews.schemas';

/*
 * Reviews (D-reviews): only players who ATTENDED a COMPLETED match review each other, once per pair,
 * within 7 days of completion. The DB enforces all of that (fym_review_guard); this layer orchestrates,
 * hides blocked users, and keeps the rating cache on player_profile in step (same transaction).
 * "Attendance / reliability" is NOT a reviewer score: it is derived from organizer-confirmed attendance.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Reviews another player of a COMPLETED match. The database enforces who may review (both ATTENDED, 7-day window,
 * once per pair) so these rules hold under races; this layer adds the block check and keeps the rating cache in step,
 * all in one transaction. The notification to the reviewed player never carries the scores.
 */
export async function createReview(actor: Actor, matchId: string, input: z.infer<typeof createReviewSchema>) {
  await loadViewableMatch(matchId, actor);
  if (input.reviewedId === actor.userId) throw new AppError(400, 'INVALID_TARGET', 'You cannot review yourself');
  if (await areBlocked(actor.userId, input.reviewedId)) throw new AppError(403, 'NOT_ALLOWED', 'You cannot review this player');

  const review = await prisma.$transaction(async (tx) => {
    // DB trigger: match COMPLETED, within the review window, both ATTENDED; unique (match, reviewer, reviewed).
    const r = await tx.review.create({
      data: {
        matchId,
        reviewerId: actor.userId,
        reviewedId: input.reviewedId,
        sportsmanshipScore: input.sportsmanshipScore,
        skillScore: input.skillScore,
        reliabilityScore: input.reliabilityScore,
        comment: input.comment ?? undefined,
      },
    });
    await refreshRating(tx, input.reviewedId);
    await notify(tx, [input.reviewedId], 'REVIEW_RECEIVED', { matchId }, { type: 'match', id: matchId }); // never carries the scores
    return r;
  });
  return { review: { id: review.id, matchId, reviewedId: review.reviewedId, createdAt: review.createdAt } };
}

/** The cache on player_profile is rebuildable from review rows; recomputed in the review's transaction. */
async function refreshRating(tx: Pick<typeof prisma, 'review' | 'playerProfile'>, userId: string) {
  const a = await tx.review.aggregate({
    where: { reviewedId: userId },
    _avg: { sportsmanshipScore: true, skillScore: true, reliabilityScore: true },
    _count: { _all: true },
  });
  const parts = [a._avg.sportsmanshipScore, a._avg.skillScore, a._avg.reliabilityScore];
  const avg = parts.every((p) => p !== null) ? round2(parts.reduce<number>((s, p) => s + p!, 0) / 3) : null;
  await tx.playerProfile.updateMany({ where: { userId }, data: { ratingAvg: avg, ratingCount: a._count._all } });
}

/** Players I can still review for this match (attended, not yet reviewed by me, window open). */
export async function pendingReviews(actor: Actor, matchId: string) {
  const m = await loadViewableMatch(matchId, actor);
  const windowMs = 7 * 86_400_000;
  const open = m.status === 'COMPLETED' && m.completedAt !== null && Date.now() <= m.completedAt.getTime() + windowMs;
  const me = await prisma.matchParticipant.findFirst({ where: { matchId, userId: actor.userId, status: 'CONFIRMED', attendanceStatus: 'ATTENDED' } });
  if (!open || !me) return { open: false, closesAt: null, players: [] };

  const [attendees, done, blocks] = await Promise.all([
    prisma.matchParticipant.findMany({
      where: { matchId, status: 'CONFIRMED', attendanceStatus: 'ATTENDED', userId: { not: actor.userId } },
      include: { user: { select: { id: true, fullName: true, avatarUrl: true } } },
    }),
    prisma.review.findMany({ where: { matchId, reviewerId: actor.userId }, select: { reviewedId: true } }),
    prisma.blockedUser.findMany({ where: { OR: [{ blockerId: actor.userId }, { blockedId: actor.userId }] } }),
  ]);
  const reviewed = new Set(done.map((r) => r.reviewedId));
  const hidden = new Set(blocks.flatMap((b) => [b.blockerId, b.blockedId]));
  return {
    open: true,
    closesAt: new Date(m.completedAt!.getTime() + windowMs),
    players: attendees.filter((p) => !reviewed.has(p.userId) && !hidden.has(p.userId)).map((p) => p.user),
  };
}

/** Public: reviews a player received, with category averages. Reviews by users the viewer has a block with are left out. */
export async function listPlayerReviews(actor: Actor, userId: string, q: z.infer<typeof listReviewsSchema>) {
  if (!(await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })) || (await areBlocked(actor.userId, userId))) {
    throw new AppError(404, 'PLAYER_NOT_FOUND', 'Player not found');
  }
  const where = { reviewedId: userId };
  const [rows, total, agg] = await Promise.all([
    prisma.review.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: { reviewer: { select: { id: true, fullName: true, avatarUrl: true } }, match: { select: { id: true, title: true, startAt: true } } },
    }),
    prisma.review.count({ where }),
    prisma.review.aggregate({ where, _avg: { sportsmanshipScore: true, skillScore: true, reliabilityScore: true } }),
  ]);
  const r2 = (n: number | null) => (n === null ? null : round2(n));
  return {
    summary: {
      count: total,
      sportsmanship: r2(agg._avg.sportsmanshipScore),
      skill: r2(agg._avg.skillScore),
      reliability: r2(agg._avg.reliabilityScore),
    },
    reviews: rows.map((r) => ({
      id: r.id,
      reviewer: r.reviewer,
      match: r.match,
      sportsmanshipScore: r.sportsmanshipScore,
      skillScore: r.skillScore,
      reliabilityScore: r.reliabilityScore,
      comment: r.comment,
      createdAt: r.createdAt,
    })),
    page: q.page,
    pageSize: q.pageSize,
    total,
  };
}
