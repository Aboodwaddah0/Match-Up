import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, matchBody, moveMatchTime, type TestUser } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  const { prisma } = await import('../src/lib/prisma');
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
});

const scores = { sportsmanshipScore: 5, skillScore: 4, reliabilityScore: 3 };

/**
 * The organizer plus three confirmed players; the match is started and completed (everyone not a NO_SHOW
 * becomes ATTENDED). The organizer is NOT a participant, so only the three players review each other.
 */
async function completedMatch(noShow?: 'p3') {
  const org = await makeUser(api, 'org@example.com');
  const [p1, p2, p3] = [await makeUser(api, 'p1@example.com'), await makeUser(api, 'p2@example.com'), await makeUser(api, 'p3@example.com')] as [TestUser, TestUser, TestUser];
  const m = (await api.call('POST', '/api/v1/matches', matchBody(), org.token)).body.match;
  for (const p of [p1, p2, p3]) {
    const r = await api.call('POST', `/api/v1/matches/${m.id}/requests`, {}, p.token);
    await api.call('POST', `/api/v1/matches/${m.id}/requests/${r.body.request.id}/accept`, {}, org.token);
  }
  await moveMatchTime(m.id, -2, -0.5);
  const { startDueMatches } = await import('../src/jobs/match-lifecycle');
  await startDueMatches();
  if (noShow) await api.call('PATCH', `/api/v1/matches/${m.id}/participants/${p3.userId}/attendance`, { status: 'NO_SHOW' }, org.token);
  expect((await api.call('POST', `/api/v1/matches/${m.id}/complete`, {}, org.token)).status).toBe(200);
  return { org, p1, p2, p3, matchId: m.id as string };
}
const review = (matchId: string, by: TestUser, reviewedId: string, over: Record<string, unknown> = {}) =>
  api.call('POST', `/api/v1/matches/${matchId}/reviews`, { reviewedId, ...scores, ...over }, by.token);

describe('reviews', () => {
  it('attendees review each other once; ratings are cached and visible; pending list shrinks', async () => {
    const { org, p1, p2, p3, matchId } = await completedMatch();
    const pending = await api.call('GET', `/api/v1/matches/${matchId}/reviews/pending`, undefined, p1.token);
    expect(pending.body.open).toBe(true);
    expect(pending.body.players.map((p: { id: string }) => p.id).sort()).toEqual([p2.userId, p3.userId].sort());

    expect((await review(matchId, p1, p2.userId, { comment: 'Great teammate' })).status).toBe(201);
    expect((await review(matchId, p3, p2.userId, { sportsmanshipScore: 3, skillScore: 4, reliabilityScore: 5 })).status).toBe(201);
    const dup = await review(matchId, p1, p2.userId);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ALREADY_REVIEWED');
    expect((await api.call('GET', `/api/v1/matches/${matchId}/reviews/pending`, undefined, p1.token)).body.players).toHaveLength(1);

    const list = await api.call('GET', `/api/v1/players/${p2.userId}/reviews`, undefined, org.token);
    expect(list.body.total).toBe(2);
    expect(list.body.summary).toMatchObject({ count: 2, sportsmanship: 4, skill: 4, reliability: 4 });
    expect(list.body.reviews.some((r: { comment: string | null }) => r.comment === 'Great teammate')).toBe(true);

    const profile = await api.call('GET', `/api/v1/players/${p2.userId}`, undefined, org.token);
    expect(profile.body.profile.rating).toMatchObject({ average: 4, count: 2 });
    // the reviewed player is told, without the scores
    const { prisma } = await import('../src/lib/prisma');
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: p2.userId, type: 'REVIEW_RECEIVED' } });
    expect(JSON.stringify(n.params)).not.toContain('Score');
  });

  it('refuses self-review, outsiders, organizers who did not play, no-shows, unfinished matches and invalid scores', async () => {
    const { org, p1, p2, p3, matchId } = await completedMatch('p3');
    const outsider = await makeUser(api, 'out@example.com');

    expect((await review(matchId, p1, p1.userId)).status).toBe(400);
    const o = await review(matchId, outsider, p1.userId);
    expect(o.status).toBe(403);
    expect(o.body.error.code).toBe('NOT_AN_ATTENDEE');
    expect((await review(matchId, org, p1.userId)).status).toBe(403); // organizer did not play
    const ns = await review(matchId, p1, p3.userId); // p3 was a no-show: did not attend
    expect(ns.status).toBe(400);
    expect(ns.body.error.code).toBe('REVIEWED_NOT_ATTENDEE');
    expect((await review(matchId, p3, p1.userId)).status).toBe(403); // a no-show cannot review either
    expect((await review(matchId, p1, p2.userId, { skillScore: 6 })).status).toBe(400);
    expect((await review(matchId, p1, p2.userId, { comment: 'x'.repeat(501) })).status).toBe(400);
    expect((await api.call('GET', `/api/v1/matches/${matchId}/reviews/pending`, undefined, p3.token)).body).toMatchObject({ open: false, players: [] });

    // a match that has not been completed
    const m2 = (await api.call('POST', '/api/v1/matches', matchBody(), org.token)).body.match;
    const early = await review(m2.id, p1, p2.userId);
    expect([403, 409]).toContain(early.status);
  });

  it('the 7-day window closes; blocked users cannot review each other', async () => {
    const { org, p1, p2, p3, matchId } = await completedMatch();
    const { prisma } = await import('../src/lib/prisma');
    await prisma.blockedUser.create({ data: { blockerId: p1.userId, blockedId: p2.userId } });
    expect((await review(matchId, p1, p2.userId)).status).toBe(403);
    expect((await review(matchId, p2, p1.userId)).status).toBe(403);
    expect((await api.call('GET', `/api/v1/players/${p2.userId}/reviews`, undefined, p1.token)).status).toBe(404);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRawUnsafe(`UPDATE "match" SET completed_at = now() - interval '8 days' WHERE id = '${matchId}'`);
    });
    const late = await review(matchId, p3, p1.userId);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('REVIEW_WINDOW_CLOSED');
    expect((await api.call('GET', `/api/v1/matches/${matchId}/reviews/pending`, undefined, p3.token)).body.open).toBe(false);
    expect(org.userId).toBeTruthy();
  });

  it('reliability is derived from attendance, not from reviews', async () => {
    const { org, p1, p3 } = await completedMatch('p3');
    const rel = async (u: TestUser) => (await api.call('GET', `/api/v1/players/${u.userId}`, undefined, org.token)).body.profile.reliabilityScore;
    expect(await rel(p1)).toBe(100); // 1 attended
    expect(await rel(p3)).toBe(0); // 0 attended, 1 no-show
  });
});
