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

const N = '/api/v1/notifications';

describe('notifications', () => {
  it('lists my notifications, counts unread, marks one / all read; others cannot touch mine', async () => {
    const org = await makeUser(api, 'org@example.com');
    const p1 = await makeUser(api, 'p1@example.com');
    const p2 = await makeUser(api, 'p2@example.com');
    const m = (await api.call('POST', '/api/v1/matches', matchBody(), org.token)).body.match;
    await api.call('POST', `/api/v1/matches/${m.id}/requests`, {}, p1.token);
    await api.call('POST', `/api/v1/matches/${m.id}/requests`, {}, p2.token);

    expect((await api.call('GET', `${N}/unread-count`, undefined, org.token)).body.unreadCount).toBe(2);
    const list = await api.call('GET', N, undefined, org.token);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    expect(list.body.notifications[0]).toMatchObject({ type: 'MATCH_REQUEST_RECEIVED', read: false, resource: { type: 'match', id: m.id } });
    expect((await api.call('GET', N, undefined, p1.token)).body.total).toBe(0);

    const id = list.body.notifications[0].id as string;
    expect((await api.call('POST', `${N}/${id}/read`, {}, p1.token)).status).toBe(404);
    expect((await api.call('POST', `${N}/${id}/read`, {}, org.token)).status).toBe(204);
    expect((await api.call('POST', `${N}/${id}/read`, {}, org.token)).status).toBe(204); // idempotent
    expect((await api.call('GET', `${N}?unread=true`, undefined, org.token)).body.total).toBe(1);

    expect((await api.call('POST', `${N}/read-all`, {}, org.token)).body.updated).toBe(1);
    expect((await api.call('GET', `${N}/unread-count`, undefined, org.token)).body.unreadCount).toBe(0);
  });

  it('registers and removes a device token (moves between users)', async () => {
    const a = await makeUser(api, 'a@example.com');
    const b = await makeUser(api, 'b@example.com');
    const token = 'ExponentPushToken[abcdefghij]';
    expect((await api.call('POST', `${N}/devices`, { token, platform: 'android' }, a.token)).status).toBe(204);
    expect((await api.call('POST', `${N}/devices`, { token, platform: 'android' }, b.token)).status).toBe(204);
    const { prisma } = await import('../src/lib/prisma');
    expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token } })).userId).toBe(b.userId);
    await api.call('DELETE', `${N}/devices/${encodeURIComponent(token)}`, undefined, a.token); // not a's: no effect
    expect(await prisma.deviceToken.count({ where: { token } })).toBe(1);
    await api.call('DELETE', `${N}/devices/${encodeURIComponent(token)}`, undefined, b.token);
    expect(await prisma.deviceToken.count({ where: { token } })).toBe(0);
    expect((await api.call('GET', N)).status).toBe(401);
  });
});
