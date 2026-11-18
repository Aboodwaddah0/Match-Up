import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, matchBody, type TestUser } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;
let org: TestUser;
let outsider: TestUser;
let admin: TestUser;

const M = '/api/v1/matches';
const prismaP = async () => (await import('../src/lib/prisma')).prisma;
const list = (matchId: string, by: TestUser, query = '') => api.call('GET', `${M}/${matchId}/requests${query}`, undefined, by.token);
const ids = (res: { body: { requests: { id: string }[] } }) => res.body.requests.map((r) => r.id);

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
  org = await makeUser(api, 'org@example.com');
  outsider = await makeUser(api, 'outsider@example.com');
  admin = await makeUser(api, 'admin@example.com');
  await (await prismaP()).user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
});

let batch = 0;
/** A public match with `n` PENDING requests, inserted directly (fast). `createdAt(i)` decides each request's timestamp. */
async function matchWithRequests(n: number, createdAt: (i: number) => Date, over: Record<string, unknown> = {}) {
  const prisma = await prismaP();
  batch++;
  const matchId = (await api.call('POST', M, matchBody({ title: `Popular game ${batch}`, capacity: 10, ...over }), org.token)).body.match.id as string;
  const rows = Array.from({ length: n }, (_, i) => ({ email: `asker-${batch}-${i}@example.com`, passwordHash: 'x', fullName: `Asker ${batch}-${i}` }));
  await prisma.user.createMany({ data: rows });
  const users = await prisma.user.findMany({ where: { email: { in: rows.map((r) => r.email) } }, select: { id: true, email: true } });
  const byEmail = new Map(users.map((u) => [u.email, u.id]));
  await prisma.matchRequest.createMany({ data: rows.map((r, i) => ({ matchId, userId: byEmail.get(r.email)!, createdAt: createdAt(i) })) });
  return { matchId, userIds: rows.map((r) => byEmail.get(r.email)!) };
}

const base = Date.now() - 3_600_000;

describe('listing pending join requests is paged (ML-01)', () => {
  it('25 pending requests: page 1 has 20 and hasMore, page 2 has 5 and no more; nothing duplicated or missing', async () => {
    const { matchId, userIds } = await matchWithRequests(25, (i) => new Date(base + i * 1000));
    const p1 = await list(matchId, org, '?page=1&pageSize=20');
    const p2 = await list(matchId, org, '?page=2&pageSize=20');
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ page: 1, pageSize: 20, hasMore: true });
    expect(p2.body).toMatchObject({ page: 2, pageSize: 20, hasMore: false });
    expect(p1.body.requests).toHaveLength(20);
    expect(p2.body.requests).toHaveLength(5);
    expect(p1.body).not.toHaveProperty('total');

    const all = [...ids(p1), ...ids(p2)];
    expect(new Set(all).size).toBe(25);
    const stored = await (await prismaP()).matchRequest.findMany({ where: { matchId }, select: { id: true } });
    expect(new Set(all)).toEqual(new Set(stored.map((r) => r.id)));
    // oldest first: the players come back in the order they asked
    const players = [...p1.body.requests, ...p2.body.requests].map((r: { player: { userId: string } }) => r.player.userId);
    expect(players).toEqual(userIds);
    expect((await list(matchId, org, '?page=3')).body).toMatchObject({ requests: [], hasMore: false });
  });

  it('requests with the SAME timestamp are ordered by id, consistently across pages and repeated calls', async () => {
    const same = new Date(base);
    const { matchId } = await matchWithRequests(12, () => same);
    const expected = (await (await prismaP()).matchRequest.findMany({ where: { matchId }, select: { id: true } })).map((r) => r.id).sort();
    const pages = [await list(matchId, org, '?pageSize=5&page=1'), await list(matchId, org, '?pageSize=5&page=2'), await list(matchId, org, '?pageSize=5&page=3')];
    expect(pages.map((p) => p.body.hasMore)).toEqual([true, true, false]);
    expect(pages.flatMap(ids)).toEqual(expected);
    expect(ids(await list(matchId, org, '?pageSize=5&page=2'))).toEqual(ids(pages[1]!)); // stable on repeat
  });

  it('rejects pageSize above 50, pageSize below 1 and page below 1 with 400, and accepts the boundaries', async () => {
    const { matchId } = await matchWithRequests(3, (i) => new Date(base + i));
    for (const q of ['?pageSize=51', '?pageSize=0', '?page=0', '?page=-1', '?page=abc', '?pageSize=1.5']) {
      expect((await list(matchId, org, q)).status, q).toBe(400);
    }
    expect((await list(matchId, org, '?pageSize=50')).status).toBe(200);
    expect((await list(matchId, org, '?pageSize=1&page=1')).body).toMatchObject({ hasMore: true });
  });

  it('without parameters it still works with the defaults (page 1, 20 per page)', async () => {
    const { matchId } = await matchWithRequests(23, (i) => new Date(base + i * 1000));
    const res = await list(matchId, org);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 20, hasMore: true });
    expect(res.body.requests).toHaveLength(20);
    expect(res.body.requests[0]).toHaveProperty('player.fullName');
    expect(res.body.requests[0]).toHaveProperty('scheduleConflict');
  });

  it('lists only PENDING requests: accepted, rejected and withdrawn ones are not returned or counted towards hasMore', async () => {
    const prisma = await prismaP();
    const { matchId } = await matchWithRequests(6, (i) => new Date(base + i * 1000));
    const all = await prisma.matchRequest.findMany({ where: { matchId }, orderBy: { createdAt: 'asc' } });
    await prisma.matchRequest.update({ where: { id: all[0]!.id }, data: { status: 'REJECTED' } });
    await prisma.matchRequest.update({ where: { id: all[1]!.id }, data: { status: 'WITHDRAWN' } });
    expect((await api.call('POST', `${M}/${matchId}/requests/${all[2]!.id}/accept`, {}, org.token)).status).toBe(200);

    const res = await list(matchId, org, '?pageSize=3');
    expect(ids(res)).toEqual(all.slice(3).map((r) => r.id));
    expect(res.body.hasMore).toBe(false); // exactly 3 pending left: no phantom next page
  });

  it('the schedule conflict flag is computed per page and is right on every page', async () => {
    const prisma = await prismaP();
    const { matchId, userIds } = await matchWithRequests(25, (i) => new Date(base + i * 1000), { startAt: new Date(Date.now() + 200 * 3_600_000).toISOString() });
    const target = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
    // two askers (one on each page) are already CONFIRMED elsewhere at the same time
    const other = await makeUser(api, 'other-org@example.com');
    const clash = async (userId: string, title: string) => {
      const otherMatch = (await api.call('POST', M, matchBody({ title, capacity: 4, startAt: target.startAt.toISOString() }), other.token)).body.match.id as string;
      await prisma.matchParticipant.create({ data: { matchId: otherMatch, userId } });
    };
    await clash(userIds[3]!, 'Clash on page one');
    await clash(userIds[22]!, 'Clash on page two');

    const flagged = async (q: string) => (await list(matchId, org, q)).body.requests.filter((r: { scheduleConflict: boolean }) => r.scheduleConflict).map((r: { player: { userId: string } }) => r.player.userId);
    expect(await flagged('?page=1&pageSize=20')).toEqual([userIds[3]]);
    expect(await flagged('?page=2&pageSize=20')).toEqual([userIds[22]]);
    expect(await flagged('?page=1&pageSize=50')).toEqual([userIds[3], userIds[22]]);
  });

  it('authorization is unchanged: the organizer and an admin may list; a player, a stranger and a missing match are refused as before', async () => {
    const { matchId } = await matchWithRequests(2, (i) => new Date(base + i));
    const asker = (await (await prismaP()).matchRequest.findFirstOrThrow({ where: { matchId } })).userId;
    expect((await list(matchId, org)).status).toBe(200);
    expect((await list(matchId, admin)).status).toBe(200);
    expect((await list(matchId, outsider)).status).toBe(403);
    expect((await list('00000000-0000-4000-8000-000000000000', org)).status).toBe(404);
    // a confirmed player is not the organizer either
    const player = await makeUser(api, 'player@example.com');
    const r = (await api.call('POST', `${M}/${matchId}/requests`, {}, player.token)).body.request.id as string;
    expect((await api.call('POST', `${M}/${matchId}/requests/${r}/accept`, {}, org.token)).status).toBe(200);
    expect((await list(matchId, player)).status).toBe(403);
    expect(asker).toBeTruthy();
    // validation does not bypass authorization, and unauthorized callers learn nothing about the paging
    const refused = await list(matchId, outsider, '?page=2');
    expect(refused.status).toBe(403);
    expect(refused.body).not.toHaveProperty('requests');
  });
});
