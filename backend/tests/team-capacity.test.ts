import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, type TestUser } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;
let captain: TestUser;
let invitees: TestUser[];

const T = '/api/v1/teams';
const MAX = 30;
const prismaP = async () => (await import('../src/lib/prisma')).prisma;

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
  captain = await makeUser(api, 'captain@example.com');
  invitees = [];
  for (let i = 0; i < 6; i++) invitees.push(await makeUser(api, `invitee${i}@example.com`));
});

let batch = 0;
/** A team with exactly `members` members (the captain plus fillers inserted directly: fast, and no invitation is involved). */
async function teamWithMembers(members: number): Promise<string> {
  const prisma = await prismaP();
  batch++;
  const created = await api.call('POST', T, { name: `Capacity team ${batch}` }, captain.token);
  expect(created.status).toBe(201);
  const teamId = created.body.team.id as string;
  const fillers = Array.from({ length: members - 1 }, (_, i) => ({ email: `filler-${batch}-${i}@example.com`, passwordHash: 'x', fullName: `Filler ${batch}-${i}` }));
  await prisma.user.createMany({ data: fillers });
  const users = await prisma.user.findMany({ where: { email: { in: fillers.map((f) => f.email) } }, select: { id: true } });
  await prisma.teamMember.createMany({ data: users.map((u) => ({ teamId, userId: u.id })) });
  expect(await prisma.teamMember.count({ where: { teamId } })).toBe(members);
  return teamId;
}

const invite = async (teamId: string, u: TestUser) => {
  const res = await api.call('POST', `${T}/${teamId}/invitations`, { userId: u.userId }, captain.token);
  expect(res.status).toBe(201);
  return res.body.invitation.id as string;
};
const accept = (invitationId: string, u: TestUser) => api.call('POST', `${T}/invitations/${invitationId}/accept`, {}, u.token);
const memberCount = async (teamId: string) => (await prismaP()).teamMember.count({ where: { teamId } });
const invitationStatuses = async (ids: string[]) => (await (await prismaP()).teamInvitation.findMany({ where: { id: { in: ids } }, select: { status: true } })).map((i) => i.status);

async function race(members: number, expectedWinners: number) {
  const teamId = await teamWithMembers(members);
  const ids: string[] = [];
  for (const u of invitees) ids.push(await invite(teamId, u));

  const results = await Promise.all(invitees.map((u, i) => accept(ids[i]!, u)));

  const won = results.filter((r) => r.status === 200);
  const full = results.filter((r) => r.status === 409 && r.body.error.code === 'TEAM_FULL');
  expect(won).toHaveLength(expectedWinners);
  expect(full).toHaveLength(invitees.length - expectedWinners); // nothing else: no 500, no other conflict
  expect(await memberCount(teamId)).toBe(MAX);
  const statuses = await invitationStatuses(ids);
  expect(statuses.filter((s) => s === 'ACCEPTED')).toHaveLength(expectedWinners);
  expect(statuses.filter((s) => s === 'PENDING')).toHaveLength(invitees.length - expectedWinners); // the losers' claims were rolled back
  // the people who lost are NOT in the team, the winners are
  const prisma = await prismaP();
  const inTeam = new Set((await prisma.teamMember.findMany({ where: { teamId }, select: { userId: true } })).map((m) => m.userId));
  results.forEach((r, i) => expect(inTeam.has(invitees[i]!.userId)).toBe(r.status === 200));
}

describe('the team size limit holds under concurrency (DB-01)', () => {
  it('29 members and 6 pending invitations: six simultaneous acceptances admit exactly ONE (repeated on fresh teams)', async () => {
    for (let round = 0; round < 3; round++) await race(29, 1);
  });

  it('28 members and 6 pending invitations: exactly TWO are admitted, four get TEAM_FULL (repeated on fresh teams)', async () => {
    for (let round = 0; round < 3; round++) await race(28, 2);
  });

  it('sequentially: the last free place is taken once; at capacity every further acceptance is refused with 409 TEAM_FULL and the invitation stays PENDING', async () => {
    const teamId = await teamWithMembers(29);
    const a = await invite(teamId, invitees[0]!);
    const b = await invite(teamId, invitees[1]!);
    expect((await accept(a, invitees[0]!)).status).toBe(200);
    expect(await memberCount(teamId)).toBe(MAX);
    const refused = await accept(b, invitees[1]!);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('TEAM_FULL');
    expect(await invitationStatuses([b])).toEqual(['PENDING']);
    expect(await memberCount(teamId)).toBe(MAX);

    // a team that is full from the start (the invite endpoint itself refuses, so the invitation is inserted directly)
    const full = await teamWithMembers(MAX);
    const inv = await (await prismaP()).teamInvitation.create({ data: { teamId: full, inviteeId: invitees[2]!.userId, invitedById: captain.userId, expiresAt: new Date(Date.now() + 86_400_000) } });
    expect((await accept(inv.id, invitees[2]!)).body.error.code).toBe('TEAM_FULL');
    expect(await invitationStatuses([inv.id])).toEqual(['PENDING']);
    expect(await memberCount(full)).toBe(MAX);
  });

  it('existing rules are untouched: one captain, an answer to the same invitation twice is refused, decline needs no place, and a player already in the team stays a single member', async () => {
    const teamId = await teamWithMembers(5);
    const inv = await invite(teamId, invitees[0]!);
    expect((await accept(inv, invitees[0]!)).status).toBe(200);
    expect((await accept(inv, invitees[0]!)).body.error.code).toBe('INVITATION_ALREADY_DECIDED');
    const other = await invite(teamId, invitees[1]!);
    expect((await api.call('POST', `${T}/invitations/${other}/decline`, {}, invitees[1]!.token)).status).toBe(200);
    expect(await invitationStatuses([other])).toEqual(['DECLINED']);
    expect(await memberCount(teamId)).toBe(6);
    const prisma = await prismaP();
    expect(await prisma.teamMember.count({ where: { teamId, role: 'CAPTAIN' } })).toBe(1);
    expect(await prisma.teamMember.count({ where: { teamId, userId: invitees[0]!.userId } })).toBe(1);
  });

  it('concurrent answers to the SAME invitation still admit the player once', async () => {
    const teamId = await teamWithMembers(10);
    const inv = await invite(teamId, invitees[0]!);
    const results = await Promise.all([accept(inv, invitees[0]!), accept(inv, invitees[0]!), accept(inv, invitees[0]!)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await memberCount(teamId)).toBe(11);
  });
});
