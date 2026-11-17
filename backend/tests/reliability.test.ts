import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { inHours, makeUser, matchBody, moveMatchTime, type TestUser } from './helpers/users';

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

/** D16: a match that ended CANCELLED or CLOSED_UNCONFIRMED ("unknown") must not change anyone's reliability. */
describe('reliability follows the final outcome of the match (D16)', () => {
  const profile = async (viewer: TestUser, of: TestUser) => (await api.call('GET', `/api/v1/players/${of.userId}`, undefined, viewer.token)).body.profile;

  async function joined(org: TestUser, players: TestUser[], over: Record<string, unknown> = {}) {
    const m = (await api.call('POST', '/api/v1/matches', matchBody(over), org.token)).body.match;
    for (const p of players) {
      const r = await api.call('POST', `/api/v1/matches/${m.id}/requests`, {}, p.token);
      await api.call('POST', `/api/v1/matches/${m.id}/requests/${r.body.request.id}/accept`, {}, org.token);
    }
    return m.id as string;
  }

  it('a no-show on a match that closes unconfirmed is not counted; it counts again once the organizer completes the match', async () => {
    const org = await makeUser(api, 'org@example.com');
    const good = await makeUser(api, 'good@example.com');
    const absent = await makeUser(api, 'absent@example.com');
    const matchId = await joined(org, [good, absent]);

    await moveMatchTime(matchId, -2, -0.5);
    const { startDueMatches, closeUnconfirmedMatches } = await import('../src/jobs/match-lifecycle');
    await startDueMatches();
    expect((await api.call('PATCH', `/api/v1/matches/${matchId}/participants/${absent.userId}/attendance`, { status: 'NO_SHOW' }, org.token)).status).toBe(200);

    // the organizer never confirms; 48h after the end the system closes it as "unknown"
    await moveMatchTime(matchId, -60, -50);
    await closeUnconfirmedMatches();
    expect((await api.call('GET', `/api/v1/matches/${matchId}`, undefined, org.token)).body.match.status).toBe('CLOSED_UNCONFIRMED');

    const whileClosed = await profile(org, absent);
    expect(whileClosed.stats).toMatchObject({ noShows: 0, matchesPlayed: 0 });
    expect(whileClosed.reliabilityScore).toBeNull(); // no history yet: nothing to judge

    // recovery within 7 days: the organizer confirms it took place -> the no-show is now real
    expect((await api.call('POST', `/api/v1/matches/${matchId}/complete`, {}, org.token)).status).toBe(200);
    const afterComplete = await profile(org, absent);
    expect(afterComplete.stats).toMatchObject({ noShows: 1, matchesPlayed: 0 });
    expect(afterComplete.reliabilityScore).toBe(0);
    expect((await profile(org, good)).reliabilityScore).toBe(100);
  });

  it('a late cancellation does not count when the match is then cancelled by the organizer', async () => {
    const org = await makeUser(api, 'org@example.com');
    const player = await makeUser(api, 'p@example.com');
    const matchId = await joined(org, [player], { startAt: inHours(6) });

    const left = await api.call('POST', `/api/v1/matches/${matchId}/leave`, {}, player.token);
    expect(left.body).toEqual({ left: true, lateCancellation: true });
    expect((await profile(org, player)).stats.lateCancellations).toBe(1); // counted straight away while the match is alive

    expect((await api.call('POST', `/api/v1/matches/${matchId}/cancel`, { reason: 'pitch unavailable' }, org.token)).status).toBe(200);
    const after = await profile(org, player);
    expect(after.stats.lateCancellations).toBe(0); // the match never happened: no penalty
    expect(after.reliabilityScore).toBeNull();
  });

  it('a no-show on a match an admin cancels while it is running is not counted, in the profile or in admin reporting', async () => {
    const org = await makeUser(api, 'org@example.com');
    const player = await makeUser(api, 'p@example.com');
    const admin = await makeUser(api, 'admin@example.com');
    const { prisma } = await import('../src/lib/prisma');
    await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
    const matchId = await joined(org, [player]);

    await moveMatchTime(matchId, -2, -0.5);
    const { startDueMatches } = await import('../src/jobs/match-lifecycle');
    await startDueMatches();
    await api.call('PATCH', `/api/v1/matches/${matchId}/participants/${player.userId}/attendance`, { status: 'NO_SHOW' }, org.token);
    expect((await profile(org, player)).stats.noShows).toBe(1); // counted while the match is alive and unresolved

    // only an admin can cancel a match that is already running
    expect((await api.call('POST', `/api/v1/matches/${matchId}/cancel`, { reason: 'pitch flooded' }, admin.token)).status).toBe(200);
    expect((await profile(org, player)).stats.noShows).toBe(0);
    expect((await api.call('GET', `/api/v1/admin/users/${player.userId}`, undefined, admin.token)).body.stats.noShows).toBe(0);
    expect((await profile(org, player)).reliabilityScore).toBeNull();
  });

  it('admin reporting follows the same rule through the whole closed -> recovered cycle', async () => {
    const org = await makeUser(api, 'org@example.com');
    const absent = await makeUser(api, 'absent@example.com');
    const admin = await makeUser(api, 'admin@example.com');
    const { prisma } = await import('../src/lib/prisma');
    await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
    const matchId = await joined(org, [absent]);

    await moveMatchTime(matchId, -2, -0.5);
    const { startDueMatches, closeUnconfirmedMatches } = await import('../src/jobs/match-lifecycle');
    await startDueMatches();
    await api.call('PATCH', `/api/v1/matches/${matchId}/participants/${absent.userId}/attendance`, { status: 'NO_SHOW' }, org.token);
    await moveMatchTime(matchId, -60, -50);
    await closeUnconfirmedMatches();

    const adminNoShows = async () => (await api.call('GET', `/api/v1/admin/users/${absent.userId}`, undefined, admin.token)).body.stats.noShows;
    expect(await adminNoShows()).toBe(0); // CLOSED_UNCONFIRMED: unknown, so no effect
    await api.call('POST', `/api/v1/matches/${matchId}/complete`, {}, org.token);
    expect(await adminNoShows()).toBe(1); // recovered and confirmed: now it counts, and matches the player's own profile
    expect((await profile(org, absent)).stats.noShows).toBe(1);
  });

  it('the admin view shows the same numbers as the player profile', async () => {
    const org = await makeUser(api, 'org@example.com');
    const player = await makeUser(api, 'p@example.com');
    const admin = await makeUser(api, 'admin@example.com');
    const { prisma } = await import('../src/lib/prisma');
    await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
    const matchId = await joined(org, [player]);

    await moveMatchTime(matchId, -2, -0.5);
    const { startDueMatches } = await import('../src/jobs/match-lifecycle');
    await startDueMatches();
    await api.call('PATCH', `/api/v1/matches/${matchId}/participants/${player.userId}/attendance`, { status: 'NO_SHOW' }, org.token);
    await api.call('POST', `/api/v1/matches/${matchId}/complete`, {}, org.token);

    const one = await api.call('GET', `/api/v1/admin/users/${player.userId}`, undefined, admin.token);
    expect(one.body.stats).toMatchObject({ noShows: 1, matchesPlayed: 0 });
    expect((await profile(org, player)).stats.noShows).toBe(1);
  });
});
