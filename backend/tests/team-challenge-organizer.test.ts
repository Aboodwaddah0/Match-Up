import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { inHours, makeUser, type TestUser } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;

const T = '/api/v1/teams';
const M = '/api/v1/matches';
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
});

interface Team {
  teamId: string;
  captain: TestUser;
  vice: TestUser;
  members: TestUser[]; // captain, vice, then plain members
}

/** A team of six: captain, one vice captain and four plain members (so it still has five after one person leaves). */
async function team(prefix: string): Promise<Team> {
  const captain = await makeUser(api, `${prefix}0@example.com`);
  const teamId = (await api.call('POST', T, { name: `Team ${prefix}` }, captain.token)).body.team.id as string;
  const members = [captain];
  for (let i = 1; i < 6; i++) {
    const u = await makeUser(api, `${prefix}${i}@example.com`);
    const inv = await api.call('POST', `${T}/${teamId}/invitations`, { userId: u.userId }, captain.token);
    expect((await api.call('POST', `${T}/invitations/${inv.body.invitation.id}/accept`, {}, u.token)).status).toBe(200);
    members.push(u);
  }
  expect((await api.call('PATCH', `${T}/${teamId}/members/${members[1]!.userId}`, { role: 'VICE_CAPTAIN' }, captain.token)).status).toBe(200);
  return { teamId, captain, vice: members[1]!, members };
}

const challenge = (from: Team, by: TestUser, to: Team) =>
  api.call('POST', `${T}/${from.teamId}/challenges`, { challengedTeamId: to.teamId, format: 'F5', proposedStartAt: inHours(72) }, by.token);
const accept = (id: string, by: TestUser) => api.call('POST', `/api/v1/challenges/${id}/accept`, {}, by.token);
const transferCaptaincy = (t: Team, from: TestUser, to: TestUser) => api.call('POST', `${T}/${t.teamId}/transfer-captaincy`, { userId: to.userId }, from.token);
const challengeRow = async (id: string) => (await prismaP()).teamChallenge.findUniqueOrThrow({ where: { id } });
const matchCount = async () => (await prismaP()).match.count();
const setUserStatus = async (u: TestUser, status: 'ACTIVE' | 'SUSPENDED' | 'DELETED') => void (await (await prismaP()).user.update({ where: { id: u.userId }, data: { status } }));

describe('who may create a challenge (D19, BIZ-02)', () => {
  it('only the CAPTAIN of the challenging team: a vice captain, a plain member and an outsider are refused; the captain is recorded as the organizer', async () => {
    const A = await team('a');
    const B = await team('b');
    const stranger = await makeUser(api, 'stranger@example.com');

    for (const who of [A.vice, A.members[3]!, stranger]) {
      const res = await challenge(A, who, B);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    expect((await challenge({ ...A, teamId: '00000000-0000-4000-8000-000000000000' }, A.captain, B)).status).toBe(404);
    expect(await (await prismaP()).teamChallenge.count()).toBe(0);

    const ok = await challenge(A, A.captain, B);
    expect(ok.status).toBe(201);
    expect((await challengeRow(ok.body.challenge.id)).organizerId).toBe(A.captain.userId);
    expect(JSON.stringify(ok.body)).not.toContain(A.captain.email); // no personal data leaks through the response
  });
});

describe('the organizer is the captain at creation, whatever happens to the captaincy later (D19)', () => {
  it('a captaincy change after creation does not change the organizer; the organizer alone controls the match, the new captain and the opposing captain do not', async () => {
    const A = await team('a');
    const B = await team('b');
    const c = await challenge(A, A.captain, B);
    expect((await transferCaptaincy(A, A.captain, A.vice)).status).toBe(200); // A1 is the captain now

    const accepted = await accept(c.body.challenge.id, B.captain);
    expect(accepted.status).toBe(200);
    const matchId = accepted.body.match.id as string;
    expect((await (await prismaP()).match.findUniqueOrThrow({ where: { id: matchId } })).organizerId).toBe(A.captain.userId); // the creator, not A1

    // the current captain of A (not the organizer) and the opposing captain cannot run the match
    for (const who of [A.vice, B.captain, B.vice]) {
      expect((await api.call('POST', `${M}/${matchId}/cancel`, {}, who.token)).status).toBe(403);
      expect((await api.call('POST', `${M}/${matchId}/complete`, undefined, who.token)).status).toBe(403);
      expect((await api.call('PATCH', `${M}/${matchId}`, { title: 'Hijacked title' }, who.token)).status).toBe(403);
    }
    // each team's captain / vice captain still manages only their own roster
    expect((await api.call('POST', `${T}/${A.teamId}/matches/${matchId}/roster`, { userId: A.members[3]!.userId }, A.vice.token)).status).toBe(201);
    expect((await api.call('POST', `${T}/${A.teamId}/matches/${matchId}/roster`, { userId: A.members[2]!.userId }, B.captain.token)).status).toBe(403);
    expect((await api.call('POST', `${T}/${B.teamId}/matches/${matchId}/roster`, { userId: B.members[3]!.userId }, A.vice.token)).status).toBe(403);
    expect((await api.call('POST', `${T}/${B.teamId}/matches/${matchId}/roster`, { userId: B.members[3]!.userId }, B.vice.token)).status).toBe(201);

    // the organizer (now a plain team member, no longer the captain) can cancel
    expect((await api.call('POST', `${M}/${matchId}/cancel`, {}, A.captain.token)).status).toBe(200);
  });
});

describe('the creator is no longer eligible at acceptance (B1): 409 CHALLENGE_ORGANIZER_UNAVAILABLE, nobody is assigned instead', () => {
  /** Challenge by A's captain, who then hands the captaincy to the vice captain. Returns the pending challenge. */
  async function pendingChallenge() {
    const A = await team('a');
    const B = await team('b');
    const c = await challenge(A, A.captain, B);
    expect((await transferCaptaincy(A, A.captain, A.vice)).status).toBe(200);
    return { A, B, id: c.body.challenge.id as string };
  }
  const expectRefused = async (id: string, by: TestUser) => {
    const prisma = await prismaP();
    const matchesBefore = await matchCount();
    const res = await accept(id, by);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHALLENGE_ORGANIZER_UNAVAILABLE');
    expect((await challengeRow(id)).status).toBe('PENDING'); // untouched: the claim was rolled back
    expect((await challengeRow(id)).resultingMatchId).toBeNull();
    expect(await matchCount()).toBe(matchesBefore); // and no match, so nobody (not even the current captain) was made organizer
    expect(await prisma.notification.count({ where: { type: 'CHALLENGE_ACCEPTED' } })).toBe(0);
  };

  it('the creator left the team', async () => {
    const { A, B, id } = await pendingChallenge();
    expect((await api.call('POST', `${T}/${A.teamId}/leave`, {}, A.captain.token)).status).toBeLessThan(300);
    await expectRefused(id, B.captain);
  });

  it('the creator was removed from the team', async () => {
    const { A, B, id } = await pendingChallenge();
    expect((await api.call('DELETE', `${T}/${A.teamId}/members/${A.captain.userId}`, undefined, A.vice.token)).status).toBeLessThan(300);
    await expectRefused(id, B.captain);
  });

  it('the creator is suspended; once reactivated the same challenge can be accepted and they are the organizer', async () => {
    const { A, B, id } = await pendingChallenge();
    await setUserStatus(A.captain, 'SUSPENDED');
    await expectRefused(id, B.captain);
    await setUserStatus(A.captain, 'ACTIVE');
    const ok = await accept(id, B.captain);
    expect(ok.status).toBe(200);
    expect((await (await prismaP()).match.findUniqueOrThrow({ where: { id: ok.body.match.id } })).organizerId).toBe(A.captain.userId);
  });

  it('the creator account is deleted', async () => {
    const { B, id } = await pendingChallenge();
    await setUserStatus(A_captainOf(await (await prismaP()).teamChallenge.findUniqueOrThrow({ where: { id } })), 'DELETED');
    await expectRefused(id, B.captain);
  });

  it('after a refusal the challenging team sends a NEW challenge (by its current captain), which is accepted with that captain as organizer', async () => {
    const { A, B, id } = await pendingChallenge();
    await api.call('POST', `${T}/${A.teamId}/leave`, {}, A.captain.token);
    await expectRefused(id, B.captain);
    expect((await api.call('POST', `/api/v1/challenges/${id}/cancel`, {}, A.vice.token)).status).toBe(200); // withdraw the stale one
    const fresh = await challenge(A, A.vice, B); // A1 is the captain now
    expect(fresh.status).toBe(201);
    const ok = await accept(fresh.body.challenge.id, B.captain);
    expect(ok.status).toBe(200);
    expect((await (await prismaP()).match.findUniqueOrThrow({ where: { id: ok.body.match.id } })).organizerId).toBe(A.vice.userId);
  });

  it('a creator who is still an active member but no longer captain is NOT refused (captaincy changes do not matter)', async () => {
    const { A, B, id } = await pendingChallenge();
    const row = await challengeRow(id);
    expect(row.organizerId).toBe(A.captain.userId);
    expect((await accept(id, B.captain)).status).toBe(200);
  });
});

describe('challenges created before the organizer was recorded', () => {
  it('keep the old rule (the captain at acceptance) so nothing already pending breaks', async () => {
    const A = await team('a');
    const B = await team('b');
    const c = await challenge(A, A.captain, B);
    await (await prismaP()).teamChallenge.update({ where: { id: c.body.challenge.id }, data: { organizerId: null } }); // a pre-migration row
    expect((await transferCaptaincy(A, A.captain, A.vice)).status).toBe(200);
    const ok = await accept(c.body.challenge.id, B.captain);
    expect(ok.status).toBe(200);
    expect((await (await prismaP()).match.findUniqueOrThrow({ where: { id: ok.body.match.id } })).organizerId).toBe(A.vice.userId);
  });
});

describe('simultaneous acceptance still produces one match', () => {
  it('three simultaneous accepts: one wins, one match, the creator is the organizer', async () => {
    const A = await team('a');
    const B = await team('b');
    const c = await challenge(A, A.captain, B);
    const results = await Promise.all([accept(c.body.challenge.id, B.captain), accept(c.body.challenge.id, B.vice), accept(c.body.challenge.id, B.captain)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await matchCount()).toBe(1);
    expect((await (await prismaP()).match.findFirstOrThrow()).organizerId).toBe(A.captain.userId);
  });
});

/** The recorded organizer of a challenge row (used to find the creator without keeping the Team object around). */
function A_captainOf(row: { organizerId: string | null }): TestUser {
  return { userId: row.organizerId! } as TestUser;
}
