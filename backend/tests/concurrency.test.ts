import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, matchBody } from './helpers/users';

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
