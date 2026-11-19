import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { acceptChallenge, challenge, makeTeam, T, transferCaptaincy, type Team } from './helpers/teams';
import { inHours, makeUser, matchBody, moveMatchTime, type TestUser } from './helpers/users';

/*
 * D19: in a TEAM_CHALLENGE each team's captain and vice captain manage ONLY their own side's roster (team roster endpoint). The generic
 * `DELETE /matches/:id/participants/:userId` is the organizer's tool for OPEN matches: for a team match it is refused (409 USE_TEAM_ROSTER),
 * except for an audited admin override. Every refusal must leave the roster, the notifications and the audit log exactly as they were.
 */

let api: Awaited<ReturnType<typeof startApp>>;
let A: Team; // the challenging team: its captain is the match organizer
let B: Team;
let admin: TestUser;
let matchId: string;

const M = '/api/v1/matches';
const prismaP = async () => (await import('../src/lib/prisma')).prisma;
const roster = (team: Team) => `${T}/${team.teamId}/matches/${matchId}/roster`;
const rosterAdd = (team: Team, by: TestUser, user: TestUser) => api.call('POST', roster(team), { userId: user.userId }, by.token);
const rosterRemove = (team: Team, by: TestUser, user: TestUser) => api.call('DELETE', `${roster(team)}/${user.userId}`, undefined, by.token);
const genericRemove = (by: TestUser, user: TestUser, id = matchId) => api.call('DELETE', `${M}/${id}/participants/${user.userId}`, undefined, by.token);

/** Everything a refused removal must not change: who is on which roster, the removal notifications and the audit log. */
async function state() {
  const prisma = await prismaP();
  return {
    participants: (await prisma.matchParticipant.findMany({ where: { matchId }, orderBy: { userId: 'asc' }, select: { userId: true, status: true, matchTeamId: true } })),
    removalNotifications: await prisma.notification.count({ where: { type: { in: ['MATCH_REMOVED', 'TEAM_ROSTER_REMOVED'] } } }),
    audits: await prisma.adminAuditLog.count(),
  };
}
const statusOf = async (user: TestUser) => (await (await prismaP()).matchParticipant.findFirstOrThrow({ where: { matchId, userId: user.userId } })).status;

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
  A = await makeTeam(api, 'a');
  B = await makeTeam(api, 'b');
  admin = await makeUser(api, 'admin@example.com');
  await (await prismaP()).user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
  const c = await challenge(api, A, A.captain, B);
  matchId = (await acceptChallenge(api, c.body.challenge.id, B.captain)).body.match.id as string;
  for (const u of [A.members[2]!, A.members[3]!]) expect((await rosterAdd(A, A.captain, u)).status).toBe(201);
  for (const u of [B.members[2]!, B.members[3]!]) expect((await rosterAdd(B, B.captain, u)).status).toBe(201);
}, 30_000); // two teams of six, a challenge and four roster picks: slower than the default hook limit when the machine is busy

describe('removing a player from a team match roster (D19)', () => {
  it("each team's captain and vice captain remove players from their OWN roster, through the team roster endpoint", async () => {
    expect((await rosterRemove(A, A.captain, A.members[2]!)).status).toBe(200);
    expect((await rosterRemove(B, B.captain, B.members[2]!)).status).toBe(200);
    expect((await rosterRemove(A, A.vice, A.members[3]!)).status).toBe(200);
    expect((await rosterRemove(B, B.vice, B.members[3]!)).status).toBe(200);
    for (const u of [A.members[2]!, A.members[3]!, B.members[2]!, B.members[3]!]) expect(await statusOf(u)).toBe('REMOVED');
    const prisma = await prismaP();
    expect(await prisma.notification.count({ where: { type: 'TEAM_ROSTER_REMOVED', userId: A.members[2]!.userId } })).toBe(1);
  });

  it('the challenging captain, who is the ORGANIZER, cannot remove a player of the OPPOSING roster by any route; nothing changes', async () => {
    const before = await state();
    const target = B.members[2]!;
    expect((await rosterRemove(B, A.captain, target)).status).toBe(403); // not staff of team B
    const viaOwnTeam = await rosterRemove(A, A.captain, target); // staff of A, but the player is on B's side
    expect(viaOwnTeam.status).toBe(404);
    expect(viaOwnTeam.body.error.code).toBe('NOT_A_PARTICIPANT');
    const generic = await genericRemove(A.captain, target); // the organizer's generic endpoint: refused for a team match
    expect(generic.status).toBe(409);
    expect(generic.body.error.code).toBe('USE_TEAM_ROSTER');
    expect(await statusOf(target)).toBe('CONFIRMED');
    expect(await state()).toEqual(before);
  });

  it('the organizer cannot use the generic endpoint even for a player of their OWN team (the captain uses the roster endpoint); nothing changes', async () => {
    const before = await state();
    const res = await genericRemove(A.captain, A.members[2]!);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('USE_TEAM_ROSTER');
    expect(await state()).toEqual(before);
    expect((await rosterRemove(A, A.captain, A.members[2]!)).status).toBe(200); // the allowed route works
  });

  it("the opposing captain cannot remove the challenging team's players; nothing changes", async () => {
    const before = await state();
    const target = A.members[2]!;
    expect((await rosterRemove(A, B.captain, target)).status).toBe(403); // not staff of team A
    expect((await rosterRemove(B, B.captain, target)).status).toBe(404); // staff of B, player on A's side
    expect((await genericRemove(B.captain, target)).status).toBe(403); // not the organizer
    expect(await state()).toEqual(before);
  });

  it('vice captains: own side yes, the other side no, and the generic endpoint is the organizer\'s only (403)', async () => {
    const before = await state();
    expect((await rosterRemove(A, B.vice, A.members[2]!)).status).toBe(403);
    expect((await rosterRemove(B, B.vice, A.members[2]!)).status).toBe(404);
    expect((await rosterRemove(B, A.vice, B.members[2]!)).status).toBe(403);
    expect((await genericRemove(A.vice, A.members[2]!)).status).toBe(403);
    expect((await genericRemove(B.vice, B.members[2]!)).status).toBe(403);
    expect(await state()).toEqual(before);
    expect((await rosterRemove(A, A.vice, A.members[2]!)).status).toBe(200);
  });

  it('an organizer who is no longer team staff (left the team) has no roster rights on either side, but keeps the organizer powers (cancel)', async () => {
    expect((await transferCaptaincy(api, A, A.captain, A.vice)).status).toBe(200); // the organizer is a vice captain now
    expect((await api.call('POST', `${T}/${A.teamId}/leave`, {}, A.captain.token)).status).toBeLessThan(300); // and now not a member at all
    const before = await state();
    expect((await genericRemove(A.captain, A.members[2]!)).status).toBe(409);
    expect((await genericRemove(A.captain, B.members[2]!)).status).toBe(409);
    expect((await rosterRemove(A, A.captain, A.members[2]!)).status).toBe(403);
    expect(await state()).toEqual(before);
    expect((await api.call('POST', `${M}/${matchId}/cancel`, {}, A.captain.token)).status).toBe(200); // still the organizer
  });

  it('an admin override stays possible on either side and is audited', async () => {
    const before = await state();
    expect((await genericRemove(admin, A.members[2]!)).status).toBe(204);
    expect((await genericRemove(admin, B.members[2]!)).status).toBe(204);
    expect(await statusOf(A.members[2]!)).toBe('REMOVED');
    expect(await statusOf(B.members[2]!)).toBe('REMOVED');
    const after = await state();
    expect(after.audits).toBe(before.audits + 2);
    const records = await (await prismaP()).adminAuditLog.findMany({ where: { action: 'PARTICIPANT_REMOVED_BY_ADMIN', targetId: matchId } });
    expect(records).toHaveLength(2);
  });

  it('after the start nobody can remove a rostered player (the database refuses); the roster is unchanged', async () => {
    await moveMatchTime(matchId, -1, 1);
    const before = await state();
    expect((await rosterRemove(A, A.captain, A.members[2]!)).status).toBe(409);
    expect((await genericRemove(admin, A.members[2]!)).status).toBe(409);
    expect(await state()).toEqual(before);
  });
});

describe('OPEN_MATCH participant removal is unchanged', () => {
  it('the organizer removes a confirmed player (204, REMOVED, MATCH_REMOVED notification); a non-organizer is refused (403) and nothing changes', async () => {
    const prisma = await prismaP();
    const host = await makeUser(api, 'host@example.com');
    const player = await makeUser(api, 'player@example.com');
    const other = await makeUser(api, 'other@example.com');
    const openId = (await api.call('POST', M, matchBody({ title: 'Open game' , startAt: inHours(80) }), host.token)).body.match.id as string;
    const requestId = (await api.call('POST', `${M}/${openId}/requests`, {}, player.token)).body.request.id as string;
    expect((await api.call('POST', `${M}/${openId}/requests/${requestId}/accept`, {}, host.token)).status).toBe(200);

    expect((await genericRemove(other, player, openId)).status).toBe(403);
    expect((await prisma.matchParticipant.findFirstOrThrow({ where: { matchId: openId, userId: player.userId } })).status).toBe('CONFIRMED');
    expect(await prisma.notification.count({ where: { type: 'MATCH_REMOVED' } })).toBe(0);

    expect((await genericRemove(host, player, openId)).status).toBe(204);
    expect((await prisma.matchParticipant.findFirstOrThrow({ where: { matchId: openId, userId: player.userId } })).status).toBe('REMOVED');
    expect(await prisma.notification.count({ where: { type: 'MATCH_REMOVED', userId: player.userId } })).toBe(1);
  });
});
