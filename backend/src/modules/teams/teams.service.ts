import type { Prisma, TeamRole } from '@prisma/client';
import type { z } from 'zod';
import { areBlocked } from '../../lib/blocks';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { Actor } from '../../types/actor';
import { notify } from '../notifications/notify';
import type { createTeamSchema, searchTeamsSchema, updateTeamSchema } from './teams.schemas';

/*
 * Teams. The captain is the TeamMember row with role CAPTAIN (one per team, partial unique index).
 * CAPTAIN and VICE_CAPTAIN are "staff" (invite, remove members, challenge, pick rosters);
 * only the CAPTAIN changes roles, transfers captaincy, or is protected from removal.
 */

export const MAX_TEAM_MEMBERS = 30;
const INVITATION_TTL_DAYS = 7;
const DAY = 86_400_000;

const userSummary = { select: { id: true, fullName: true, avatarUrl: true } } as const;

/** The user's role in the team, or null when they are not a member. */
export async function myRole(teamId: string, userId: string): Promise<TeamRole | null> {
  const m = await prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } }, select: { role: true } });
  return m?.role ?? null;
}

/** Requires captain or vice captain (403 otherwise; 404 when the team does not exist) and returns the caller's role. */
export async function requireStaff(teamId: string, actor: Actor): Promise<TeamRole> {
  const role = await myRole(teamId, actor.userId);
  if (!role) {
    // a team that exists but you are not part of: do not hint at details of the staff area
    await assertTeamExists(teamId);
    throw new AppError(403, 'FORBIDDEN', 'Only the team captain or vice captain can do this');
  }
  if (role === 'MEMBER') throw new AppError(403, 'FORBIDDEN', 'Only the team captain or vice captain can do this');
  return role;
}

async function assertTeamExists(teamId: string) {
  if (!(await prisma.team.findUnique({ where: { id: teamId }, select: { id: true } }))) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found');
  }
}

/** Captain + vice captains: who gets challenge / roster notifications. */
export async function staffIds(db: Prisma.TransactionClient | typeof prisma, teamId: string): Promise<string[]> {
  const rows = await db.teamMember.findMany({ where: { teamId, role: { in: ['CAPTAIN', 'VICE_CAPTAIN'] } }, select: { userId: true } });
  return rows.map((r) => r.userId);
}

async function assertCityExists(cityId?: string | null) {
  if (cityId && !(await prisma.city.findUnique({ where: { id: cityId } }))) throw new AppError(400, 'INVALID_CITY', 'Unknown city');
}

// ───────────────────────── teams ─────────────────────────

const teamInclude = {
  city: { select: { id: true, nameAr: true, nameEn: true } },
  members: { orderBy: { joinedAt: 'asc' as const }, include: { user: userSummary } },
} satisfies Prisma.TeamInclude;
type TeamRow = Prisma.TeamGetPayload<{ include: typeof teamInclude }>;

function toDto(t: TeamRow, viewerId: string) {
  const mine = t.members.find((m) => m.userId === viewerId);
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    logoUrl: t.logoUrl,
    city: t.city,
    memberCount: t.members.length,
    captain: t.members.find((m) => m.role === 'CAPTAIN')?.user ?? null,
    myRole: mine?.role ?? null,
    members: t.members.map((m) => ({ userId: m.userId, fullName: m.user.fullName, avatarUrl: m.user.avatarUrl, role: m.role, joinedAt: m.joinedAt })),
    createdAt: t.createdAt,
  };
}

/** Creates a team; the creator becomes its CAPTAIN in the same insert (there is no captain column: the captain is a member row). */
export async function createTeam(actor: Actor, input: z.infer<typeof createTeamSchema>) {
  await assertCityExists(input.cityId);
  const t = await prisma.team.create({
    data: {
      name: input.name,
      description: input.description,
      logoUrl: input.logoUrl,
      cityId: input.cityId,
      members: { create: { userId: actor.userId, role: 'CAPTAIN' } },
    },
    include: teamInclude,
  });
  return toDto(t, actor.userId);
}

/** Team details with members. Public to any signed-in user; `myRole` is set for members. */
export async function getTeam(actor: Actor, teamId: string) {
  const t = await prisma.team.findUnique({ where: { id: teamId }, include: teamInclude });
  if (!t) throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found');
  return toDto(t, actor.userId);
}

/** Edits name, description, logo or city (captain / vice captain). */
export async function updateTeam(actor: Actor, teamId: string, input: z.infer<typeof updateTeamSchema>) {
  await requireStaff(teamId, actor);
  await assertCityExists(input.cityId);
  await prisma.team.update({ where: { id: teamId }, data: input });
  return getTeam(actor, teamId);
}

/** Searches teams by name (case-insensitive) and city, alphabetical. */
export async function searchTeams(actor: Actor, q: z.infer<typeof searchTeamsSchema>) {
  const where: Prisma.TeamWhereInput = {
    ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
    ...(q.cityId ? { cityId: q.cityId } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.team.findMany({ where, include: teamInclude, orderBy: { name: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.team.count({ where }),
  ]);
  return { teams: rows.map((t) => toDto(t, actor.userId)), page: q.page, pageSize: q.pageSize, total };
}

/** Teams the caller belongs to. */
export async function myTeams(actor: Actor) {
  const rows = await prisma.team.findMany({ where: { members: { some: { userId: actor.userId } } }, include: teamInclude, orderBy: { name: 'asc' } });
  return { teams: rows.map((t) => toDto(t, actor.userId)) };
}

// ───────────────────────── members ─────────────────────────

export async function removeMember(actor: Actor, teamId: string, userId: string): Promise<void> {
  const role = await requireStaff(teamId, actor);
  const target = await prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } });
  if (!target) throw new AppError(404, 'NOT_A_TEAM_MEMBER', 'This player is not in the team');
  if (target.role === 'CAPTAIN') throw new AppError(409, 'CAPTAIN_PROTECTED', 'Transfer the captaincy before removing the captain');
  if (target.role === 'VICE_CAPTAIN' && role !== 'CAPTAIN') throw new AppError(403, 'FORBIDDEN', 'Only the captain can remove a vice captain');
  await prisma.$transaction(async (tx) => {
    await dropFromUpcomingRosters(tx, teamId, userId, 'REMOVED');
    await tx.teamMember.delete({ where: { teamId_userId: { teamId, userId } } });
    await notify(tx, [userId], 'TEAM_MEMBER_REMOVED', { teamId }, { type: 'team', id: teamId });
  });
}

/** A member leaves (the captain must transfer the captaincy first). Also drops them from the team's upcoming match rosters. */
export async function leaveTeam(actor: Actor, teamId: string): Promise<void> {
  const role = await myRole(teamId, actor.userId);
  if (!role) throw new AppError(404, 'NOT_A_TEAM_MEMBER', 'You are not in this team');
  if (role === 'CAPTAIN') throw new AppError(409, 'CAPTAIN_PROTECTED', 'Transfer the captaincy before leaving the team');
  await prisma.$transaction(async (tx) => {
    await dropFromUpcomingRosters(tx, teamId, actor.userId, 'LEFT');
    await tx.teamMember.delete({ where: { teamId_userId: { teamId, userId: actor.userId } } });
    await notify(tx, await staffIds(tx, teamId), 'TEAM_MEMBER_LEFT', { teamId, userId: actor.userId }, { type: 'team', id: teamId });
  });
}

/** A player who leaves (or is removed from) a team drops out of that team's rosters for matches that have not started. */
async function dropFromUpcomingRosters(tx: Prisma.TransactionClient, teamId: string, userId: string, status: 'LEFT' | 'REMOVED') {
  await tx.matchParticipant.updateMany({
    where: { userId, status: 'CONFIRMED', matchTeam: { teamId }, match: { status: 'SCHEDULED', startAt: { gt: new Date() } } },
    data: { status, leftAt: new Date() }, // the DB trigger stamps left_at and the late-cancellation flag per row
  });
}

/** Captain-only: promote a member to vice captain or demote back. The captain role itself changes only by transfer. */
export async function setMemberRole(actor: Actor, teamId: string, userId: string, role: 'VICE_CAPTAIN' | 'MEMBER') {
  if ((await myRole(teamId, actor.userId)) !== 'CAPTAIN') throw new AppError(403, 'FORBIDDEN', 'Only the captain can change roles');
  const target = await prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } });
  if (!target) throw new AppError(404, 'NOT_A_TEAM_MEMBER', 'This player is not in the team');
  if (target.role === 'CAPTAIN') throw new AppError(409, 'CAPTAIN_PROTECTED', 'Use transfer-captaincy to change the captain');
  await prisma.teamMember.update({ where: { teamId_userId: { teamId, userId } }, data: { role } });
  return getTeam(actor, teamId);
}

/**
 * Captain-only: hands the captaincy to another member; the old captain becomes vice captain.
 * Concurrency: the captain's row is locked (`FOR UPDATE`) so two simultaneous transfers serialize, and the old captain is
 * demoted BEFORE the new one is promoted because the DB allows exactly one CAPTAIN per team (partial unique index).
 */
export async function transferCaptaincy(actor: Actor, teamId: string, userId: string) {
  if (userId === actor.userId) throw new AppError(400, 'INVALID_TARGET', 'You are already the captain');
  await prisma.$transaction(async (tx) => {
    // Lock the captain row so two concurrent transfers serialize; the unique index allows one captain at a time.
    const me = await tx.$queryRaw<{ role: string }[]>`SELECT role::text FROM team_member WHERE team_id = ${teamId}::uuid AND user_id = ${actor.userId}::uuid FOR UPDATE`;
    if (me[0]?.role !== 'CAPTAIN') throw new AppError(403, 'FORBIDDEN', 'Only the captain can transfer the captaincy');
    const target = await tx.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } });
    if (!target) throw new AppError(404, 'NOT_A_TEAM_MEMBER', 'This player is not in the team');
    await tx.teamMember.update({ where: { teamId_userId: { teamId, userId: actor.userId } }, data: { role: 'VICE_CAPTAIN' } });
    await tx.teamMember.update({ where: { teamId_userId: { teamId, userId } }, data: { role: 'CAPTAIN' } });
    await notify(tx, [userId], 'TEAM_CAPTAIN_TRANSFERRED', { teamId }, { type: 'team', id: teamId });
  });
  return getTeam(actor, teamId);
}

// ───────────────────────── invitations ─────────────────────────

export async function inviteToTeam(actor: Actor, teamId: string, inviteeId: string) {
  await requireStaff(teamId, actor);
  const [invitee, blocked, isMember, memberCount, team] = await Promise.all([
    prisma.user.findUnique({ where: { id: inviteeId }, select: { status: true } }),
    areBlocked(actor.userId, inviteeId),
    prisma.teamMember.count({ where: { teamId, userId: inviteeId } }),
    prisma.teamMember.count({ where: { teamId } }),
    prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { name: true } }),
  ]);
  if (!invitee || invitee.status !== 'ACTIVE' || blocked) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  if (isMember > 0) throw new AppError(409, 'ALREADY_TEAM_MEMBER', 'This player is already in the team');
  if (memberCount >= MAX_TEAM_MEMBERS) throw new AppError(409, 'TEAM_FULL', `A team can have at most ${MAX_TEAM_MEMBERS} players`);

  return prisma.$transaction(async (tx) => {
    // Re-inviting refreshes the pending invitation instead of piling up duplicates.
    await tx.teamInvitation.updateMany({ where: { teamId, inviteeId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    const inv = await tx.teamInvitation.create({
      data: { teamId, inviteeId, invitedById: actor.userId, expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * DAY) },
    });
    await notify(tx, [inviteeId], 'TEAM_INVITATION', { teamId, teamName: team.name, invitationId: inv.id, invitedBy: actor.userId }, { type: 'team', id: teamId });
    return { invitation: { id: inv.id, status: inv.status, expiresAt: inv.expiresAt } };
  });
}

/** Pending, unexpired invitations the team has sent (captain / vice captain). */
export async function listTeamInvitations(actor: Actor, teamId: string) {
  await requireStaff(teamId, actor);
  const rows = await prisma.teamInvitation.findMany({
    where: { teamId, status: 'PENDING', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    include: { invitee: userSummary },
  });
  return { invitations: rows.map((i) => ({ id: i.id, status: i.status, expiresAt: i.expiresAt, createdAt: i.createdAt, invitee: i.invitee })) };
}

/** Pending, unexpired team invitations addressed to the caller. */
export async function myInvitations(actor: Actor) {
  const rows = await prisma.teamInvitation.findMany({
    where: { inviteeId: actor.userId, status: 'PENDING', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    include: { team: { select: { id: true, name: true, logoUrl: true } }, invitedBy: userSummary },
  });
  return { invitations: rows.map((i) => ({ id: i.id, team: i.team, invitedBy: i.invitedBy, expiresAt: i.expiresAt, createdAt: i.createdAt })) };
}

/**
 * The invitee accepts or declines. An expired invitation is marked EXPIRED and refused. The answer is an atomic claim
 * (`updateMany ... WHERE status = PENDING`), so only one of two concurrent answers wins; accepting re-checks the team size
 * inside the same transaction and adds the member.
 */
export async function respondToInvitation(actor: Actor, invitationId: string, decision: 'accept' | 'decline') {
  const inv = await prisma.teamInvitation.findUnique({ where: { id: invitationId }, include: { team: { select: { name: true } } } });
  if (!inv || inv.inviteeId !== actor.userId) throw new AppError(404, 'INVITATION_NOT_FOUND', 'Invitation not found');
  if (inv.status !== 'PENDING') throw new AppError(409, 'INVITATION_ALREADY_DECIDED', 'This invitation is no longer pending');
  if (inv.expiresAt && inv.expiresAt <= new Date()) {
    await prisma.teamInvitation.updateMany({ where: { id: invitationId, status: 'PENDING' }, data: { status: 'EXPIRED' } });
    throw new AppError(409, 'INVITATION_EXPIRED', 'This invitation has expired');
  }

  await prisma.$transaction(async (tx) => {
    // Atomic claim: only one concurrent answer wins.
    const claimed = await tx.teamInvitation.updateMany({
      where: { id: invitationId, status: 'PENDING' },
      data: { status: decision === 'accept' ? 'ACCEPTED' : 'DECLINED' },
    });
    if (claimed.count === 0) throw new AppError(409, 'INVITATION_ALREADY_DECIDED', 'This invitation is no longer pending');

    if (decision === 'accept') {
      if ((await tx.teamMember.count({ where: { teamId: inv.teamId } })) >= MAX_TEAM_MEMBERS) {
        throw new AppError(409, 'TEAM_FULL', `A team can have at most ${MAX_TEAM_MEMBERS} players`);
      }
      await tx.teamMember.upsert({
        where: { teamId_userId: { teamId: inv.teamId, userId: actor.userId } },
        create: { teamId: inv.teamId, userId: actor.userId },
        update: {},
      });
    }
    await notify(tx, [inv.invitedById], decision === 'accept' ? 'TEAM_INVITATION_ACCEPTED' : 'TEAM_INVITATION_DECLINED',
      { teamId: inv.teamId, teamName: inv.team.name, userId: actor.userId }, { type: 'team', id: inv.teamId });
  });
  return decision === 'accept' ? { joined: true, team: await getTeam(actor, inv.teamId) } : { joined: false };
}

/** Staff withdraw a pending invitation (409 if it was already answered). */
export async function cancelInvitation(actor: Actor, invitationId: string): Promise<void> {
  const inv = await prisma.teamInvitation.findUnique({ where: { id: invitationId } });
  if (!inv) throw new AppError(404, 'INVITATION_NOT_FOUND', 'Invitation not found');
  await requireStaff(inv.teamId, actor);
  const res = await prisma.teamInvitation.updateMany({ where: { id: invitationId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
  if (res.count === 0) throw new AppError(409, 'INVITATION_ALREADY_DECIDED', 'This invitation is no longer pending');
}
