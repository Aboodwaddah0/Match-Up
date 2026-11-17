import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { inHours, makeUser, matchBody } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  api = await startApp();
  await resetDb();
});
afterAll(async () => {
  await api.close();
  const { prisma } = await import('../src/lib/prisma');
  await prisma.$disconnect();
});

/**
 * Two organizers confirm the same player into overlapping matches at the same instant. Each transaction inserts a
 * participant row and then waits on the other's uncommitted row inside the overlap exclusion constraint, so Postgres
 * aborts one of them as a deadlock victim (40P01). That used to surface as a 500 about one run in three; it must
 * always end as exactly one success and one clean SCHEDULE_CONFLICT. Repeated because the interleaving is timing-dependent.
 */
describe('cross-match confirmation race', () => {
  it('always ends with one 200 and one 409 SCHEDULE_CONFLICT, never a 500', async () => {
    const org1 = await makeUser(api, 'o1@example.com');
    const org2 = await makeUser(api, 'o2@example.com');
    for (let i = 0; i < 20; i++) {
      const p = await makeUser(api, `p${i}@example.com`);
      const startAt = new Date(Date.now() + (96 + i * 3) * 3_600_000).toISOString();
      const m1 = (await api.call('POST', '/api/v1/matches', matchBody({ startAt, title: `Match one ${i}` }), org1.token)).body.match.id;
      const m2 = (await api.call('POST', '/api/v1/matches', matchBody({ startAt, title: `Match two ${i}` }), org2.token)).body.match.id;
      const r1 = await api.call('POST', `/api/v1/matches/${m1}/requests`, {}, p.token);
      const r2 = await api.call('POST', `/api/v1/matches/${m2}/requests`, {}, p.token);
      const res = await Promise.all([
        api.call('POST', `/api/v1/matches/${m1}/requests/${r1.body.request.id}/accept`, {}, org1.token),
        api.call('POST', `/api/v1/matches/${m2}/requests/${r2.body.request.id}/accept`, {}, org2.token),
      ]);
      expect(res.map((r) => r.status).sort(), `iteration ${i}`).toEqual([200, 409]);
      expect(res.find((r) => r.status === 409)!.body.error.code).toBe('SCHEDULE_CONFLICT');
    }
  }, 120_000);
});

/**
 * Cancel vs accept used to be a lock-order deadlock (accept locked the request row then the match row; cancel locked the
 * match row then the request rows). Measured before the fix: 15 of 40 cancels lost the deadlock and returned a spurious 409.
 * Every transaction now locks the match row first (lib/locks.ts), so the cancel must ALWAYS succeed.
 */
describe('organizer actions racing with player actions', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const jitter = () => sleep(Math.floor(Math.random() * 40));

  it('cancelling while a request is being accepted always succeeds and leaves nobody confirmed in the cancelled match', async () => {
    const { prisma } = await import('../src/lib/prisma');
    const org = await makeUser(api, 'cancel-org@example.com');
    const players: Awaited<ReturnType<typeof makeUser>>[] = []; // one at a time: 20 simultaneous logins can exhaust the small test pool (P2028)
    for (let i = 0; i < 20; i++) players.push(await makeUser(api, `cancel-p${i}@example.com`));
    for (let i = 0; i < 20; i++) {
      const m = (await api.call('POST', '/api/v1/matches', matchBody({ startAt: inHours(100 + i * 4), title: `Race number ${i}` }), org.token)).body.match.id as string;
      const r = (await api.call('POST', `/api/v1/matches/${m}/requests`, {}, players[i]!.token)).body.request.id as string;
      const [accept, cancel] = await Promise.all([
        (async () => { await jitter(); return api.call('POST', `/api/v1/matches/${m}/requests/${r}/accept`, {}, org.token); })(),
        (async () => { await jitter(); return api.call('POST', `/api/v1/matches/${m}/cancel`, {}, org.token); })(),
      ]);
      expect(cancel.status, `iteration ${i}: cancel`).toBe(200);
      expect([200, 409]).toContain(accept.status);
      if (accept.status === 409) expect(accept.body.error.code).not.toBe('CONCURRENT_CONFLICT');
      expect((await prisma.match.findUniqueOrThrow({ where: { id: m } })).status).toBe('CANCELLED');
      expect(await prisma.matchParticipant.count({ where: { matchId: m, status: 'CONFIRMED' } })).toBe(0);
    }
  }, 120_000);

  it('a player leaving while the organizer cancels never produces a conflict error', async () => {
    const org = await makeUser(api, 'leave-org@example.com');
    const players: Awaited<ReturnType<typeof makeUser>>[] = []; // one at a time: 20 simultaneous logins can exhaust the small test pool (P2028)
    for (let i = 0; i < 15; i++) players.push(await makeUser(api, `leave-p${i}@example.com`));
    for (let i = 0; i < 15; i++) {
      const m = (await api.call('POST', '/api/v1/matches', matchBody({ startAt: inHours(300 + i * 4) }), org.token)).body.match.id as string;
      const r = (await api.call('POST', `/api/v1/matches/${m}/requests`, {}, players[i]!.token)).body.request.id as string;
      await api.call('POST', `/api/v1/matches/${m}/requests/${r}/accept`, {}, org.token);
      const [leave, cancel] = await Promise.all([
        (async () => { await jitter(); return api.call('POST', `/api/v1/matches/${m}/leave`, {}, players[i]!.token); })(),
        (async () => { await jitter(); return api.call('POST', `/api/v1/matches/${m}/cancel`, {}, org.token); })(),
      ]);
      expect(cancel.status, `iteration ${i}: cancel`).toBe(200);
      expect([200, 404]).toContain(leave.status); // 404 = the cancel got there first, so the player was no longer "confirmed"
    }
  }, 120_000);
});
