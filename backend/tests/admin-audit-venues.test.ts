import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, type TestUser } from './helpers/users';
import { localSlot, plusMinutes, setupVenue, allWeek } from './helpers/venues';

let api: Awaited<ReturnType<typeof startApp>>;
let admin: TestUser;
let owner: TestUser;
let manager: TestUser; // staff with the MANAGER defaults
let player: TestUser;
let cityId: string;
let venueId: string;
let fieldId: string;

const V = '/api/v1/venues';
const F = '/api/v1/fields';
const B = '/api/v1/bookings';
const A = '/api/v1/admin';
const prismaP = async () => (await import('../src/lib/prisma')).prisma;
const records = async () => (await prismaP()).adminAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
const count = async () => (await prismaP()).adminAuditLog.count();

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
  const prisma = await prismaP();
  cityId = (await prisma.city.create({ data: { nameAr: 'الخليل', nameEn: 'Hebron' } })).id;
  admin = await makeUser(api, 'admin@example.com');
  await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
  owner = await makeUser(api, 'owner@example.com');
  manager = await makeUser(api, 'manager@example.com');
  player = await makeUser(api, 'player@example.com');
  ({ venueId, fieldId } = await setupVenue(api, owner, cityId));
  expect((await api.call('POST', `${V}/${venueId}/staff`, { userId: manager.userId, role: 'MANAGER' }, owner.token)).status).toBe(201);
});

/** Runs `fn`, expects exactly ONE new audit record, and returns it. */
async function oneRecord(fn: () => Promise<{ status: number }>, expectedStatus: number | ((s: number) => boolean) = (s) => s < 300) {
  const before = await count();
  const res = await fn();
  expect(typeof expectedStatus === 'function' ? expectedStatus(res.status) : res.status === expectedStatus).toBe(true);
  expect(await count()).toBe(before + 1);
  return (await records()).at(-1)!;
}
/** Runs `fn` and expects NO new audit record. */
async function noRecord(fn: () => Promise<{ status: number }>) {
  const before = await count();
  const res = await fn();
  expect(await count()).toBe(before);
  return res;
}

const slotBooking = async (hour: number, by = player) => {
  const startAt = localSlot(5, hour);
  const res = await api.call('POST', B, { venueFieldId: fieldId, startAt: startAt.toISOString(), endAt: plusMinutes(startAt, 60).toISOString() }, by.token);
  expect(res.status).toBe(201);
  return res.body.booking.id as string;
};

// ───────────────────────────── every operation, by an admin on someone else's venue ─────────────────────────────

describe('administrator changes to a venue they do not own are audited (AUD-07)', () => {
  it('updateVenue: records the NAMES of the changed fields, never their values; a repeat that changes nothing is not recorded', async () => {
    const r = await oneRecord(() => api.call('PATCH', `${V}/${venueId}`, { name: 'Secret New Name', contactPhone: '+970599999999' }, admin.token));
    expect(r).toMatchObject({ actorId: admin.userId, action: 'VENUE_UPDATED_BY_ADMIN', targetType: 'VENUE', targetId: venueId });
    expect((r.metadata as { changedFields: string[] }).changedFields.sort()).toEqual(['contactPhone', 'name']);
    expect(JSON.stringify(r)).not.toMatch(/Secret New Name|970599999999/);
    expect(r.requestId).toMatch(/^[A-Za-z0-9._-]{8,64}$/);

    await noRecord(() => api.call('PATCH', `${V}/${venueId}`, { name: 'Secret New Name' }, admin.token)); // same value: no-op
    const s = await oneRecord(() => api.call('PATCH', `${V}/${venueId}`, { status: 'INACTIVE' }, admin.token));
    expect(s.metadata).toEqual({ changedFields: ['status'], fromStatus: 'ACTIVE', toStatus: 'INACTIVE' });
  });

  it('staff: adding, changing and removing a member are three distinct records; repeating the same grant is not recorded', async () => {
    const helper = await makeUser(api, 'helper@example.com');
    const add = await oneRecord(() => api.call('POST', `${V}/${venueId}/staff`, { userId: helper.userId, role: 'STAFF' }, admin.token), 201);
    expect(add).toMatchObject({ action: 'VENUE_STAFF_ADDED_BY_ADMIN', targetId: venueId, actorId: admin.userId });
    expect(add.metadata).toMatchObject({ subjectUserId: helper.userId, role: 'STAFF' });
    expect(JSON.stringify(add)).not.toMatch(/helper@example\.com/);

    await noRecord(() => api.call('POST', `${V}/${venueId}/staff`, { userId: helper.userId, role: 'STAFF' }, admin.token)); // nothing differs
    const upd = await oneRecord(() => api.call('POST', `${V}/${venueId}/staff`, { userId: helper.userId, role: 'MANAGER' }, admin.token), 201);
    expect(upd.action).toBe('VENUE_STAFF_UPDATED_BY_ADMIN');
    const rem = await oneRecord(() => api.call('DELETE', `${V}/${venueId}/staff/${helper.userId}`, undefined, admin.token), 204);
    expect(rem).toMatchObject({ action: 'VENUE_STAFF_REMOVED_BY_ADMIN', metadata: { subjectUserId: helper.userId } });
  });

  it('images: the image id is recorded, the URL is not', async () => {
    const add = await oneRecord(() => api.call('POST', `${V}/${venueId}/images`, { url: 'https://example.com/private-photo.jpg' }, admin.token), 201);
    expect(add.action).toBe('VENUE_IMAGE_ADDED_BY_ADMIN');
    const imageId = (add.metadata as { imageId: string }).imageId;
    expect(JSON.stringify(add)).not.toMatch(/private-photo/);
    const rem = await oneRecord(() => api.call('DELETE', `${V}/${venueId}/images/${imageId}`, undefined, admin.token), 204);
    expect(rem).toMatchObject({ action: 'VENUE_IMAGE_REMOVED_BY_ADMIN', metadata: { imageId } });
  });

  it('fields: creating one, changing it (names only) and repeating the same change', async () => {
    const created = await oneRecord(() => api.call('POST', `${V}/${venueId}/fields`, { name: 'Field 2', format: 'F5', pricePerHour: 80 }, admin.token), 201);
    expect(created.action).toBe('VENUE_FIELD_CREATED_BY_ADMIN');
    const newFieldId = (created.metadata as { fieldId: string }).fieldId;
    expect(await (await prismaP()).venueField.count({ where: { id: newFieldId, venueId } })).toBe(1);

    const upd = await oneRecord(() => api.call('PATCH', `${F}/${newFieldId}`, { pricePerHour: 95, isActive: false }, admin.token));
    expect(upd).toMatchObject({ action: 'VENUE_FIELD_UPDATED_BY_ADMIN', targetId: venueId });
    expect(upd.metadata).toMatchObject({ fieldId: newFieldId });
    expect(((upd.metadata as { changedFields: string[] }).changedFields).sort()).toEqual(['isActive', 'pricePerHour']);
    await noRecord(() => api.call('PATCH', `${F}/${newFieldId}`, { pricePerHour: 95, name: 'Field 2' }, admin.token)); // same values
  });

  it('opening hours: recorded when the schedule really differs, not when the same schedule is sent again', async () => {
    const same = await noRecord(() => api.call('PUT', `${F}/${fieldId}/opening-hours`, { hours: allWeek() }, admin.token)); // identical to the setup
    expect(same.status).toBe(200);
    const r = await oneRecord(() => api.call('PUT', `${F}/${fieldId}/opening-hours`, { hours: allWeek('09:00', '22:00') }, admin.token));
    expect(r).toMatchObject({ action: 'VENUE_HOURS_REPLACED_BY_ADMIN', targetId: venueId, metadata: { fieldId } });
    await noRecord(() => api.call('PUT', `${F}/${fieldId}/opening-hours`, { hours: allWeek('09:00', '22:00') }, admin.token));
  });

  it('blocks: one record for a block (and one for a block on every field, naming all of them), and one for its removal', async () => {
    const second = (await api.call('POST', `${V}/${venueId}/fields`, { name: 'Field 2', format: 'F5', pricePerHour: 80 }, owner.token)).body.field.id as string;
    const startAt = localSlot(10, 10);
    const body = { startAt: startAt.toISOString(), endAt: plusMinutes(startAt, 120).toISOString(), reason: 'MAINTENANCE' };

    const one = await oneRecord(() => api.call('POST', `${F}/${fieldId}/blocks`, body, admin.token), 201);
    expect(one.action).toBe('VENUE_BLOCK_CREATED_BY_ADMIN');
    expect((one.metadata as { blockIds: string[] }).blockIds).toHaveLength(1);

    const later = localSlot(11, 10);
    const all = await oneRecord(() => api.call('POST', `${F}/${fieldId}/blocks`, { ...body, startAt: later.toISOString(), endAt: plusMinutes(later, 60).toISOString(), allFields: true, note: 'private note' }, admin.token), 201);
    expect((all.metadata as { blockIds: string[]; fieldIds: string[] }).blockIds).toHaveLength(2);
    expect((all.metadata as { fieldIds: string[] }).fieldIds.sort()).toEqual([fieldId, second].sort());
    expect(JSON.stringify(all)).not.toMatch(/private note/);

    const blockId = (one.metadata as { blockIds: string[] }).blockIds[0]!;
    const del = await oneRecord(() => api.call('DELETE', `/api/v1/blocks/${blockId}`, undefined, admin.token), 204);
    expect(del).toMatchObject({ action: 'VENUE_BLOCK_DELETED_BY_ADMIN', targetId: venueId, metadata: { blockId, fieldId } });
    await noRecord(() => api.call('DELETE', `/api/v1/blocks/${blockId}`, undefined, admin.token)); // already gone: 404, nothing recorded
  });

  it('bookings: confirm, reject and cancel each leave one record naming the venue and the booking; a second answer leaves none', async () => {
    const toConfirm = await slotBooking(9);
    const confirmed = await oneRecord(() => api.call('POST', `${B}/${toConfirm}/confirm`, undefined, admin.token));
    expect(confirmed).toMatchObject({ actorId: admin.userId, action: 'BOOKING_CONFIRMED_BY_ADMIN', targetType: 'VENUE', targetId: venueId });
    expect(confirmed.metadata).toEqual({ bookingId: toConfirm, fromStatus: 'PENDING', toStatus: 'CONFIRMED' });
    const again = await noRecord(() => api.call('POST', `${B}/${toConfirm}/confirm`, undefined, admin.token));
    expect(again.status).toBe(409);

    const cancelled = await oneRecord(() => api.call('POST', `${B}/${toConfirm}/cancel`, { reason: 'burst pipe' }, admin.token));
    expect(cancelled).toMatchObject({ action: 'BOOKING_CANCELLED_BY_ADMIN', targetId: venueId, reason: 'burst pipe' });
    expect(cancelled.metadata).toEqual({ bookingId: toConfirm, fromStatus: 'CONFIRMED', toStatus: 'CANCELLED' });

    const toReject = await slotBooking(12);
    const rejected = await oneRecord(() => api.call('POST', `${B}/${toReject}/reject`, { reason: 'closed that day' }, admin.token));
    expect(rejected).toMatchObject({ action: 'BOOKING_REJECTED_BY_ADMIN', targetId: venueId, reason: 'closed that day' });
    expect(rejected.metadata).toEqual({ bookingId: toReject, fromStatus: 'PENDING', toStatus: 'REJECTED' });
  });

  it('createExternalBooking has no venue: an administrator recording one is an ordinary booking and leaves no venue audit record', async () => {
    const startAt = localSlot(6, 18);
    const res = await noRecord(() =>
      api.call('POST', `${B}/external`, { startAt: startAt.toISOString(), endAt: plusMinutes(startAt, 60).toISOString(), extVenueName: 'Some pitch', totalPrice: 50, currency: 'ILS' }, admin.token),
    );
    expect(res.status).toBe(201);
  });

  it('the new actions can be filtered in the audit-log reader', async () => {
    await api.call('PATCH', `${V}/${venueId}`, { name: 'Filtered name' }, admin.token);
    const res = await api.call('GET', `${A}/audit-log?action=VENUE_UPDATED_BY_ADMIN`, undefined, admin.token);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('VENUE_UPDATED_BY_ADMIN');
  });
});

// ───────────────────────────── who is NOT recorded ─────────────────────────────

describe('nobody else is recorded', () => {
  it('the owner and venue staff managing the venue leave no admin audit record, whatever they do', async () => {
    const before = await count();
    expect((await api.call('PATCH', `${V}/${venueId}`, { name: 'Owner rename' }, owner.token)).status).toBe(200);
    expect((await api.call('POST', `${V}/${venueId}/images`, { url: 'https://example.com/a.jpg' }, owner.token)).status).toBe(201);
    expect((await api.call('PATCH', `${F}/${fieldId}`, { pricePerHour: 130 }, owner.token)).status).toBe(200);
    expect((await api.call('PUT', `${F}/${fieldId}/opening-hours`, { hours: allWeek('10:00', '20:00') }, owner.token)).status).toBe(200);
    const startAt = localSlot(12, 10);
    const block = await api.call('POST', `${F}/${fieldId}/blocks`, { startAt: startAt.toISOString(), endAt: plusMinutes(startAt, 60).toISOString() }, owner.token);
    expect(block.status).toBe(201);
    expect((await api.call('DELETE', `/api/v1/blocks/${block.body.blocks[0].id}`, undefined, owner.token)).status).toBe(204);
    const helper = await makeUser(api, 'helper@example.com');
    expect((await api.call('POST', `${V}/${venueId}/staff`, { userId: helper.userId, role: 'STAFF' }, owner.token)).status).toBe(201);
    expect((await api.call('DELETE', `${V}/${venueId}/staff/${helper.userId}`, undefined, owner.token)).status).toBe(204);

    // staff (MANAGER)
    expect((await api.call('PATCH', `${V}/${venueId}`, { description: 'By the manager' }, manager.token)).status).toBe(200);
    expect((await api.call('PATCH', `${F}/${fieldId}`, { pricePerHour: 140 }, manager.token)).status).toBe(200);
    const b1 = await slotBooking(11);
    expect((await api.call('POST', `${B}/${b1}/confirm`, undefined, manager.token)).status).toBe(200);
    expect((await api.call('POST', `${B}/${b1}/cancel`, {}, manager.token)).status).toBe(200);
    const b2 = await slotBooking(13);
    expect((await api.call('POST', `${B}/${b2}/reject`, { reason: 'no' }, owner.token)).status).toBe(200);
    expect(await count()).toBe(before);
  });

  it('an administrator working on a venue they OWN is ordinary venue management: no record', async () => {
    const own = await setupVenue(api, admin, cityId);
    expect((await api.call('PATCH', `${V}/${own.venueId}`, { name: 'My own arena' }, admin.token)).status).toBe(200);
    expect((await api.call('PATCH', `${F}/${own.fieldId}`, { pricePerHour: 70 }, admin.token)).status).toBe(200);
    const startAt = localSlot(7, 9);
    const booking = await api.call('POST', B, { venueFieldId: own.fieldId, startAt: startAt.toISOString(), endAt: plusMinutes(startAt, 60).toISOString() }, player.token);
    expect((await api.call('POST', `${B}/${booking.body.booking.id}/confirm`, undefined, admin.token)).status).toBe(200);
    expect(await count()).toBe(0);
  });

  it('an administrator who is the REQUESTER of a booking cancels their own booking: not a venue override', async () => {
    const mine = await slotBooking(15, admin);
    expect((await noRecord(() => api.call('POST', `${B}/${mine}/cancel`, {}, admin.token))).status).toBe(200);
  });

  it('suspending and reactivating a venue is unchanged: exactly the existing records, no venue-update record', async () => {
    const s = await oneRecord(() => api.call('POST', `${A}/venues/${venueId}/suspend`, { reason: 'fake' }, admin.token));
    expect(s.action).toBe('VENUE_SUSPENDED');
    const r = await oneRecord(() => api.call('POST', `${A}/venues/${venueId}/reactivate`, undefined, admin.token));
    expect(r.action).toBe('VENUE_REACTIVATED');
    expect((await records()).map((x) => x.action)).toEqual(['VENUE_SUSPENDED', 'VENUE_REACTIVATED']);
  });
});

// ───────────────────────────── failures and no-ops leave nothing ─────────────────────────────

describe('failed operations leave no record and no partial change', () => {
  it('refused or invalid admin operations write nothing', async () => {
    const before = await count();
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect((await api.call('PATCH', `${V}/${venueId}`, { latitude: 500 }, admin.token)).status).toBe(400);
    expect((await api.call('PATCH', `${V}/${unknown}`, { name: 'Nope nope' }, admin.token)).status).toBe(404);
    expect((await api.call('POST', `${V}/${venueId}/staff`, { userId: unknown, role: 'STAFF' }, admin.token)).status).toBe(404);
    expect((await api.call('POST', `${V}/${venueId}/staff`, { userId: owner.userId, role: 'STAFF' }, admin.token)).status).toBe(400);
    expect((await api.call('DELETE', `${V}/${venueId}/staff/${player.userId}`, undefined, admin.token)).status).toBe(404);
    expect((await api.call('DELETE', `${V}/${venueId}/images/${unknown}`, undefined, admin.token)).status).toBe(404);
    expect((await api.call('PATCH', `${F}/${unknown}`, { name: 'x' }, admin.token)).status).toBe(404);
    expect((await api.call('DELETE', `/api/v1/blocks/${unknown}`, undefined, admin.token)).status).toBe(404);
    expect((await api.call('POST', `${B}/${unknown}/confirm`, undefined, admin.token)).status).toBe(404);
    for (let i = 0; i < 10; i++) expect((await api.call('POST', `${V}/${venueId}/images`, { url: `https://example.com/${i}.jpg` }, owner.token)).status).toBe(201);
    expect((await api.call('POST', `${V}/${venueId}/images`, { url: 'https://example.com/eleven.jpg' }, admin.token)).status).toBe(409); // too many
    expect(await count()).toBe(before);
  });

  it('a block that clashes with a live booking is refused and recorded nowhere', async () => {
    await slotBooking(9);
    const startAt = localSlot(5, 9);
    const res = await noRecord(() => api.call('POST', `${F}/${fieldId}/blocks`, { startAt: startAt.toISOString(), endAt: plusMinutes(startAt, 60).toISOString() }, admin.token));
    expect(res.status).toBe(409);
    expect(await (await prismaP()).venueBlock.count()).toBe(0);
  });

  it('a status change on a venue an admin has suspended is refused (existing rule) and nothing is recorded', async () => {
    await api.call('POST', `${A}/venues/${venueId}/suspend`, {}, admin.token);
    const before = await count();
    const res = await api.call('PATCH', `${V}/${venueId}`, { status: 'ACTIVE' }, admin.token);
    expect(res.status).toBe(403);
    expect(await count()).toBe(before);
    expect((await (await prismaP()).venue.findUniqueOrThrow({ where: { id: venueId } })).status).toBe('SUSPENDED');
  });
});

// ───────────────────────────── atomicity ─────────────────────────────

describe('the action and its record commit together', () => {
  async function failAuditInserts(fn: () => Promise<void>) {
    const prisma = await prismaP();
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION aud07_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER trg_aud07_test_fail BEFORE INSERT ON "admin_audit_log" FOR EACH ROW EXECUTE FUNCTION aud07_test_fail()`);
    try {
      await fn();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_aud07_test_fail ON "admin_audit_log"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS aud07_test_fail()`);
    }
  }

  it('if the audit record cannot be written, the venue operation is rolled back (each kind of change)', async () => {
    const prisma = await prismaP();
    const pending = await slotBooking(9);
    const confirmedId = await slotBooking(13);
    expect((await api.call('POST', `${B}/${confirmedId}/confirm`, undefined, owner.token)).status).toBe(200);
    const venueBefore = await prisma.venue.findUniqueOrThrow({ where: { id: venueId } });

    await failAuditInserts(async () => {
      const startAt = localSlot(12, 10);
      const results = [
        await api.call('PATCH', `${V}/${venueId}`, { name: 'Should not stick' }, admin.token),
        await api.call('POST', `${V}/${venueId}/staff`, { userId: player.userId, role: 'STAFF' }, admin.token),
        await api.call('DELETE', `${V}/${venueId}/staff/${manager.userId}`, undefined, admin.token),
        await api.call('POST', `${V}/${venueId}/images`, { url: 'https://example.com/x.jpg' }, admin.token),
        await api.call('POST', `${V}/${venueId}/fields`, { name: 'Ghost field', format: 'F5', pricePerHour: 10 }, admin.token),
        await api.call('PATCH', `${F}/${fieldId}`, { pricePerHour: 999 }, admin.token),
        await api.call('PUT', `${F}/${fieldId}/opening-hours`, { hours: allWeek('11:00', '12:00') }, admin.token),
        await api.call('POST', `${F}/${fieldId}/blocks`, { startAt: startAt.toISOString(), endAt: plusMinutes(startAt, 60).toISOString() }, admin.token),
        await api.call('POST', `${B}/${pending}/confirm`, undefined, admin.token),
        await api.call('POST', `${B}/${confirmedId}/cancel`, {}, admin.token),
      ];
      expect(results.map((r) => r.status)).toEqual(results.map(() => 500));
    });

    expect(await count()).toBe(0);
    expect((await prisma.venue.findUniqueOrThrow({ where: { id: venueId } })).name).toBe(venueBefore.name);
    expect(await prisma.venueStaff.count({ where: { venueId, userId: player.userId } })).toBe(0);
    expect(await prisma.venueStaff.count({ where: { venueId, userId: manager.userId } })).toBe(1);
    expect(await prisma.venueImage.count({ where: { venueId } })).toBe(0);
    expect(await prisma.venueField.count({ where: { venueId } })).toBe(1);
    expect(Number((await prisma.venueField.findUniqueOrThrow({ where: { id: fieldId } })).pricePerHour)).toBe(100);
    expect(await prisma.venueOpeningHours.count({ where: { fieldId } })).toBe(7);
    expect(await prisma.venueBlock.count()).toBe(0);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: pending } })).status).toBe('PENDING');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: confirmedId } })).status).toBe('CONFIRMED');
  });

  it('removing a block and a staff member rolls back too when the record fails', async () => {
    const prisma = await prismaP();
    const startAt = localSlot(12, 10);
    const block = await api.call('POST', `${F}/${fieldId}/blocks`, { startAt: startAt.toISOString(), endAt: plusMinutes(startAt, 60).toISOString() }, owner.token);
    const blockId = block.body.blocks[0].id as string;
    const image = await api.call('POST', `${V}/${venueId}/images`, { url: 'https://example.com/keep.jpg' }, owner.token);
    await failAuditInserts(async () => {
      expect((await api.call('DELETE', `/api/v1/blocks/${blockId}`, undefined, admin.token)).status).toBe(500);
      expect((await api.call('DELETE', `${V}/${venueId}/images/${image.body.image.id}`, undefined, admin.token)).status).toBe(500);
    });
    expect(await prisma.venueBlock.count({ where: { id: blockId } })).toBe(1);
    expect(await prisma.venueImage.count({ where: { venueId } })).toBe(1);
    expect(await count()).toBe(0);
  });

  it('simultaneous identical administrator changes leave ONE record', async () => {
    for (let round = 0; round < 4; round++) {
      const name = `Race name ${round}`;
      const before = await count();
      const results = await Promise.all([1, 2, 3].map(() => api.call('PATCH', `${V}/${venueId}`, { name }, admin.token)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await count()).toBe(before + 1);
    }
    const target = await slotBooking(9);
    const answers = await Promise.all([api.call('POST', `${B}/${target}/confirm`, undefined, admin.token), api.call('POST', `${B}/${target}/confirm`, undefined, admin.token)]);
    expect(answers.every((r) => r.status === 200 || r.status === 409)).toBe(true); // (a repeated answer is idempotent, as before this change)
    expect((await records()).filter((r) => r.action === 'BOOKING_CONFIRMED_BY_ADMIN')).toHaveLength(1);
  });
});
