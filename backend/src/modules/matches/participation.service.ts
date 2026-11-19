import type { z } from 'zod';
import { recordAdminAudit } from '../../lib/audit';
import { areBlocked } from '../../lib/blocks';
import { AppError } from '../../lib/errors';
import { withDeadlockRetry } from '../../lib/db-errors';
import { lockMatch } from '../../lib/locks';
import { prisma } from '../../lib/prisma';
import { notify } from '../notifications/notify';
import type { attendanceSchema, listRequestsQuery } from './matches.schemas';
import type { Actor } from '../../types/actor';
import { getMatch, hasScheduleConflict, isAdminOverride, isSuspended, loadManageableMatch, loadViewableMatch } from './matches.service';

/*
 * Requests (the ASK, pending) and participants (CONFIRMED members) are different tables.
 * The service orchestrates; the database enforces capacity, overlap and state rules
 * (see prisma/README.md), so races end in a clean 409 instead of corrupt data.
 */

const userSummary = { select: { id: true, fullName: true, avatarUrl: true, status: true } } as const;

// ───────────────────────── join requests ─────────────────────────

/**
 * Asks to join a match. This is a REQUEST, not a participation: it never takes a spot (D3). The DB trigger enforces the
 * rules atomically (open match, not started, not your own match, invited when private, not blocked, no duplicate pending).
 * A time clash with another CONFIRMED match is returned as a warning only (`scheduleConflict`).
 */
export async function createRequest(actor: Actor, matchId: string, message?: string | null) {
  const m = await loadViewableMatch(matchId, actor);
  const profile = await prisma.playerProfile.findUnique({ where: { userId: actor.userId }, select: { id: true } });
  if (!profile) throw new AppError(403, 'PROFILE_REQUIRED', 'Create your player profile before joining matches');

  const scheduleConflict = await hasScheduleConflict(m, actor.userId); // warning only (D3)

  const request = await prisma.$transaction(async (tx) => {
    // SEC-01: a suspended organizer takes no new requests, not even from an invited player (the match stays visible to people related to it).
    if (await isSuspended(m.organizerId)) throw new AppError(409, 'ORGANIZER_UNAVAILABLE', 'The organizer of this match is currently unavailable');
    // DB trigger: OPEN_MATCH only, status OPEN, not started, not own match, invited if private, not blocked, no duplicate.
    const r = await tx.matchRequest.create({ data: { matchId, userId: actor.userId, message: message ?? undefined } });
    await notify(tx, [m.organizerId], 'MATCH_REQUEST_RECEIVED', { matchId, title: m.title, requestId: r.id, userId: actor.userId }, { type: 'match', id: matchId });
    return r;
  });
  return { request: { id: request.id, status: request.status, createdAt: request.createdAt }, scheduleConflict };
}

/** The requester withdraws their own pending request (404 if there is none). */
export async function withdrawRequest(actor: Actor, matchId: string): Promise<void> {
  const res = await prisma.matchRequest.updateMany({
    where: { matchId, userId: actor.userId, status: 'PENDING' },
    data: { status: 'WITHDRAWN' },
  });
  if (res.count === 0) throw new AppError(404, 'REQUEST_NOT_FOUND', 'You have no pending request for this match');
}

/** Organizer view of pending requests, each flagged when the player already has a conflicting confirmed match (the other match is never revealed). */
export async function listPendingRequests(actor: Actor, matchId: string, q: z.infer<typeof listRequestsQuery> = { page: 1, pageSize: 20 }) {
  const m = await loadManageableMatch(matchId, actor);
  // Paged (ML-01): oldest first with the id as tie-break, so pages are stable. One extra row tells whether another page exists (no count query).
  const rows = await prisma.matchRequest.findMany({
    where: { matchId, status: 'PENDING' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    skip: (q.page - 1) * q.pageSize,
    take: q.pageSize + 1,
    include: { user: { ...userSummary, select: { ...userSummary.select, playerProfile: { include: { positions: true } } } } },
  });

  const requests = rows.slice(0, q.pageSize);
  // Generic "has a conflicting match" flag only (looked up for the players on this page only); which match is never revealed.
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
    page: q.page,
    pageSize: q.pageSize,
    hasMore: rows.length > q.pageSize,
    requests: requests.map((r) => ({
      id: r.id,
      message: r.message,
      createdAt: r.createdAt,
      scheduleConflict: conflictIds.has(r.userId),
      player: {
        userId: r.user.id,
        fullName: r.user.fullName,
        deleted: r.user.status === 'DELETED',
        avatarUrl: r.user.avatarUrl,
        skillLevel: r.user.playerProfile?.skillLevel ?? null,
        primaryPosition: r.user.playerProfile?.primaryPosition ?? null,
        positions: r.user.playerProfile?.positions.map((p) => p.position) ?? [],
      },
    })),
  };
}

/**
 * The organizer accepts or rejects a pending request. Accepting turns the ask into a CONFIRMED participant.
 * Concurrency: the participant trigger takes a row lock on the match, so capacity (and OPEN -> FULL) is checked under
 * the lock and two simultaneous accepts cannot overbook. The overlap exclusion constraint stops the same player being
 * confirmed in two overlapping matches; when two organizers do that at once, Postgres aborts one transaction as a
 * deadlock victim, so the whole transaction is retried (see withDeadlockRetry) and ends in a clean 409 SCHEDULE_CONFLICT.
 * An admin deciding a request of a match they do not organize leaves an audit record (AUD-02), written in the same transaction and
 * only when the request really moves out of PENDING (the status is read under the match lock, so two simultaneous decisions leave ONE record).
 */
export async function decideRequest(actor: Actor, matchId: string, requestId: string, decision: 'accept' | 'reject', httpRequestId?: string) {
  const m = await loadManageableMatch(matchId, actor);
  const request = await prisma.matchRequest.findFirst({ where: { id: requestId, matchId } });
  if (!request) throw new AppError(404, 'REQUEST_NOT_FOUND', 'Request not found');
  if (request.status !== 'PENDING') throw new AppError(409, 'REQUEST_ALREADY_DECIDED', 'This request was already decided');

  // Confirming a player can race with another match confirming the same player: retry if we lose a deadlock.
  await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    // Match row first, then the request (same order as cancel / start): without this, accept vs cancel deadlocked.
    await lockMatch(tx, matchId);
    const before = await tx.matchRequest.findUnique({ where: { id: requestId }, select: { status: true } });
    // SEC-01: a suspended player is not accepted into a match. Checked under the match lock and before any write, so a refusal leaves the
    // request PENDING and creates no participant, notification or audit record. Existing confirmed participations are not touched.
    if (decision === 'accept' && (await tx.user.count({ where: { id: request.userId, status: 'SUSPENDED' } })) > 0) {
      throw new AppError(409, 'PLAYER_UNAVAILABLE', 'This player is currently unavailable');
    }
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
    if (isAdminOverride(actor, m.organizerId) && before?.status === 'PENDING') {
      await recordAdminAudit(tx, {
        actorId: actor.userId,
        action: decision === 'accept' ? 'JOIN_REQUEST_ACCEPTED_BY_ADMIN' : 'JOIN_REQUEST_REJECTED_BY_ADMIN',
        targetType: 'MATCH',
        targetId: matchId,
        metadata: { fromStatus: 'PENDING', toStatus: decision === 'accept' ? 'ACCEPTED' : 'REJECTED', organizerId: m.organizerId, requestId, subjectUserId: request.userId },
        requestId: httpRequestId,
      });
    }
    // `before` was read under the match lock: only the transaction that really performs PENDING -> decided tells the player. A second,
    // simultaneous decision of the same kind finds the request already decided, changes nothing and says nothing.
    if (before?.status === 'PENDING') {
      await notify(tx, [request.userId], decision === 'accept' ? 'MATCH_REQUEST_ACCEPTED' : 'MATCH_REQUEST_REJECTED',
        { matchId, title: m.title }, { type: 'match', id: matchId });
    }
  }));

  return { match: await getMatch(actor, matchId) };
}

// ───────────────────────── participants ─────────────────────────

/** Confirmed players of a match. Attendance is shown to the organizer and admins only. */
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
      deleted: p.user.status === 'DELETED',
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
  return withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    await lockMatch(tx, matchId); // match row first (see lib/locks.ts)
    const p = await tx.matchParticipant.findUnique({ where: { matchId_userId: { matchId, userId: actor.userId } } });
    if (!p || p.status !== 'CONFIRMED') throw new AppError(404, 'NOT_A_PARTICIPANT', 'You are not confirmed in this match');
    // DB trigger sets left_at + is_late_cancellation and reopens FULL -> OPEN.
    const left = await tx.matchParticipant.update({ where: { id: p.id }, data: { status: 'LEFT' } });
    await notify(tx, [m.organizerId], 'MATCH_PLAYER_LEFT', { matchId, title: m.title, userId: actor.userId, late: left.isLateCancellation }, { type: 'match', id: matchId });
    return { left: true, lateCancellation: left.isLateCancellation };
  }));
}

/**
 * The organizer removes a confirmed player of an OPEN match before the start: status REMOVED, not a late cancellation, no penalty for the player.
 * D19: in a TEAM_CHALLENGE the rosters belong to the teams, not to the organizer: each team's captain and vice captain manage only their own
 * side, through the team roster endpoint (`removeFromRoster`, which checks the caller is staff of THAT team and that the player is on that
 * team's side). This endpoint is therefore refused for a team match, otherwise the organizer (the challenging team's captain at creation, who
 * may not even be team staff any more) could remove players of either side. An admin's override stays possible and audited. The match type
 * never changes after creation (DB trigger), so the check does not need the match lock.
 */
export async function removeParticipant(actor: Actor, matchId: string, userId: string, httpRequestId?: string): Promise<void> {
  const m = await loadManageableMatch(matchId, actor);
  if (m.type === 'TEAM_CHALLENGE' && !isAdminOverride(actor, m.organizerId)) {
    throw new AppError(409, 'USE_TEAM_ROSTER', 'Players of a team match are removed through the team roster, by the captain or vice captain of their own team');
  }
  await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    await lockMatch(tx, matchId);
    const p = await tx.matchParticipant.findUnique({ where: { matchId_userId: { matchId, userId } } });
    if (!p || p.status !== 'CONFIRMED') throw new AppError(404, 'NOT_A_PARTICIPANT', 'This player is not confirmed in the match');
    await tx.matchParticipant.update({ where: { id: p.id }, data: { status: 'REMOVED' } }); // not a late cancellation, no penalty
    if (isAdminOverride(actor, m.organizerId)) {
      await recordAdminAudit(tx, { actorId: actor.userId, action: 'PARTICIPANT_REMOVED_BY_ADMIN', targetType: 'MATCH', targetId: matchId, metadata: { fromStatus: 'CONFIRMED', toStatus: 'REMOVED', organizerId: m.organizerId, subjectUserId: userId }, requestId: httpRequestId });
    }
    await notify(tx, [userId], 'MATCH_REMOVED', { matchId, title: m.title }, { type: 'match', id: matchId });
  }));
}

/**
 * No-shows are recorded by the organizer after the start (D4); the DB refuses it earlier. Attendance feeds the reliability score, so an
 * admin marking it on a match they do not organize leaves an audit record (AUD-02), in the same transaction and only when something
 * actually changes: the status, or who confirmed it (an admin re-confirming the same status replaces the organizer as confirmer, which is a
 * real change). The same status by the same confirmer is a no-op and is not recorded.
 */
export async function setAttendance(actor: Actor, matchId: string, userId: string, status: z.infer<typeof attendanceSchema>['status'], httpRequestId?: string) {
  const m = await loadManageableMatch(matchId, actor);
  const p = await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    await lockMatch(tx, matchId); // the participant trigger locks the match row; take it first so the order is always match -> participant
    const where = { matchId_userId: { matchId, userId } };
    const before = await tx.matchParticipant.findUnique({ where, select: { attendanceStatus: true, attendanceConfirmedById: true } });
    const updated = await tx.matchParticipant.update({ where, data: { attendanceStatus: status, attendanceConfirmedById: actor.userId } });
    if (isAdminOverride(actor, m.organizerId) && before && (before.attendanceStatus !== status || before.attendanceConfirmedById !== actor.userId)) {
      await recordAdminAudit(tx, {
        actorId: actor.userId,
        action: status === 'ATTENDED' ? 'PARTICIPANT_ATTENDED_BY_ADMIN' : 'PARTICIPANT_NO_SHOW_BY_ADMIN',
        targetType: 'MATCH',
        targetId: matchId,
        metadata: { fromStatus: before.attendanceStatus, toStatus: status, organizerId: m.organizerId, subjectUserId: userId },
        requestId: httpRequestId,
      });
    }
    return updated;
  }));
  return { userId, attendanceStatus: p.attendanceStatus };
}

// ───────────────────────── invitations (private matches, D8) ─────────────────────────

/** The organizer invites a user (needed for PRIVATE matches). Re-inviting refreshes the pending invitation; blocked users look like non-existent ones. */
export async function inviteUser(actor: Actor, matchId: string, inviteeId: string, httpRequestId?: string): Promise<void> {
  const m = await loadManageableMatch(matchId, actor);
  if (!['OPEN', 'FULL'].includes(m.status)) throw new AppError(409, 'INVALID_STATE', 'This match no longer takes invitations');
  if (inviteeId === m.organizerId) throw new AppError(400, 'INVALID_INVITEE', 'You organize this match');

  const invitee = await prisma.user.findUnique({ where: { id: inviteeId }, select: { id: true, status: true } });
  const blocked = await areBlocked(actor.userId, inviteeId);
  if (!invitee || invitee.status !== 'ACTIVE' || blocked) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

  await prisma.$transaction(async (tx) => {
    // Match row first, like every other participation change: the admin audit decision below ("did anything change?") must not race
    // with another invitation of the same player.
    await lockMatch(tx, matchId);
    const where = { matchId_inviteeId: { matchId, inviteeId } };
    const before = await tx.matchInvitation.findUnique({ where, select: { status: true, invitedById: true } });
    await tx.matchInvitation.upsert({
      where,
      create: { matchId, inviteeId, invitedById: actor.userId },
      update: { status: 'PENDING', invitedById: actor.userId },
    });
    // New, renewed (it was not pending) or taken over by someone else = a real change. Inviting again with nothing different is not:
    // it is neither recorded in the admin audit log nor announced to the invitee a second time.
    const changed = !before || before.status !== 'PENDING' || before.invitedById !== actor.userId;
    if (isAdminOverride(actor, m.organizerId) && changed) {
      await recordAdminAudit(tx, { actorId: actor.userId, action: 'MATCH_INVITATION_SENT_BY_ADMIN', targetType: 'MATCH', targetId: matchId, metadata: { fromStatus: before?.status ?? null, toStatus: 'PENDING', organizerId: m.organizerId, subjectUserId: inviteeId }, requestId: httpRequestId });
    }
    if (changed) await notify(tx, [inviteeId], 'MATCH_INVITATION', { matchId, title: m.title, invitedBy: actor.userId }, { type: 'match', id: matchId });
  });
}
