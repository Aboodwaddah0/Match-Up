import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, matchBody } from './helpers/users';

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

describe('blocking', () => {
  it('block / list / unblock; idempotent; hides profiles and matches both ways; cannot block self', async () => {
    const a = await makeUser(api, 'a@example.com');
    const b = await makeUser(api, 'b@example.com');
    const m = (await api.call('POST', '/api/v1/matches', matchBody(), b.token)).body.match;

    expect((await api.call('POST', '/api/v1/users/me/blocks', { userId: a.userId }, a.token)).status).toBe(400);
    expect((await api.call('POST', '/api/v1/users/me/blocks', { userId: b.userId }, a.token)).status).toBe(204);
    expect((await api.call('POST', '/api/v1/users/me/blocks', { userId: b.userId }, a.token)).status).toBe(204);
    expect((await api.call('GET', '/api/v1/users/me/blocks', undefined, a.token)).body.blocks).toHaveLength(1);

    expect((await api.call('GET', `/api/v1/matches/${m.id}`, undefined, a.token)).status).toBe(404);
    expect((await api.call('GET', `/api/v1/players/${b.userId}`, undefined, a.token)).status).toBe(404);
    expect((await api.call('GET', `/api/v1/players/${a.userId}`, undefined, b.token)).status).toBe(404); // symmetric in effect
    expect((await api.call('POST', `/api/v1/matches/${m.id}/requests`, {}, a.token)).status).toBe(404);

    expect((await api.call('DELETE', `/api/v1/users/me/blocks/${b.userId}`, undefined, a.token)).status).toBe(204);
    expect((await api.call('GET', `/api/v1/matches/${m.id}`, undefined, a.token)).status).toBe(200);
    expect((await api.call('GET', '/api/v1/users/me/blocks', undefined, a.token)).body.blocks).toHaveLength(0);
  });

  it('blocking drops pending join requests between the two', async () => {
    const org = await makeUser(api, 'org@example.com');
    const p = await makeUser(api, 'p@example.com');
    const m = (await api.call('POST', '/api/v1/matches', matchBody(), org.token)).body.match;
    await api.call('POST', `/api/v1/matches/${m.id}/requests`, {}, p.token);
    await api.call('POST', '/api/v1/users/me/blocks', { userId: p.userId }, org.token);
    const { prisma } = await import('../src/lib/prisma');
    expect((await prisma.matchRequest.findFirstOrThrow({ where: { matchId: m.id } })).status).toBe('REJECTED');
  });
});

describe('reports', () => {
  const report = (u: { token: string }, over: Record<string, unknown> = {}) =>
    api.call('POST', '/api/v1/reports', { reason: 'HARASSMENT', ...over }, u.token);

  it('creates a report once per open target, validates target and reason, lists mine', async () => {
    const a = await makeUser(api, 'a@example.com');
    const b = await makeUser(api, 'b@example.com');
    const m = (await api.call('POST', '/api/v1/matches', matchBody(), b.token)).body.match;

    expect((await report(a, { targetType: 'USER', targetId: a.userId })).status).toBe(400);
    expect((await report(a, { targetType: 'USER', targetId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await report(a, { targetType: 'USER', targetId: b.userId, reason: 'NOPE' })).status).toBe(400);
    expect((await report(a, { targetType: 'MESSAGE', targetId: b.userId })).status).toBe(404); // not a message you can see

    expect((await report(a, { targetType: 'USER', targetId: b.userId, details: 'Insulted me' })).status).toBe(201);
    const dup = await report(a, { targetType: 'USER', targetId: b.userId });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ALREADY_REPORTED');
    expect((await report(a, { targetType: 'MATCH', targetId: m.id, reason: 'SPAM' })).status).toBe(201);
    expect((await api.call('GET', '/api/v1/reports/mine', undefined, a.token)).body.reports).toHaveLength(2);
  });

  it('only admins see the queue; status moves OPEN -> IN_REVIEW -> RESOLVED and the reporter is told', async () => {
    const a = await makeUser(api, 'a@example.com');
    const b = await makeUser(api, 'b@example.com');
    const admin = await makeUser(api, 'admin@example.com');
    const { prisma } = await import('../src/lib/prisma');
    await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });

    const id = (await report(a, { targetType: 'USER', targetId: b.userId })).body.report.id as string;
    expect((await api.call('GET', '/api/v1/admin/reports', undefined, a.token)).status).toBe(403);
    expect((await api.call('GET', '/api/v1/admin/reports?status=OPEN', undefined, admin.token)).body.total).toBe(1);

    expect((await api.call('PATCH', `/api/v1/admin/reports/${id}`, { status: 'IN_REVIEW' }, admin.token)).body.report.status).toBe('IN_REVIEW');
    const done = await api.call('PATCH', `/api/v1/admin/reports/${id}`, { status: 'RESOLVED' }, admin.token);
    expect(done.body.report).toMatchObject({ status: 'RESOLVED', resolvedById: admin.userId });
    expect((await api.call('PATCH', `/api/v1/admin/reports/${id}`, { status: 'DISMISSED' }, admin.token)).status).toBe(409);
    expect(await prisma.notification.count({ where: { userId: a.userId, type: 'REPORT_RESOLVED' } })).toBe(1);
    // closed reports no longer block a new one
    expect((await report(a, { targetType: 'USER', targetId: b.userId })).status).toBe(201);
  });
});
