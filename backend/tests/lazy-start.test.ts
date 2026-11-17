import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, matchBody, moveMatchTime, type TestUser } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;
let org: TestUser;
let player: TestUser;

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
  org = await makeUser(api, 'org@example.com');
  player = await makeUser(api, 'player@example.com');
});

/** A confirmed player in a match whose start time has passed, with the sweeper NOT run (it is a timer; correctness must not depend on it). */
async function startedButNotSwept() {
  const m = (await api.call('POST', '/api/v1/matches', matchBody(), org.token)).body.match.id as string;
  const r = await api.call('POST', `/api/v1/matches/${m}/requests`, {}, player.token);
  await api.call('POST', `/api/v1/matches/${m}/requests/${r.body.request.id}/accept`, {}, org.token);
  await moveMatchTime(m, -2, -0.5);
  const { prisma } = await import('../src/lib/prisma');
  expect((await prisma.match.findUniqueOrThrow({ where: { id: m } })).status).toBe('OPEN'); // nothing has moved it yet
  return m;
}

describe('a match past its start time is brought up to date on access (BIZ-03)', () => {
  it('shows IN_PROGRESS, records the transition once, and the sweeper then has nothing left to do', async () => {
    const m = await startedButNotSwept();
    const { prisma } = await import('../src/lib/prisma');
    expect((await api.call('GET', `/api/v1/matches/${m}`, undefined, org.token)).body.match.status).toBe('IN_PROGRESS');
    expect((await api.call('GET', `/api/v1/matches/${m}`, undefined, player.token)).body.match.status).toBe('IN_PROGRESS');
    expect(await prisma.matchEvent.count({ where: { matchId: m, toStatus: 'IN_PROGRESS' } })).toBe(1);
    const { startDueMatches } = await import('../src/jobs/match-lifecycle');
    expect(await startDueMatches()).toBe(0);
    expect(await prisma.matchEvent.count({ where: { matchId: m, toStatus: 'IN_PROGRESS' } })).toBe(1);
  });

  it('lets the organizer record a no-show and complete the match without waiting for the sweeper', async () => {
    const m = await startedButNotSwept();
    const noShow = await api.call('PATCH', `/api/v1/matches/${m}/participants/${player.userId}/attendance`, { status: 'NO_SHOW' }, org.token);
    expect(noShow.status).toBe(200);
    expect((await api.call('POST', `/api/v1/matches/${m}/complete`, {}, org.token)).body.match.status).toBe('COMPLETED');
  });

  it('refuses the organizer cancelling a match that has already started, even before the sweeper noticed', async () => {
    const m = await startedButNotSwept();
    const res = await api.call('POST', `/api/v1/matches/${m}/cancel`, {}, org.token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
  });

  it('an admin can still cancel a running match', async () => {
    const m = await startedButNotSwept();
    const admin = await makeUser(api, 'admin@example.com');
    const { prisma } = await import('../src/lib/prisma');
    await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
    expect((await api.call('POST', `/api/v1/matches/${m}/cancel`, { reason: 'pitch flooded' }, admin.token)).status).toBe(200);
  });

  it('a match that has NOT started is left alone', async () => {
    const m = (await api.call('POST', '/api/v1/matches', matchBody(), org.token)).body.match.id as string;
    expect((await api.call('GET', `/api/v1/matches/${m}`, undefined, org.token)).body.match.status).toBe('OPEN');
    const { prisma } = await import('../src/lib/prisma');
    expect(await prisma.matchEvent.count({ where: { matchId: m } })).toBe(0);
  });
});
