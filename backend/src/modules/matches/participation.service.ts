import type { z } from 'zod';
import { AppError } from '../../lib/errors';
import { withDeadlockRetry } from '../../lib/db-errors';
import { prisma } from '../../lib/prisma';
import { notify } from '../notifications/notify';
import type { attendanceSchema } from './matches.schemas';
import { getMatch, hasScheduleConflict, loadManageableMatch, loadViewableMatch, type Actor } from './matches.service';

/*
 * Requests (the ASK, pending) and participants (CONFIRMED members) are different tables.
 * The service orchestrates; the database enforces capacity, overlap and state rules
 * (see prisma/README.md), so races end in a clean 409 instead of corrupt data.
 */

const userSummary = { select: { id: true, fullName: true, avatarUrl: true } } as const;

// ───────────────────────── join requests ─────────────────────────

export async function createRequest(actor: Actor, matchId: string, message?: string | null) {
  const m = await loadViewableMatch(matchId, actor);
  const profile = await prisma.playerProfile.findUnique({ where: { userId: actor.userId }, select: { id: true } });
  if (!profile) throw new AppError(403, 'PROFILE_REQUIRED', 'Create your player profile before joining matches');

  const scheduleConflict = await hasScheduleConflict(m, actor.userId); // warning only (D3)

  const request = await prisma.$transaction(async (tx) => {
    // DB trigger: OPEN_MATCH only, status OPEN, not started, not own match, invited if private, not blocked, no duplicate.
    const r = await tx.matchRequest.create({ data: { matchId, userId: actor.userId, message: message ?? undefined } });
    await notify(tx, [m.organizerId], 'MATCH_REQUEST_RECEIVED', { matchId, title: m.title, requestId: r.id, userId: actor.userId }, { type: 'match', id: matchId });
    return r;
  });
  return { request: { id: request.id, status: request.status, createdAt: request.createdAt }, scheduleConflict };
}

export async function withdrawRequest(actor: Actor, matchId: string): Promise<void> {
  const res = await prisma.matchRequest.updateMany({
    where: { matchId, userId: actor.userId, status: 'PENDING' },
    data: { status: 'WITHDRAWN' },
  });
  if (res.count === 0) throw new AppError(404, 'REQUEST_NOT_FOUND', 'You have no pending request for this match');
}

export async function listPendingRequests(actor: Actor, matchId: string) {
  const m = await loadManageableMatch(matchId, actor);
  const requests = await prisma.matchRequest.findMany({
    where: { matchId, status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    include: { user: { ...userSummary, select: { ...userSummary.select, playerProfile: { include: { positions: true } } } } },
  });

  // Generic "has a conflicting match" flag only; which match is never revealed.
  const conflicting = await prisma.matchParticipant.findMany({
    where: {
      userId: { in: requests.map((r) => r.userId) },
      status: 'CONFIRMED',
      match: { startAt: { lt: m.endAt }, endAt: { gt: m.startAt }, status: { in: ['OPEN', 'FULL', 'SCHEDULED', 'IN_PROGRESS'] } },
    },
    select: { userId: true },
  });
  const conflictIds = new Set(conflicting.map((c) => c.userId));

  return {
    requests: requests.map((r) => ({
      id: r.id,
      message: r.message,
      createdAt: r.createdAt,
      scheduleConflict: conflictIds.has(r.userId),
      player: {
        userId: r.user.id,
        fullName: r.user.fullName,
        avatarUrl: r.user.avatarUrl,
        skillLevel: r.user.playerProfile?.skillLevel ?? null,
        primaryPosition: r.user.playerProfile?.primaryPosition ?? null,
        positions: r.user.playerProfile?.positions.map((p) => p.position) ?? [],
      },
    })),
  };
}

export async function decideRequest(actor: Actor, matchId: string, requestId: string, decision: 'accept' | 'reject') {
  const m = await loadManageableMatch(matchId, actor);
  const request = await prisma.matchRequest.findFirst({ where: { id: requestId, matchId } });
  if (!request) throw new AppError(404, 'REQUEST_NOT_FOUND', 'Request not found');
  if (request.status !== 'PENDING') throw new AppError(409, 'REQUEST_ALREADY_DECIDED', 'This request was already decided');

  // Confirming a player can race with another match confirming the same player: retry if we lose a deadlock.
  await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    await tx.matchRequest.update({
      where: { id: requestId },
      data: { status: decision === 'accept' ? 'ACCEPTED' : 'REJECTED', decidedById: actor.userId },
    });

    if (decision === 'accept') {
      // One row per (match, user): a player who left or was removed is re-activated, not duplicated.
      // DB trigger (under the match row lock): capacity, start time, player's overlapping matches, OPEN -> FULL.
      const existing = await tx.matchParticipant.findUnique({ where: { matchId_userId: { matchId, userId: request.userId } } });
      if (existing) {
        await tx.matchParticipant.update({ where: { id: existing.id }, data: { status: 'CONFIRMED', requestId } });
      } else {
        await tx.matchParticipant.create({ data: { matchId, userId: request.userId, requestId } });
      }
    }
    await notify(tx, [request.userId], decision === 'accept' ? 'MATCH_REQUEST_ACCEPTED' : 'MATCH_REQUEST_REJECTED',
      { matchId, title: m.title }, { type: 'match', id: matchId });
  }));

  return { match: await getMatch(actor, matchId) };
}

// ───────────────────────── participants ─────────────────────────

export async function listParticipants(actor: Actor, matchId: string) {
  const m = await loadViewableMatch(matchId, actor);
  const showAttendance = m.organizerId === actor.userId || actor.role === 'ADMIN';
  const rows = await prisma.matchParticipant.findMany({
    where: { matchId, status: 'CONFIRMED' },
    orderBy: { joinedAt: 'asc' },
    include: {
      user: { select: { ...userSummary.select, playerProfile: { select: { primaryPosition: true, skillLevel: true } } } },
      matchTeam: { select: { teamId: true, side: true } },
    },
  });
  return {
    participants: rows.map((p) => ({
      userId: p.userId,
      ...(p.matchTeam ? { teamId: p.matchTeam.teamId, side: p.matchTeam.side } : {}),
      fullName: p.user.fullName,
      avatarUrl: p.user.avatarUrl,
      primaryPosition: p.user.playerProfile?.primaryPosition ?? null,
      skillLevel: p.user.playerProfile?.skillLevel ?? null,
      joinedAt: p.joinedAt,
      ...(showAttendance ? { attendanceStatus: p.attendanceStatus } : {}),
    })),
  };
}

/** Leaving is allowed only before the match starts; <12h before start is recorded as a late cancellation (D4). */
export async function leaveMatch(actor: Actor, matchId: string) {
  const m = await loadViewableMatch(matchId, actor);
  return prisma.$transaction(async (tx) => {
    const p = await tx.matchParticipant.findUnique({ where: { matchId_userId: { matchId, userId: actor.userId } } });
    if (!p || p.status !== 'CONFIRMED') throw new AppError(404, 'NOT_A_PARTICIPANT', 'You are not confirmed in this match');
    // DB trigger sets left_at + is_late_cancellation and reopens FULL -> OPEN.
    const left = await tx.matchParticipant.update({ where: { id: p.id }, data: { status: 'LEFT' } });
    await notify(tx, [m.organizerId], 'MATCH_PLAYER_LEFT', { matchId, title: m.title, userId: actor.userId, late: left.isLateCancellation }, { type: 'match', id: matchId });
    return { left: true, lateCancellation: left.isLateCancellation };
  });
}

export async function removeParticipant(actor: Actor, matchId: string, userId: string): Promise<void> {
  const m = await loadManageableMatch(matchId, actor);
  await prisma.$transaction(async (tx) => {
    const p = await tx.matchParticipant.findUnique({ where: { matchId_userId: { matchId, userId } } });
    if (!p || p.status !== 'CONFIRMED') throw new AppError(404, 'NOT_A_PARTICIPANT', 'This player is not confirmed in the match');
    await tx.matchParticipant.update({ where: { id: p.id }, data: { status: 'REMOVED' } }); // not a late cancellation, no penalty
    await notify(tx, [userId], 'MATCH_REMOVED', { matchId, title: m.title }, { type: 'match', id: matchId });
  });
}

/** No-shows are recorded by the organizer after the start (D4); the DB refuses it earlier. */
export async function setAttendance(actor: Actor, matchId: string, userId: string, status: z.infer<typeof attendanceSchema>['status']) {
  await loadManageableMatch(matchId, actor);
  const p = await prisma.matchParticipant.update({
    where: { matchId_userId: { matchId, userId } },
    data: { attendanceStatus: status, attendanceConfirmedById: actor.userId },
  });
  return { userId, attendanceStatus: p.attendanceStatus };
}

// ───────────────────────── invitations (private matches, D8) ─────────────────────────

export async function inviteUser(actor: Actor, matchId: string, inviteeId: string): Promise<void> {
  const m = await loadManageableMatch(matchId, actor);
  if (!['OPEN', 'FULL'].includes(m.status)) throw new AppError(409, 'INVALID_STATE', 'This match no longer takes invitations');
  if (inviteeId === m.organizerId) throw new AppError(400, 'INVALID_INVITEE', 'You organize this match');

  const invitee = await prisma.user.findUnique({ where: { id: inviteeId }, select: { id: true, status: true } });
  const blocked = await prisma.blockedUser.count({
    where: { OR: [{ blockerId: actor.userId, blockedId: inviteeId }, { blockerId: inviteeId, blockedId: actor.userId }] },
  });
  if (!invitee || invitee.status !== 'ACTIVE' || blocked > 0) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

  await prisma.$transaction(async (tx) => {
    await tx.matchInvitation.upsert({
      where: { matchId_inviteeId: { matchId, inviteeId } },
      create: { matchId, inviteeId, invitedById: actor.userId },
      update: { status: 'PENDING', invitedById: actor.userId },
    });
    await notify(tx, [inviteeId], 'MATCH_INVITATION', { matchId, title: m.title, invitedBy: actor.userId }, { type: 'match', id: matchId });
  });
}
