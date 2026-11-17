import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, PASSWORD, type TestUser } from './helpers/users';
import { setupVenue } from './helpers/venues';

let api: Awaited<ReturnType<typeof startApp>>;
let admin: TestUser;
let user: TestUser;

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
  const { prisma } = await import('../src/lib/prisma');
  admin = await makeUser(api, 'admin@example.com');
  await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
  user = await makeUser(api, 'user@example.com');
});

const A = '/api/v1/admin';

describe('admin', () => {
  it('is closed to normal users and anonymous callers', async () => {
    expect((await api.call('GET', `${A}/stats`, undefined, user.token)).status).toBe(403);
    expect((await api.call('GET', `${A}/users`, undefined, user.token)).status).toBe(403);
    expect((await api.call('GET', `${A}/stats`)).status).toBe(401);
  });

  it('finds users and shows their history counters', async () => {
    const list = await api.call('GET', `${A}/users?q=USER@`, undefined, admin.token);
    expect(list.body.total).toBe(1);
    expect(list.body.users[0]).toMatchObject({ email: 'user@example.com', status: 'ACTIVE' });
    expect(list.body.users[0].passwordHash).toBeUndefined();
    const one = await api.call('GET', `${A}/users/${user.userId}`, undefined, admin.token);
    expect(one.body.stats).toMatchObject({ matchesOrganized: 0, noShows: 0, reportsAgainst: 0 });
  });

  it('suspension is immediate: old token dies, login and refresh are refused; reactivation restores access', async () => {
    const login = await api.call('POST', '/api/v1/auth/login', { email: user.email, password: PASSWORD });
    const refresh = login.body.refreshToken as string;
    expect((await api.call('GET', '/api/v1/users/me', undefined, user.token)).status).toBe(200);

    expect((await api.call('POST', `${A}/users/${admin.userId}/suspend`, {}, admin.token)).status).toBe(400); // not yourself
    expect((await api.call('POST', `${A}/users/${user.userId}/suspend`, { reason: 'abuse' }, admin.token)).status).toBe(204);

    expect((await api.call('GET', '/api/v1/users/me', undefined, user.token)).status).toBe(401);
    const again = await api.call('POST', '/api/v1/auth/login', { email: user.email, password: PASSWORD });
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe('ACCOUNT_DISABLED');
    expect((await api.call('POST', '/api/v1/auth/refresh', { refreshToken: refresh })).status).toBeGreaterThanOrEqual(400);
    expect((await api.call('POST', `${A}/users/${user.userId}/suspend`, {}, admin.token)).status).toBe(204); // idempotent

    expect((await api.call('POST', `${A}/users/${user.userId}/reactivate`, {}, admin.token)).status).toBe(204);
    expect((await api.call('POST', `${A}/users/${user.userId}/reactivate`, {}, admin.token)).status).toBe(409);
    expect((await api.call('POST', '/api/v1/auth/login', { email: user.email, password: PASSWORD })).status).toBe(200);
  });

  it('cannot suspend another administrator', async () => {
    const other = await makeUser(api, 'admin2@example.com');
    const { prisma } = await import('../src/lib/prisma');
    await prisma.user.update({ where: { id: other.userId }, data: { platformRole: 'ADMIN' } });
    expect((await api.call('POST', `${A}/users/${other.userId}/suspend`, {}, admin.token)).status).toBe(403);
  });

  it('a suspended venue disappears from search and refuses bookings; reactivating restores it; the owner is told', async () => {
    const { prisma } = await import('../src/lib/prisma');
    const cityId = (await prisma.city.create({ data: { nameAr: 'الخليل', nameEn: 'Hebron' } })).id;
    const owner = await makeUser(api, 'owner@example.com');
    const { venueId, fieldId } = await setupVenue(api, owner, cityId);
    expect((await api.call('GET', '/api/v1/venues', undefined, user.token)).body.venues).toHaveLength(1);

    expect((await api.call('POST', `${A}/venues/${venueId}/suspend`, { reason: 'fake venue' }, admin.token)).status).toBe(204);
    expect((await api.call('GET', '/api/v1/venues', undefined, user.token)).body.venues).toHaveLength(0);
    const book = await api.call('POST', '/api/v1/bookings', { venueFieldId: fieldId, startAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), durationMinutes: 60 }, user.token);
    expect(book.status).toBe(404);
    expect((await api.call('POST', `${A}/venues/${venueId}/suspend`, {}, admin.token)).status).toBe(409);
    expect(await prisma.notification.count({ where: { userId: owner.userId, type: 'VENUE_SUSPENDED' } })).toBe(1);
    expect((await api.call('GET', `${A}/venues?status=SUSPENDED`, undefined, admin.token)).body.total).toBe(1);

    expect((await api.call('POST', `${A}/venues/${venueId}/reactivate`, {}, admin.token)).status).toBe(204);
    expect((await api.call('GET', '/api/v1/venues', undefined, user.token)).body.venues).toHaveLength(1);
  });

  it('an owner cannot lift an admin suspension, but can still edit other details and toggle INACTIVE while not suspended', async () => {
    const { prisma } = await import('../src/lib/prisma');
    const cityId = (await prisma.city.create({ data: { nameAr: 'نابلس', nameEn: 'Nablus' } })).id;
    const owner = await makeUser(api, 'owner2@example.com');
    const { venueId } = await setupVenue(api, owner, cityId);
    const patch = (body: Record<string, unknown>) => api.call('PATCH', `/api/v1/venues/${venueId}`, body, owner.token);

    // a normal owner toggle works while the venue is not suspended
    expect((await patch({ status: 'INACTIVE' })).status).toBe(200);
    expect((await patch({ status: 'ACTIVE' })).status).toBe(200);

    expect((await api.call('POST', `${A}/venues/${venueId}/suspend`, { reason: 'fake venue' }, admin.token)).status).toBe(204);

    // the bypass that used to work: owner sets ACTIVE on a suspended venue
    for (const status of ['ACTIVE', 'INACTIVE']) {
      const res = await patch({ status });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('VENUE_SUSPENDED');
    }
    expect((await prisma.venue.findUniqueOrThrow({ where: { id: venueId } })).status).toBe('SUSPENDED');
    expect((await api.call('GET', '/api/v1/venues', undefined, user.token)).body.venues).toHaveLength(0); // still hidden

    // other edits are still allowed so the owner can fix what the admin objected to
    const edit = await patch({ description: 'Updated description' });
    expect(edit.status).toBe(200);
    expect((await prisma.venue.findUniqueOrThrow({ where: { id: venueId } })).status).toBe('SUSPENDED');

    // only the admin endpoint lifts it
    expect((await api.call('POST', `${A}/venues/${venueId}/reactivate`, {}, admin.token)).status).toBe(204);
    expect((await patch({ status: 'INACTIVE' })).status).toBe(200);
  });

  it('stats counts things', async () => {
    const s = await api.call('GET', `${A}/stats`, undefined, admin.token);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ users: 2, newUsers24h: 2, openReports: 0 });
  });
});
