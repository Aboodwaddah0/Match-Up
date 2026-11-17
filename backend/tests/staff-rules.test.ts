import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, type TestUser } from './helpers/users';
import { setupVenue } from './helpers/venues';

let api: Awaited<ReturnType<typeof startApp>>;
let owner: TestUser;
let venueId: string;

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
  const city = await prisma.city.create({ data: { nameAr: 'الخليل', nameEn: 'Hebron' } });
  owner = await makeUser(api, 'owner@example.com');
  ({ venueId } = await setupVenue(api, owner, city.id));
});

const staffUrl = (userId?: string) => `/api/v1/venues/${venueId}/staff${userId ? `/${userId}` : ''}`;
const addStaff = (by: TestUser, userId: string, permissions?: string[], role = 'STAFF') =>
  api.call('POST', staffUrl(), { userId, role, ...(permissions ? { permissions } : {}) }, by.token);
const ALL = ['MANAGE_BOOKINGS', 'MANAGE_FIELDS', 'MANAGE_AVAILABILITY', 'EDIT_VENUE', 'MANAGE_STAFF', 'VIEW_REPORTS'];

describe('staff management cannot be used to escalate (AUTHZ-01)', () => {
  it('replays the audit attack: a staff member with ONLY MANAGE_STAFF gets nothing more out of it', async () => {
    const staffX = await makeUser(api, 'staffx@example.com');
    const manager = await makeUser(api, 'manager@example.com');
    const buddy = await makeUser(api, 'buddy@example.com');
    expect((await addStaff(owner, staffX.userId, ['MANAGE_STAFF'])).status).toBe(201);
    expect((await addStaff(owner, manager.userId, ['MANAGE_BOOKINGS', 'MANAGE_FIELDS', 'EDIT_VENUE'])).status).toBe(201);

    // 1. grant themselves everything (this used to return 201 and then allow editing the venue)
    const self = await addStaff(staffX, staffX.userId, ALL, 'MANAGER');
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('CANNOT_EDIT_OWN_ACCESS');
    expect((await api.call('PATCH', `/api/v1/venues/${venueId}`, { description: 'taken over' }, staffX.token)).status).toBe(403);

    // 2. the same through an accomplice
    const proxy = await addStaff(staffX, buddy.userId, ['EDIT_VENUE']);
    expect(proxy.status).toBe(403);
    expect(proxy.body.error.code).toBe('CANNOT_GRANT_UNHELD_PERMISSION');

    // 3. hand out the permission to hand out permissions
    const mgmt = await addStaff(staffX, buddy.userId, ['MANAGE_STAFF']);
    expect(mgmt.status).toBe(403);
    expect(mgmt.body.error.code).toBe('ONLY_OWNER_GRANTS_STAFF_MANAGEMENT');

    // 4. strip or remove another manager
    const strip = await addStaff(staffX, manager.userId, []);
    expect(strip.status).toBe(403);
    expect(strip.body.error.code).toBe('CANNOT_MANAGE_SENIOR_STAFF');
    expect((await api.call('DELETE', staffUrl(manager.userId), undefined, staffX.token)).status).toBe(403);

    // nothing changed
    const list = await api.call('GET', staffUrl(), undefined, owner.token);
    const byUser = Object.fromEntries(list.body.staff.map((s: { userId: string; permissions: string[] }) => [s.userId, s.permissions.sort()]));
    expect(byUser[staffX.userId]).toEqual(['MANAGE_STAFF']);
    expect(byUser[manager.userId]).toEqual(['EDIT_VENUE', 'MANAGE_BOOKINGS', 'MANAGE_FIELDS']);
    expect(byUser[buddy.userId]).toBeUndefined();
  });

  it('a staff member cannot touch a peer who also holds MANAGE_STAFF', async () => {
    const a = await makeUser(api, 'a@example.com');
    const b = await makeUser(api, 'b@example.com');
    await addStaff(owner, a.userId, ['MANAGE_STAFF', 'MANAGE_BOOKINGS']);
    await addStaff(owner, b.userId, ['MANAGE_STAFF', 'MANAGE_BOOKINGS']);
    expect((await addStaff(a, b.userId, ['MANAGE_BOOKINGS'])).status).toBe(403);
    expect((await api.call('DELETE', staffUrl(b.userId), undefined, a.token)).status).toBe(403);
  });

  it('legitimate delegation still works: pass on permissions you hold, to people who hold fewer', async () => {
    const lead = await makeUser(api, 'lead@example.com');
    const clerk = await makeUser(api, 'clerk@example.com');
    await addStaff(owner, lead.userId, ['MANAGE_STAFF', 'MANAGE_BOOKINGS', 'MANAGE_AVAILABILITY']);

    const added = await addStaff(lead, clerk.userId, ['MANAGE_BOOKINGS']);
    expect(added.status).toBe(201);
    expect(added.body.staff.permissions).toEqual(['MANAGE_BOOKINGS']);
    // narrowing and removing someone junior is fine
    expect((await addStaff(lead, clerk.userId, ['MANAGE_AVAILABILITY'])).status).toBe(201);
    expect((await api.call('DELETE', staffUrl(clerk.userId), undefined, lead.token)).status).toBe(204);
  });

  it('role defaults count as grants: a role whose defaults exceed your own permissions is refused', async () => {
    const lead = await makeUser(api, 'lead2@example.com');
    const hire = await makeUser(api, 'hire@example.com');
    await addStaff(owner, lead.userId, ['MANAGE_STAFF']); // holds no booking permissions
    const res = await addStaff(lead, hire.userId); // default STAFF = MANAGE_BOOKINGS + MANAGE_AVAILABILITY
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CANNOT_GRANT_UNHELD_PERMISSION');
  });

  it('a staff member can always remove THEMSELVES from the venue', async () => {
    const quitter = await makeUser(api, 'quitter@example.com');
    await addStaff(owner, quitter.userId, ['MANAGE_STAFF', 'MANAGE_BOOKINGS']);
    expect((await api.call('DELETE', staffUrl(quitter.userId), undefined, quitter.token)).status).toBe(204);
  });

  it('the owner is unrestricted: grants MANAGE_STAFF, rewrites and removes anyone', async () => {
    const m = await makeUser(api, 'm@example.com');
    expect((await addStaff(owner, m.userId, ALL, 'MANAGER')).status).toBe(201);
    expect((await addStaff(owner, m.userId, ['VIEW_REPORTS'])).status).toBe(201);
    expect((await api.call('DELETE', staffUrl(m.userId), undefined, owner.token)).status).toBe(204);
  });

  it('an administrator is unrestricted too', async () => {
    const admin = await makeUser(api, 'admin@example.com');
    const { prisma } = await import('../src/lib/prisma');
    await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
    const m = await makeUser(api, 'm2@example.com');
    expect((await addStaff(admin, m.userId, ALL, 'MANAGER')).status).toBe(201);
  });
});
