import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { inHours, makeUser, matchBody, moveMatchTime, type TestUser } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;
let admin: TestUser;
let org: TestUser;
let player: TestUser; // confirmed in the match
let asker: TestUser; // has a pending request
let invitee: TestUser; // invited to a private match
let outsider: TestUser;

const M = '/api/v1/matches';
const T = '/api/v1/teams';
const prismaP = async () => (await import('../src/lib/prisma')).prisma;
const setStatus = async (u: TestUser, status: 'ACTIVE' | 'SUSPENDED') => void (await (await prismaP()).user.update({ where: { id: u.userId }, data: { status } }));
const get = (id: string, by: TestUser) => api.call('GET', `${M}/${id}`, undefined, by.token);
const search = async (by: TestUser) => ((await api.call('GET', `${M}?pageSize=50`, undefined, by.token)).body.matches as { id: string }[]).map((m) => m.id);
const ask = (id: string, by: TestUser) => api.call('POST', `${M}/${id}/requests`, {}, by.token);
const newMatch = async (over: Record<string, unknown> = {}) => (await api.call('POST', M, matchBody(over), org.token)).body.match.id as string;
const notifications = async (userId: string, type: string) => (await prismaP()).notification.count({ where: { userId, type } });

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
  admin = await makeUser(api, 'admin@example.com');
  await (await prismaP()).user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
  org = await makeUser(api, 'org@example.com');
  player = await makeUser(api, 'player@example.com');
  asker = await makeUser(api, 'asker@example.com');
  invitee = await makeUser(api, 'invitee@example.com');
  outsider = await makeUser(api, 'outsider@example.com');
});

/** A public match with one confirmed player and one pending requester, and a private match with an invited player. */
async function scene() {
  const open = await newMatch({ title: 'Open game' });
  const r = (await ask(open, player)).body.request.id as string;
  expect((await api.call('POST', `${M}/${open}/requests/${r}/accept`, {}, org.token)).status).toBe(200);
  expect((await ask(open, asker)).status).toBe(201);
  const priv = await newMatch({ title: 'Private game', visibility: 'PRIVATE', startAt: inHours(100) });
  expect((await api.call('POST', `${M}/${priv}/invitations`, { userId: invitee.userId }, org.token)).status).toBeLessThan(300);
  return { open, priv };
}

describe('a suspended organizer (SEC-01)', () => {
  it('their open match leaves public search and is hidden from outsiders, but stays visible to people related to it and to admins', async () => {
    const { open, priv } = await scene();
    expect(await search(outsider)).toContain(open);

    await setStatus(org, 'SUSPENDED');

    expect(await search(outsider)).not.toContain(open);
    const hidden = await get(open, outsider);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe('MATCH_NOT_FOUND');
    expect((await get(open, player)).status).toBe(200); // confirmed participant
    expect((await get(open, asker)).status).toBe(200); // pending requester
    expect((await get(open, admin)).status).toBe(200);
    expect((await get(priv, invitee)).status).toBe(200); // invited to a private match
    expect((await get(priv, outsider)).status).toBe(404);
    expect(JSON.stringify((await get(open, player)).body)).not.toMatch(/SUSPENDED|accountStatus/); // no account status in the DTO
  });

  it('refuses new requests with 409 ORGANIZER_UNAVAILABLE, even from an invited player, and writes nothing; existing requests are untouched', async () => {
    const { open, priv } = await scene();
    const prisma = await prismaP();
    await setStatus(org, 'SUSPENDED');
    const requestsBefore = await prisma.matchRequest.count();
    const participantsBefore = await prisma.matchParticipant.count();
    const notificationsBefore = await prisma.notification.count();

    const viaInvite = await ask(priv, invitee);
    expect(viaInvite.status).toBe(409);
    expect(viaInvite.body.error.code).toBe('ORGANIZER_UNAVAILABLE');
    const viaPlayerOnPublic = await ask(open, invitee); // not related to the public match: it is simply hidden (404), nothing is written
    expect(viaPlayerOnPublic.status).toBe(404);

    expect(await prisma.matchRequest.count()).toBe(requestsBefore);
    expect(await prisma.matchParticipant.count()).toBe(participantsBefore);
    expect(await prisma.notification.count()).toBe(notificationsBefore);
    expect((await prisma.matchRequest.findFirstOrThrow({ where: { matchId: open, userId: asker.userId } })).status).toBe('PENDING');
  });

  it('nothing is cancelled or expired, participants can still leave, and reactivation restores visibility and joining', async () => {
    const { open, priv } = await scene();
    await setStatus(org, 'SUSPENDED');
    expect((await get(open, player)).body.match.status).toBe('OPEN');

    await setStatus(org, 'ACTIVE');
    expect(await search(outsider)).toContain(open);
    expect((await get(open, outsider)).status).toBe(200);
    expect((await ask(priv, invitee)).status).toBe(201);
    expect((await ask(open, outsider)).status).toBe(201);

    await setStatus(org, 'SUSPENDED');
    expect((await api.call('POST', `${M}/${open}/leave`, {}, player.token)).status).toBe(200);
    expect((await api.call('DELETE', `${M}/${open}/requests/me`, undefined, asker.token)).status).toBe(204); // a pending requester can still withdraw
  });

  it('the lifecycle sweeper still starts its due matches', async () => {
    const id = await newMatch({ title: 'Due soon' });
    await moveMatchTime(id, -1, 1);
    await setStatus(org, 'SUSPENDED');
    const { startDueMatches } = await import('../src/jobs/match-lifecycle');
    expect(await startDueMatches()).toBe(1);
    expect((await (await prismaP()).match.findUniqueOrThrow({ where: { id } })).status).toBe('IN_PROGRESS');
  });

  /** A challenge match between team A (its captain is the organizer) and team B, with one B player rostered. */
  async function challengeMatch() {
    const mk = async (prefix: string, size: number) => {
      const captain = await makeUser(api, `${prefix}0@example.com`);
      const teamId = (await api.call('POST', T, { name: `Team ${prefix}` }, captain.token)).body.team.id as string;
      const members = [captain];
      for (let i = 1; i < size; i++) {
        const u = await makeUser(api, `${prefix}${i}@example.com`);
        const inv = await api.call('POST', `${T}/${teamId}/invitations`, { userId: u.userId }, captain.token);
        expect((await api.call('POST', `${T}/invitations/${inv.body.invitation.id}/accept`, {}, u.token)).status).toBe(200);
        members.push(u);
      }
      return { captain, teamId, members };
    };
    const A = await mk('a', 5);
    const B = await mk('b', 5);
    const c = await api.call('POST', `${T}/${A.teamId}/challenges`, { challengedTeamId: B.teamId, format: 'F5', proposedStartAt: inHours(72) }, A.captain.token);
    const accepted = await api.call('POST', `/api/v1/challenges/${c.body.challenge.id}/accept`, {}, B.captain.token);
    const matchId = accepted.body.match.id as string;
    expect((await api.call('POST', `${T}/${B.teamId}/matches/${matchId}/roster`, { userId: B.members[1]!.userId }, B.captain.token)).status).toBe(201);
    return { A, B, matchId };
  }

  it('a TEAM_CHALLENGE of a suspended organizer is hidden from outsiders; rostered players and admins still see it', async () => {
    const { A, B, matchId } = await challengeMatch();
    expect((await get(matchId, outsider)).status).toBe(200); // normal behaviour while the organizer (A's captain) is active
    await setStatus(A.captain, 'SUSPENDED');
    expect((await get(matchId, outsider)).status).toBe(404);
    expect((await get(matchId, B.members[1]!)).status).toBe(200); // rostered
    expect((await get(matchId, admin)).status).toBe(200);
    await setStatus(A.captain, 'ACTIVE');
    expect((await get(matchId, outsider)).status).toBe(200);
  });

  it("the opposing captain (not on the roster) can VIEW the suspended organizer's challenge but cannot manage it; a plain member of that team and an outsider still get 404", async () => {
    const { A, B, matchId } = await challengeMatch();
    await setStatus(A.captain, 'SUSPENDED');
    expect((await get(matchId, B.captain)).status).toBe(200);
    expect((await get(matchId, B.members[3]!)).status).toBe(404); // a plain, unrostered member is not the captain
    expect((await get(matchId, outsider)).status).toBe(404);

    // view only: no organizer powers
    const prisma = await prismaP();
    expect((await api.call('POST', `${M}/${matchId}/cancel`, {}, B.captain.token)).status).toBe(403);
    expect((await api.call('PATCH', `${M}/${matchId}`, { title: 'Hijacked title' }, B.captain.token)).status).toBe(403);
    expect((await api.call('POST', `${M}/${matchId}/complete`, undefined, B.captain.token)).status).toBe(403);
    // and the roster of the OTHER side stays out of reach (their own side is the captain's normal job)
    expect((await api.call('POST', `${T}/${A.teamId}/matches/${matchId}/roster`, { userId: A.members[1]!.userId }, B.captain.token)).status).toBe(403);
    const row = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
    expect(row.status).toBe('SCHEDULED');
    expect(row.title).not.toBe('Hijacked title');
    expect(await prisma.matchParticipant.count({ where: { matchId, userId: A.members[1]!.userId } })).toBe(0);

    // the captain who is replaced loses the access: it follows the CURRENT captain
    await prisma.teamMember.update({ where: { teamId_userId: { teamId: B.teamId, userId: B.captain.userId } }, data: { role: 'MEMBER' } });
    expect((await get(matchId, B.captain)).status).toBe(404);
  });
});

describe('a suspended player (SEC-01)', () => {
  const decide = (matchId: string, requestId: string, by: TestUser) => api.call('POST', `${M}/${matchId}/requests/${requestId}/accept`, {}, by.token);

  it('cannot be accepted by the organizer or an admin: 409 PLAYER_UNAVAILABLE, the request stays PENDING and nothing else is written', async () => {
    const prisma = await prismaP();
    const matchId = await newMatch();
    const requestId = (await ask(matchId, asker)).body.request.id as string;
    await setStatus(asker, 'SUSPENDED');
    const auditBefore = await prisma.adminAuditLog.count();
    const notificationsBefore = await notifications(asker.userId, 'MATCH_REQUEST_ACCEPTED');

    for (const by of [org, admin]) {
      const res = await decide(matchId, requestId, by);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYER_UNAVAILABLE');
    }
    expect((await prisma.matchRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe('PENDING');
    expect(await prisma.matchParticipant.count({ where: { matchId } })).toBe(0);
    expect(await notifications(asker.userId, 'MATCH_REQUEST_ACCEPTED')).toBe(notificationsBefore);
    expect(await prisma.adminAuditLog.count()).toBe(auditBefore);

    await setStatus(asker, 'ACTIVE'); // reactivated: the same request can now be accepted
    expect((await decide(matchId, requestId, org)).status).toBe(200);
  });

  it('keeps an existing confirmed participation when suspended later, and an active player is accepted normally', async () => {
    const prisma = await prismaP();
    const matchId = await newMatch();
    const r1 = (await ask(matchId, player)).body.request.id as string;
    expect((await decide(matchId, r1, org)).status).toBe(200);
    expect(await notifications(player.userId, 'MATCH_REQUEST_ACCEPTED')).toBe(1);

    await setStatus(player, 'SUSPENDED');
    const row = await prisma.matchParticipant.findUniqueOrThrow({ where: { matchId_userId: { matchId, userId: player.userId } } });
    expect(row.status).toBe('CONFIRMED');
    expect((await get(matchId, org)).body.match.confirmedCount).toBe(1);

    const r2 = (await ask(matchId, asker)).body.request.id as string;
    expect((await decide(matchId, r2, org)).status).toBe(200);
  });
});
