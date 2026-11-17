import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { AppError } from '../../lib/errors';
import { withDeadlockRetry } from '../../lib/db-errors';
import { lockMatch } from '../../lib/locks';
import { prisma } from '../../lib/prisma';
import type { Actor } from '../../types/actor';
import { getMatch } from '../matches/matches.service';
import { notify } from '../notifications/notify';
import type { challengesQuerySchema, createChallengeSchema } from './teams.schemas';
import { myRole, requireStaff, staffIds } from './teams.service';

/*
 * Team challenge (D9): accepting creates ONE TEAM_CHALLENGE match (starts SCHEDULED) with two MatchTeam
 * sides (HOME = challenger, AWAY = challenged). There is no open recruitment and no join requests:
 * each side's captain / vice captain picks the roster from their own team (match_participant rows).
 */

const FORMAT_SIZE = { F5: 5, F7: 7, F11: 11 } as const;
const MATCH_MINUTES = 90;
const CHALLENGE_TTL_DAYS = 7;
const DAY = 86_400_000;
const MINUTE = 60_000;

const teamSummary = { select: { id: true, name: true, logoUrl: true } } as const;

// ───────────────────────── challenges ─────────────────────────

export async function createChallenge(actor: Actor, teamId: string, input: z.infer<typeof createChallengeSchema>) {
  await requireStaff(teamId, actor);
  if (input.challengedTeamId === teamId) throw new AppError(400, 'INVALID_TARGET', 'A team cannot challenge itself');

  const startAt = new Date(input.proposedStartAt);
  if (startAt.getTime() <= Date.now() + 5 * MINUTE) throw new AppError(400, 'DATE_IN_PAST', 'The proposed start must be in the future');

  const [challenger, challenged] = await Promise.all([
    prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { name: true, _count: { select: { members: true } } } }),
    prisma.team.findUnique({ where: { id: input.challengedTeamId }, select: { name: true } }),
  ]);
  if (!challenged) throw new AppError(404, 'TEAM_NOT_FOUND', 'The challenged team was not found');
  if (challenger._count.members < FORMAT_SIZE[input.format]) {
    throw new AppError(409, 'TEAM_TOO_SMALL', `Your team needs at least ${FORMAT_SIZE[input.format]} players for this format`);
  }
  await assertNoBlockBetweenStaff(teamId, input.challengedTeamId);

  // The offer lapses after 7 days or before the proposed kick-off, whichever is first.
  const expiresAt = new Date(Math.min(Date.now() + CHALLENGE_TTL_DAYS * DAY, startAt.getTime() - 5 * MINUTE));
  const c = await prisma.$transaction(async (tx) => {
    const row = await tx.teamChallenge.create({
      data: { challengerTeamId: teamId, challengedTeamId: input.challengedTeamId, format: input.format, proposedStartAt: startAt, message: input.message ?? undefined, expiresAt },
    });
    await notify(tx, await staffIds(tx, input.challengedTeamId), 'CHALLENGE_RECEIVED',
      { challengeId: row.id, challengerTeamId: teamId, challengerName: challenger.name, startAt: startAt.toISOString() }, { type: 'challenge', id: row.id });
    return row;
  });
  return { challenge: await challengeDto(c.id) };
}

async function assertNoBlockBetweenStaff(a: string, b: string) {
  const [sa, sb] = await Promise.all([staffIds(prisma, a), staffIds(prisma, b)]);
  const n = await prisma.blockedUser.count({
    where: { OR: [{ blockerId: { in: sa }, blockedId: { in: sb } }, { blockerId: { in: sb }, blockedId: { in: sa } }] },
  });
  if (n > 0) throw new AppError(404, 'TEAM_NOT_FOUND', 'The challenged team was not found');
}

const challengeInclude = {
  challenger: teamSummary,
  challenged: teamSummary,
} satisfies Prisma.TeamChallengeInclude;

async function challengeDto(id: string) {
  const c = await prisma.teamChallenge.findUniqueOrThrow({ where: { id }, include: challengeInclude });
  return {
    id: c.id,
    status: c.status,
    format: c.format,
    proposedStartAt: c.proposedStartAt,
    message: c.message,
    expiresAt: c.expiresAt,
    challenger: c.challenger,
    challenged: c.challenged,
    matchId: c.resultingMatchId,
    createdAt: c.createdAt,
    decidedAt: c.decidedAt,
  };
}

/** Incoming or outgoing challenges of a team, visible to its members. */
export async function listChallenges(actor: Actor, teamId: string, q: z.infer<typeof challengesQuerySchema>) {
  if (!(await myRole(teamId, actor.userId))) throw new AppError(403, 'FORBIDDEN', 'Only team members can see the team\'s challenges');
  const rows = await prisma.teamChallenge.findMany({
    where: { ...(q.direction === 'incoming' ? { challengedTeamId: teamId } : { challengerTeamId: teamId }), ...(q.status ? { status: q.status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true },
  });
  return { challenges: await Promise.all(rows.map((r) => challengeDto(r.id))) };
}

/** PENDING offers that ran out of time are marked EXPIRED the moment anyone touches them (the sweeper job does the same in bulk). */
async function loadPending(challengeId: string) {
  const c = await prisma.teamChallenge.findUnique({ where: { id: challengeId } });
  if (!c) throw new AppError(404, 'CHALLENGE_NOT_FOUND', 'Challenge not found');
  if (c.status !== 'PENDING') throw new AppError(409, 'CHALLENGE_ALREADY_DECIDED', 'This challenge was already answered');
  if (c.expiresAt <= new Date()) {
    await prisma.teamChallenge.updateMany({ where: { id: challengeId, status: 'PENDING' }, data: { status: 'EXPIRED' } });
    throw new AppError(409, 'CHALLENGE_EXPIRED', 'This challenge has expired');
  }
  return c;
}

/**
 * The challenged team's staff accept. In ONE transaction: claim the challenge atomically (so a concurrent accept / reject /
 * cancel yields exactly one winner), create the TEAM_CHALLENGE match (SCHEDULED) with its two sides, link it back, and
 * notify the challenger. The DB checks at COMMIT that the match really has two sides. The challenger's captain becomes
 * the organizer because a match has a single organizer.
 */
export async function acceptChallenge(actor: Actor, challengeId: string) {
  const c = await loadPending(challengeId);
  await requireStaff(c.challengedTeamId, actor);

  const [challenger, challenged, captain] = await Promise.all([
    prisma.team.findUniqueOrThrow({ where: { id: c.challengerTeamId }, select: { name: true, cityId: true, _count: { select: { members: true } } } }),
    prisma.team.findUniqueOrThrow({ where: { id: c.challengedTeamId }, select: { name: true, cityId: true, _count: { select: { members: true } } } }),
    prisma.teamMember.findFirstOrThrow({ where: { teamId: c.challengerTeamId, role: 'CAPTAIN' }, select: { userId: true } }),
  ]);
  const need = FORMAT_SIZE[c.format];
  if (challenged._count.members < need) throw new AppError(409, 'TEAM_TOO_SMALL', `Your team needs at least ${need} players for this format`);
  if (challenger._count.members < need) throw new AppError(409, 'CHALLENGER_TEAM_TOO_SMALL', 'The challenging team no longer has enough players');

  const matchId = await prisma.$transaction(async (tx) => {
    // Atomic claim: concurrent accept / reject / cancel -> exactly one wins.
    const claimed = await tx.teamChallenge.updateMany({
      where: { id: challengeId, status: 'PENDING', expiresAt: { gt: new Date() } },
      data: { status: 'ACCEPTED', decidedById: actor.userId, decidedAt: new Date() },
    });
    if (claimed.count === 0) throw new AppError(409, 'CHALLENGE_ALREADY_DECIDED', 'This challenge was already answered');

    // The challenger's captain organizes the match (the schema has a single organizer). Sides are checked at COMMIT by the DB.
    const m = await tx.match.create({
      data: {
        organizerId: captain.userId,
        type: 'TEAM_CHALLENGE',
        status: 'SCHEDULED',
        visibility: 'PUBLIC',
        format: c.format,
        title: `${challenger.name} vs ${challenged.name}`,
        startAt: c.proposedStartAt,
        endAt: new Date(c.proposedStartAt.getTime() + MATCH_MINUTES * MINUTE),
        cityId: challenged.cityId ?? challenger.cityId,
        teams: { create: [{ teamId: c.challengerTeamId, side: 'HOME' }, { teamId: c.challengedTeamId, side: 'AWAY' }] },
      },
    });
    await tx.teamChallenge.update({ where: { id: challengeId }, data: { resultingMatchId: m.id } });
    await tx.matchEvent.create({ data: { matchId: m.id, actorId: actor.userId, toStatus: 'SCHEDULED', reason: 'team challenge accepted' } });
    await notify(tx, await staffIds(tx, c.challengerTeamId), 'CHALLENGE_ACCEPTED',
      { challengeId, matchId: m.id, challengedName: challenged.name, startAt: m.startAt.toISOString() }, { type: 'match', id: m.id });
    return m.id;
  });
  return { challenge: await challengeDto(challengeId), match: await getMatch(actor, matchId) };
}

/** The challenged team's staff reject a pending challenge (final). */
export async function rejectChallenge(actor: Actor, challengeId: string) {
  const c = await loadPending(challengeId);
  await requireStaff(c.challengedTeamId, actor);
  await prisma.$transaction(async (tx) => {
    const res = await tx.teamChallenge.updateMany({ where: { id: challengeId, status: 'PENDING' }, data: { status: 'REJECTED', decidedById: actor.userId, decidedAt: new Date() } });
    if (res.count === 0) throw new AppError(409, 'CHALLENGE_ALREADY_DECIDED', 'This challenge was already answered');
    const team = await tx.team.findUniqueOrThrow({ where: { id: c.challengedTeamId }, select: { name: true } });
    await notify(tx, await staffIds(tx, c.challengerTeamId), 'CHALLENGE_REJECTED', { challengeId, challengedName: team.name }, { type: 'challenge', id: challengeId });
  });
  return { challenge: await challengeDto(challengeId) };
}

/** The challenger's staff withdraw a pending challenge (final). */
export async function cancelChallenge(actor: Actor, challengeId: string) {
  const c = await loadPending(challengeId);
  await requireStaff(c.challengerTeamId, actor);
  await prisma.$transaction(async (tx) => {
    const res = await tx.teamChallenge.updateMany({ where: { id: challengeId, status: 'PENDING' }, data: { status: 'CANCELLED', decidedById: actor.userId, decidedAt: new Date() } });
    if (res.count === 0) throw new AppError(409, 'CHALLENGE_ALREADY_DECIDED', 'This challenge was already answered');
    await notify(tx, await staffIds(tx, c.challengedTeamId), 'CHALLENGE_CANCELLED', { challengeId }, { type: 'challenge', id: challengeId });
  });
  return { challenge: await challengeDto(challengeId) };
}

// ───────────────────────── rosters ─────────────────────────

async function loadSide(teamId: string, matchId: string) {
  const side = await prisma.matchTeam.findUnique({ where: { matchId_teamId: { matchId, teamId } }, include: { match: true } });
  if (!side) throw new AppError(404, 'MATCH_NOT_FOUND', 'This team does not play in that match');
  return side;
}

/** Captain / vice captain picks a player from THEIR team. The DB checks membership, roster size (= format size), overlap with the player's other confirmed matches, and start time. */
export async function addToRoster(actor: Actor, teamId: string, matchId: string, userId: string) {
  await requireStaff(teamId, actor);
  const side = await loadSide(teamId, matchId);
  if (side.match.status !== 'SCHEDULED') throw new AppError(409, 'INVALID_STATE', 'The roster can only change before the match starts');

  await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    await lockMatch(tx, matchId); // match row first (see lib/locks.ts)
    // One row per (match, user): a player who left or was removed is re-activated, not duplicated.
    const existing = await tx.matchParticipant.findUnique({ where: { matchId_userId: { matchId, userId } } });
    if (existing?.status === 'CONFIRMED') throw new AppError(409, 'ALREADY_PARTICIPANT', 'This player is already on a roster for this match');
    if (existing) await tx.matchParticipant.update({ where: { id: existing.id }, data: { status: 'CONFIRMED', matchTeamId: side.id } });
    else await tx.matchParticipant.create({ data: { matchId, userId, matchTeamId: side.id } });
    await notify(tx, [userId], 'TEAM_ROSTER_ADDED', { matchId, teamId, title: side.match.title, startAt: side.match.startAt.toISOString() }, { type: 'match', id: matchId });
  }));
  return getRoster(actor, teamId, matchId);
}

/** Staff remove a player from their own side's roster before the start (status REMOVED, no penalty). */
export async function removeFromRoster(actor: Actor, teamId: string, matchId: string, userId: string) {
  await requireStaff(teamId, actor);
  const side = await loadSide(teamId, matchId);
  await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    await lockMatch(tx, matchId);
    const p = await tx.matchParticipant.findUnique({ where: { matchId_userId: { matchId, userId } } });
    if (!p || p.status !== 'CONFIRMED' || p.matchTeamId !== side.id) throw new AppError(404, 'NOT_A_PARTICIPANT', 'This player is not on your roster');
    await tx.matchParticipant.update({ where: { id: p.id }, data: { status: 'REMOVED' } }); // DB: only before start
    await notify(tx, [userId], 'TEAM_ROSTER_REMOVED', { matchId, teamId, title: side.match.title }, { type: 'match', id: matchId });
  }));
  return getRoster(actor, teamId, matchId);
}

/** The confirmed players of one side and how many the format requires; visible to that team's members. */
export async function getRoster(actor: Actor, teamId: string, matchId: string) {
  if (!(await myRole(teamId, actor.userId)) && actor.role !== 'ADMIN') throw new AppError(403, 'FORBIDDEN', 'Only team members can see the roster');
  const side = await loadSide(teamId, matchId);
  const rows = await prisma.matchParticipant.findMany({
    where: { matchTeamId: side.id, status: 'CONFIRMED' },
    orderBy: { joinedAt: 'asc' },
    include: { user: { select: { id: true, fullName: true, avatarUrl: true } } },
  });
  return {
    side: side.side,
    required: FORMAT_SIZE[side.match.format],
    players: rows.map((p) => ({ userId: p.userId, fullName: p.user.fullName, avatarUrl: p.user.avatarUrl, joinedAt: p.joinedAt })),
  };
}
