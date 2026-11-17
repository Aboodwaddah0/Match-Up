import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { inHours, makeUser, moveMatchTime, type TestUser } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  const { prisma } = await import('../src/lib/prisma');
  await prisma.$disconnect();
});

async function prismaClient() {
  return (await import('../src/lib/prisma')).prisma;
}

const T = '/api/v1/teams';
const makeTeam = async (u: TestUser, name: string) => (await api.call('POST', T, { name }, u.token)).body.team.id as string;

/** Invites + accepts, so `u` becomes a plain member of the team. */
async function join(teamId: string, captain: TestUser, u: TestUser) {
  const inv = await api.call('POST', `${T}/${teamId}/invitations`, { userId: u.userId }, captain.token);
  expect(inv.status).toBe(201);
  const res = await api.call('POST', `${T}/invitations/${inv.body.invitation.id}/accept`, {}, u.token);
  expect(res.status).toBe(200);
}

/** A team with captain + (n-1) members, all verified with profiles. */
async function fullTeam(prefix: string, size: number) {
  const captain = await makeUser(api, `${prefix}0@example.com`);
  const teamId = await makeTeam(captain, `Team ${prefix}`);
  const members: TestUser[] = [captain];
  for (let i = 1; i < size; i++) {
    const u = await makeUser(api, `${prefix}${i}@example.com`);
    await join(teamId, captain, u);
    members.push(u);
  }
  return { captain, teamId, members };
}

beforeEach(async () => {
  await resetDb();
});

describe('teams and members', () => {
  it('creator becomes captain; anyone can view and search; unverified users cannot create', async () => {
    const cap = await makeUser(api, 'cap@example.com');
    const res = await api.call('POST', T, { name: 'Hebron Lions', description: 'We play Fridays' }, cap.token);
    expect(res.status).toBe(201);
    expect(res.body.team).toMatchObject({ name: 'Hebron Lions', memberCount: 1, myRole: 'CAPTAIN', captain: { id: cap.userId } });

    const other = await makeUser(api, 'other@example.com');
    expect((await api.call('GET', `${T}/${res.body.team.id}`, undefined, other.token)).body.team.myRole).toBeNull();
    expect((await api.call('GET', `${T}?q=lion`, undefined, other.token)).body.total).toBe(1);
    expect((await api.call('GET', `${T}/mine`, undefined, cap.token)).body.teams).toHaveLength(1);

    const unverified = await makeUser(api, 'unv@example.com', { verified: false });
    expect((await api.call('POST', T, { name: 'Nope team' }, unverified.token)).status).toBe(403);
    expect((await api.call('POST', T, { name: 'x' }, cap.token)).status).toBe(400);
  });

  it('only staff edit the team', async () => {
    const cap = await makeUser(api, 'cap@example.com');
    const member = await makeUser(api, 'm@example.com');
    const teamId = await makeTeam(cap, 'Eagles');
    await join(teamId, cap, member);
    expect((await api.call('PATCH', `${T}/${teamId}`, { name: 'Eagles FC' }, cap.token)).body.team.name).toBe('Eagles FC');
    expect((await api.call('PATCH', `${T}/${teamId}`, { name: 'Hacked' }, member.token)).status).toBe(403);
  });

  it('invitation flow: pending is visible, accept joins, decline does not, duplicates and members are refused', async () => {
    const cap = await makeUser(api, 'cap@example.com');
    const a = await makeUser(api, 'a@example.com');
    const b = await makeUser(api, 'b@example.com');
    const teamId = await makeTeam(cap, 'Eagles');

    const inv = await api.call('POST', `${T}/${teamId}/invitations`, { userId: a.userId }, cap.token);
    expect(inv.status).toBe(201);
    expect((await api.call('GET', `${T}/invitations/mine`, undefined, a.token)).body.invitations).toHaveLength(1);
    expect((await api.call('GET', `${T}/${teamId}/invitations`, undefined, cap.token)).body.invitations).toHaveLength(1);

    // re-inviting replaces the pending one (no duplicates)
    const again = await api.call('POST', `${T}/${teamId}/invitations`, { userId: a.userId }, cap.token);
    expect(again.status).toBe(201);
    expect((await api.call('GET', `${T}/invitations/mine`, undefined, a.token)).body.invitations).toHaveLength(1);
    // someone else cannot answer it
    expect((await api.call('POST', `${T}/invitations/${again.body.invitation.id}/accept`, {}, b.token)).status).toBe(404);

    const ok = await api.call('POST', `${T}/invitations/${again.body.invitation.id}/accept`, {}, a.token);
    expect(ok.body).toMatchObject({ joined: true });
    expect((await api.call('GET', `${T}/${teamId}`, undefined, cap.token)).body.team.memberCount).toBe(2);
    expect((await api.call('POST', `${T}/invitations/${again.body.invitation.id}/accept`, {}, a.token)).status).toBe(409);
    expect((await api.call('POST', `${T}/${teamId}/invitations`, { userId: a.userId }, cap.token)).status).toBe(409); // already a member

    const inv2 = await api.call('POST', `${T}/${teamId}/invitations`, { userId: b.userId }, cap.token);
    expect((await api.call('POST', `${T}/invitations/${inv2.body.invitation.id}/decline`, {}, b.token)).body.joined).toBe(false);
    expect((await api.call('GET', `${T}/${teamId}`, undefined, cap.token)).body.team.memberCount).toBe(2);

    // plain members cannot invite
    expect((await api.call('POST', `${T}/${teamId}/invitations`, { userId: b.userId }, a.token)).status).toBe(403);
  });

  it('an expired invitation cannot be accepted', async () => {
    const cap = await makeUser(api, 'cap@example.com');
    const a = await makeUser(api, 'a@example.com');
    const teamId = await makeTeam(cap, 'Eagles');
    const inv = await api.call('POST', `${T}/${teamId}/invitations`, { userId: a.userId }, cap.token);
    const prisma = await prismaClient();
    await prisma.teamInvitation.update({ where: { id: inv.body.invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await api.call('POST', `${T}/invitations/${inv.body.invitation.id}/accept`, {}, a.token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVITATION_EXPIRED');
  });

  it('roles: captain promotes, vice captain can invite and remove members but not the captain', async () => {
    const cap = await makeUser(api, 'cap@example.com');
    const vice = await makeUser(api, 'v@example.com');
    const m1 = await makeUser(api, 'm1@example.com');
    const m2 = await makeUser(api, 'm2@example.com');
    const teamId = await makeTeam(cap, 'Eagles');
    for (const u of [vice, m1, m2]) await join(teamId, cap, u);

    expect((await api.call('PATCH', `${T}/${teamId}/members/${vice.userId}`, { role: 'VICE_CAPTAIN' }, m1.token)).status).toBe(403);
    expect((await api.call('PATCH', `${T}/${teamId}/members/${vice.userId}`, { role: 'VICE_CAPTAIN' }, cap.token)).status).toBe(200);

    const u = await makeUser(api, 'new@example.com');
    expect((await api.call('POST', `${T}/${teamId}/invitations`, { userId: u.userId }, vice.token)).status).toBe(201);
    expect((await api.call('DELETE', `${T}/${teamId}/members/${m1.userId}`, undefined, vice.token)).status).toBe(204);
    expect((await api.call('DELETE', `${T}/${teamId}/members/${cap.userId}`, undefined, vice.token)).status).toBe(409);
    expect((await api.call('DELETE', `${T}/${teamId}/members/${vice.userId}`, undefined, m2.token)).status).toBe(403);
  });

  it('captain transfers the captaincy; the old captain becomes vice; the captain cannot just leave', async () => {
    const cap = await makeUser(api, 'cap@example.com');
    const next = await makeUser(api, 'next@example.com');
    const teamId = await makeTeam(cap, 'Eagles');
    await join(teamId, cap, next);

    expect((await api.call('POST', `${T}/${teamId}/leave`, {}, cap.token)).status).toBe(409);
    expect((await api.call('POST', `${T}/${teamId}/transfer-captaincy`, { userId: cap.userId }, cap.token)).status).toBe(400);
    expect((await api.call('POST', `${T}/${teamId}/transfer-captaincy`, { userId: cap.userId }, next.token)).status).toBe(403);

    const res = await api.call('POST', `${T}/${teamId}/transfer-captaincy`, { userId: next.userId }, cap.token);
    expect(res.status).toBe(200);
    expect(res.body.team.captain.id).toBe(next.userId);
    expect(res.body.team.members.find((m: { userId: string }) => m.userId === cap.userId).role).toBe('VICE_CAPTAIN');
    expect((await api.call('POST', `${T}/${teamId}/leave`, {}, cap.token)).status).toBe(204);
  });
});

describe('team challenges', () => {
  const challenge = (teamId: string, by: TestUser, challengedTeamId: string, over: Record<string, unknown> = {}) =>
    api.call('POST', `${T}/${teamId}/challenges`, { challengedTeamId, format: 'F5', proposedStartAt: inHours(72), ...over }, by.token);

  it('requires staff, a different team, a future date and enough players', async () => {
    const A = await fullTeam('a', 5);
    const B = await fullTeam('b', 5);
    const small = await fullTeam('s', 2);

    expect((await challenge(A.teamId, A.members[1]!, B.teamId)).status).toBe(403); // plain member
    expect((await challenge(A.teamId, A.captain, A.teamId)).status).toBe(400);
    expect((await challenge(A.teamId, A.captain, B.teamId, { proposedStartAt: inHours(-2) })).status).toBe(400);
    const tooSmall = await challenge(small.teamId, small.captain, B.teamId);
    expect(tooSmall.status).toBe(409);
    expect(tooSmall.body.error.code).toBe('TEAM_TOO_SMALL');

    const ok = await challenge(A.teamId, A.captain, B.teamId, { message: 'Friday night?' });
    expect(ok.status).toBe(201);
    expect(ok.body.challenge).toMatchObject({ status: 'PENDING', format: 'F5', challenger: { id: A.teamId }, challenged: { id: B.teamId } });
    // a second pending challenge against the same team is a duplicate
    const dup = await challenge(A.teamId, A.captain, B.teamId);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_CHALLENGE');

    expect((await api.call('GET', `${T}/${B.teamId}/challenges?direction=incoming`, undefined, B.members[2]!.token)).body.challenges).toHaveLength(1);
    expect((await api.call('GET', `${T}/${B.teamId}/challenges`, undefined, A.captain.token)).status).toBe(403);
  });

  it('accepting creates ONE TEAM_CHALLENGE match (SCHEDULED) with two sides; the challenger cannot accept its own offer', async () => {
    const A = await fullTeam('a', 5);
    const B = await fullTeam('b', 5);
    const c = await challenge(A.teamId, A.captain, B.teamId);
    const id = c.body.challenge.id as string;

    expect((await api.call('POST', `/api/v1/challenges/${id}/accept`, {}, A.captain.token)).status).toBe(403);
    expect((await api.call('POST', `/api/v1/challenges/${id}/accept`, {}, B.members[1]!.token)).status).toBe(403);

    const res = await api.call('POST', `/api/v1/challenges/${id}/accept`, {}, B.captain.token);
    expect(res.status).toBe(200);
    const m = res.body.match;
    expect(m).toMatchObject({ type: 'TEAM_CHALLENGE', status: 'SCHEDULED', capacity: null, availableSpots: null, title: 'Team a vs Team b' });
    expect(m.sides).toHaveLength(2);
    expect(m.sides.map((s: { side: string; team: { id: string } }) => [s.side, s.team.id])).toEqual([['HOME', A.teamId], ['AWAY', B.teamId]]);
    expect(res.body.challenge).toMatchObject({ status: 'ACCEPTED', matchId: m.id });

    // already answered
    expect((await api.call('POST', `/api/v1/challenges/${id}/accept`, {}, B.captain.token)).status).toBe(409);
    // no join requests on a team match
    const outsider = await makeUser(api, 'out@example.com');
    expect((await api.call('POST', `/api/v1/matches/${m.id}/requests`, {}, outsider.token)).status).toBe(400);
  });

  it('reject and cancel are final; concurrent accept + cancel yields exactly one outcome', async () => {
    const A = await fullTeam('a', 5);
    const B = await fullTeam('b', 5);
    const c1 = (await challenge(A.teamId, A.captain, B.teamId)).body.challenge.id as string;
    expect((await api.call('POST', `/api/v1/challenges/${c1}/reject`, {}, B.captain.token)).body.challenge.status).toBe('REJECTED');
    expect((await api.call('POST', `/api/v1/challenges/${c1}/accept`, {}, B.captain.token)).status).toBe(409);

    const c2 = (await challenge(A.teamId, A.captain, B.teamId)).body.challenge.id as string;
    expect((await api.call('POST', `/api/v1/challenges/${c2}/cancel`, {}, B.captain.token)).status).toBe(403); // only the challenger cancels
    const [accept, cancel] = await Promise.all([
      api.call('POST', `/api/v1/challenges/${c2}/accept`, {}, B.captain.token),
      api.call('POST', `/api/v1/challenges/${c2}/cancel`, {}, A.captain.token),
    ]);
    expect([accept.status, cancel.status].sort()).toEqual([200, 409]);
    const prisma = await prismaClient();
    const row = await prisma.teamChallenge.findUniqueOrThrow({ where: { id: c2 } });
    expect(row.status === 'ACCEPTED').toBe(accept.status === 200);
    expect(await prisma.match.count({ where: { type: 'TEAM_CHALLENGE' } })).toBe(accept.status === 200 ? 1 : 0);
  });

  it('an expired offer cannot be accepted', async () => {
    const A = await fullTeam('a', 5);
    const B = await fullTeam('b', 5);
    const id = (await challenge(A.teamId, A.captain, B.teamId)).body.challenge.id as string;
    const prisma = await prismaClient();
    await prisma.teamChallenge.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await api.call('POST', `/api/v1/challenges/${id}/accept`, {}, B.captain.token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHALLENGE_EXPIRED');
    expect((await prisma.teamChallenge.findUniqueOrThrow({ where: { id } })).status).toBe('EXPIRED');
  });

  it('the sweeper expires overdue challenges and invitations (idempotent)', async () => {
    const A = await fullTeam('a', 5);
    const B = await fullTeam('b', 5);
    const id = (await challenge(A.teamId, A.captain, B.teamId)).body.challenge.id as string;
    const prisma = await prismaClient();
    await prisma.teamChallenge.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const { expireStaleTeamOffers } = await import('../src/jobs/match-lifecycle');
    expect(await expireStaleTeamOffers()).toBe(1);
    expect(await expireStaleTeamOffers()).toBe(0);
    expect((await prisma.teamChallenge.findUniqueOrThrow({ where: { id } })).status).toBe('EXPIRED');
  });
});

describe('rosters for a team match', () => {
  async function scheduled() {
    const A = await fullTeam('a', 6);
    const B = await fullTeam('b', 5);
    const id = (await api.call('POST', `${T}/${A.teamId}/challenges`, { challengedTeamId: B.teamId, format: 'F5', proposedStartAt: inHours(72) }, A.captain.token)).body.challenge.id;
    const matchId = (await api.call('POST', `/api/v1/challenges/${id}/accept`, {}, B.captain.token)).body.match.id as string;
    return { A, B, matchId };
  }
  const roster = (teamId: string, matchId: string) => `${T}/${teamId}/matches/${matchId}/roster`;

  it('staff pick players from their own team only; the roster is capped at the format size', async () => {
    const { A, B, matchId } = await scheduled();
    for (const u of A.members.slice(0, 5)) expect((await api.call('POST', roster(A.teamId, matchId), { userId: u.userId }, A.captain.token)).status).toBe(201);

    // sixth player of team A: roster full
    const full = await api.call('POST', roster(A.teamId, matchId), { userId: A.members[5]!.userId }, A.captain.token);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('ROSTER_FULL');
    // a player from team B cannot be put on A's roster
    const foreign = await api.call('POST', roster(A.teamId, matchId), { userId: B.members[1]!.userId }, A.captain.token);
    expect(foreign.status).toBe(409);
    expect(foreign.body.error.code).toBe('NOT_A_TEAM_MEMBER');
    // plain members and the other side's captain cannot edit it
    expect((await api.call('POST', roster(A.teamId, matchId), { userId: A.members[5]!.userId }, A.members[1]!.token)).status).toBe(403);
    expect((await api.call('POST', roster(A.teamId, matchId), { userId: A.members[5]!.userId }, B.captain.token)).status).toBe(403);
    expect((await api.call('POST', roster(A.teamId, matchId), { userId: A.members[1]!.userId }, A.captain.token)).status).toBe(409); // already on it

    const view = await api.call('GET', roster(A.teamId, matchId), undefined, A.members[3]!.token);
    expect(view.body).toMatchObject({ side: 'HOME', required: 5 });
    expect(view.body.players).toHaveLength(5);
    const match = await api.call('GET', `/api/v1/matches/${matchId}`, undefined, A.captain.token);
    expect(match.body.match.sides.find((s: { side: string }) => s.side === 'HOME').rosterCount).toBe(5);
    expect((await api.call('GET', `/api/v1/matches/${matchId}/participants`, undefined, B.captain.token)).body.participants[0]).toMatchObject({ side: 'HOME', teamId: A.teamId });

    // swap a player
    expect((await api.call('DELETE', `${roster(A.teamId, matchId)}/${A.members[4]!.userId}`, undefined, A.captain.token)).status).toBe(200);
    expect((await api.call('POST', roster(A.teamId, matchId), { userId: A.members[5]!.userId }, A.captain.token)).status).toBe(201);
    // and bring the removed one back (re-activation, not a duplicate row)
    expect((await api.call('DELETE', `${roster(A.teamId, matchId)}/${A.members[5]!.userId}`, undefined, A.captain.token)).status).toBe(200);
    expect((await api.call('POST', roster(A.teamId, matchId), { userId: A.members[4]!.userId }, A.captain.token)).status).toBe(201);
  });

  it('a player cannot be confirmed in two overlapping matches (DB rule)', async () => {
    const { A, matchId } = await scheduled();
    const C = await fullTeam('c', 5);
    // A's captain also joins team C and C challenges B... simpler: put a member of A on A's roster, then try another overlapping team match
    const shared = A.members[1]!;
    await join(C.teamId, C.captain, shared);
    const D = await fullTeam('d', 5);
    const id = (await api.call('POST', `${T}/${C.teamId}/challenges`, { challengedTeamId: D.teamId, format: 'F5', proposedStartAt: inHours(72) }, C.captain.token)).body.challenge.id;
    const other = (await api.call('POST', `/api/v1/challenges/${id}/accept`, {}, D.captain.token)).body.match.id as string;

    expect((await api.call('POST', roster(A.teamId, matchId), { userId: shared.userId }, A.captain.token)).status).toBe(201);
    const clash = await api.call('POST', roster(C.teamId, other), { userId: shared.userId }, C.captain.token);
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('SCHEDULE_CONFLICT');
  });

  it('leaving the team drops the player from upcoming rosters; the roster is locked once the match starts', async () => {
    const { A, matchId } = await scheduled();
    const leaver = A.members[2]!;
    await api.call('POST', roster(A.teamId, matchId), { userId: leaver.userId }, A.captain.token);
    expect((await api.call('POST', `${T}/${A.teamId}/leave`, {}, leaver.token)).status).toBe(204);
    expect((await api.call('GET', roster(A.teamId, matchId), undefined, A.captain.token)).body.players).toHaveLength(0);

    await api.call('POST', roster(A.teamId, matchId), { userId: A.members[1]!.userId }, A.captain.token);
    await moveMatchTime(matchId, -1, 1);
    const { startDueMatches } = await import('../src/jobs/match-lifecycle');
    await startDueMatches();
    const late = await api.call('POST', roster(A.teamId, matchId), { userId: A.members[3]!.userId }, A.captain.token);
    expect(late.status).toBe(409);
  });

  it('the organizer (challenger captain) can cancel; rosters are freed and players notified', async () => {
    const { A, matchId } = await scheduled();
    await api.call('POST', roster(A.teamId, matchId), { userId: A.members[1]!.userId }, A.captain.token);
    const res = await api.call('POST', `/api/v1/matches/${matchId}/cancel`, { reason: 'pitch unavailable' }, A.captain.token);
    expect(res.status).toBe(200);
    expect(res.body.match.status).toBe('CANCELLED');
    const prisma = await prismaClient();
    const p = await prisma.matchParticipant.findFirstOrThrow({ where: { matchId, userId: A.members[1]!.userId } });
    expect(p.status).toBe('MATCH_CANCELLED');
  });
});
