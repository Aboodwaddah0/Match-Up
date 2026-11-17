import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localParts, zonedToUtc } from '../src/lib/time';
import { resetDb, startApp } from './helpers/client';
import { makeUser, type TestUser } from './helpers/users';
import { allWeek, localSlot, plusMinutes, setupVenue } from './helpers/venues';

let api: Awaited<ReturnType<typeof startApp>>;
let owner: TestUser;
let cityId: string;

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
  cityId = (await prisma.city.create({ data: { nameAr: 'الخليل', nameEn: 'Hebron' } })).id;
  owner = await makeUser(api, 'owner@example.com');
});

const venueBody = (over: Record<string, unknown> = {}) => ({
  name: 'Test Arena', cityId, address: 'Main street 1', latitude: 31.53, longitude: 35.1, ...over,
});

describe('time zones (opening hours are local wall-clock)', () => {
  it('converts Asia/Hebron local time to UTC across the daylight-saving change', () => {
    expect(zonedToUtc(2027, 1, 15, 18, 0, 'Asia/Hebron').toISOString()).toBe('2027-01-15T16:00:00.000Z'); // UTC+2 in winter
    expect(zonedToUtc(2027, 7, 15, 18, 0, 'Asia/Hebron').toISOString()).toBe('2027-07-15T15:00:00.000Z'); // UTC+3 in summer
  });

  it('round-trips and reports the weekday', () => {
    const t = zonedToUtc(2027, 7, 15, 21, 30, 'Asia/Hebron');
    expect(localParts(t, 'Asia/Hebron')).toMatchObject({ year: 2027, month: 7, day: 15, hour: 21, minute: 30, weekday: 4 }); // Thursday
  });
});

describe('venues', () => {
  it('needs a verified e-mail, validates input, and defaults the time zone', async () => {
    const unverified = await makeUser(api, 'uv@example.com', { verified: false });
    expect((await api.call('POST', '/api/v1/venues', venueBody(), unverified.token)).body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await api.call('POST', '/api/v1/venues', venueBody({ timezone: 'Mars/Base' }), owner.token)).status).toBe(400);
    expect((await api.call('POST', '/api/v1/venues', venueBody({ cityId: crypto.randomUUID() }), owner.token)).body.error.code).toBe('INVALID_CITY');

    const ok = await api.call('POST', '/api/v1/venues', venueBody(), owner.token);
    expect(ok.status).toBe(201);
    expect(ok.body.venue).toMatchObject({ name: 'Test Arena', timezone: 'Asia/Hebron', status: 'ACTIVE' });
  });

  it('one user can own several venues; "mine" lists them', async () => {
    await api.call('POST', '/api/v1/venues', venueBody({ name: 'Arena One' }), owner.token);
    await api.call('POST', '/api/v1/venues', venueBody({ name: 'Arena Two' }), owner.token);
    const res = await api.call('GET', '/api/v1/venues/mine', undefined, owner.token);
    expect(res.body.venues.map((v: { name: string }) => v.name)).toEqual(['Arena One', 'Arena Two']);
    expect(res.body.venues.every((v: { owner: boolean }) => v.owner)).toBe(true);
  });

  it('hides an inactive venue from the public but not from its staff', async () => {
    const { venueId } = await setupVenue(api, owner, cityId);
    const stranger = await makeUser(api, 's@example.com');
    expect((await api.call('GET', `/api/v1/venues/${venueId}`, undefined, stranger.token)).status).toBe(200);

    await api.call('PATCH', `/api/v1/venues/${venueId}`, { status: 'INACTIVE' }, owner.token);
    expect((await api.call('GET', `/api/v1/venues/${venueId}`, undefined, stranger.token)).status).toBe(404);
    expect((await api.call('GET', `/api/v1/venues/${venueId}`, undefined, owner.token)).body.venue.myAccess.owner).toBe(true);
    expect((await api.call('GET', '/api/v1/venues', undefined, stranger.token)).body.venues).toHaveLength(0);
  });

  it('searches by city, name, format and distance', async () => {
    await setupVenue(api, owner, cityId); // Hebron Arena @ 31.53,35.1 with an F7 field
    const other = await api.call('POST', '/api/v1/venues', venueBody({ name: 'Far Away', latitude: 32.2, longitude: 35.2 }), owner.token);
    await api.call('POST', `/api/v1/venues/${other.body.venue.id}/fields`, { name: 'F', format: 'F5', pricePerHour: 50 }, owner.token);
    const viewer = await makeUser(api, 'v@example.com');
    const names = async (qs: string) => (await api.call('GET', `/api/v1/venues?${qs}`, undefined, viewer.token)).body.venues.map((v: { name: string }) => v.name);

    expect(await names('')).toEqual(['Far Away', 'Hebron Arena']);
    expect(await names('q=hebron')).toEqual(['Hebron Arena']);
    expect(await names('format=F5')).toEqual(['Far Away']);
    expect(await names('lat=31.53&lng=35.1&radiusKm=5')).toEqual(['Hebron Arena']);
    expect(await names(`cityId=${crypto.randomUUID()}`)).toEqual([]);
  });
});

describe('permissions are per venue (D2)', () => {
  it('owner can add staff; staff only do what their permissions allow, only at that venue', async () => {
    const { venueId, fieldId } = await setupVenue(api, owner, cityId);
    const other = await setupVenue(api, await makeUser(api, 'owner2@example.com'), cityId);
    const staff = await makeUser(api, 'staff@example.com');

    const added = await api.call('POST', `/api/v1/venues/${venueId}/staff`, { userId: staff.userId, role: 'STAFF' }, owner.token);
    expect(added.body.staff.permissions.sort()).toEqual(['MANAGE_AVAILABILITY', 'MANAGE_BOOKINGS']);

    // allowed: blocks (MANAGE_AVAILABILITY)
    const block = { startAt: localSlot(3, 10).toISOString(), endAt: localSlot(3, 12).toISOString() };
    expect((await api.call('POST', `/api/v1/fields/${fieldId}/blocks`, block, staff.token)).status).toBe(201);
    // not allowed: prices (MANAGE_FIELDS), venue edits, staff management
    expect((await api.call('PATCH', `/api/v1/fields/${fieldId}`, { pricePerHour: 1 }, staff.token)).status).toBe(403);
    expect((await api.call('PATCH', `/api/v1/venues/${venueId}`, { name: 'Hacked' }, staff.token)).status).toBe(403);
    expect((await api.call('POST', `/api/v1/venues/${venueId}/staff`, { userId: owner.userId }, staff.token)).status).toBe(403);
    // nothing at another venue
    expect((await api.call('POST', `/api/v1/fields/${other.fieldId}/blocks`, block, staff.token)).status).toBe(403);
  });

  it('explicit permissions override the role defaults; the owner cannot be added as staff', async () => {
    const { venueId, fieldId } = await setupVenue(api, owner, cityId);
    const manager = await makeUser(api, 'm@example.com');
    await api.call('POST', `/api/v1/venues/${venueId}/staff`, { userId: manager.userId, role: 'MANAGER', permissions: ['MANAGE_FIELDS'] }, owner.token);
    expect((await api.call('PATCH', `/api/v1/fields/${fieldId}`, { pricePerHour: 150 }, manager.token)).body.field.pricePerHour).toBe(150);
    expect((await api.call('PUT', `/api/v1/fields/${fieldId}/opening-hours`, { hours: allWeek() }, manager.token)).status).toBe(403);
    expect((await api.call('POST', `/api/v1/venues/${venueId}/staff`, { userId: owner.userId }, owner.token)).body.error.code).toBe('INVALID_STAFF');
  });

  it('removing staff takes the access away immediately', async () => {
    const { venueId, fieldId } = await setupVenue(api, owner, cityId);
    const staff = await makeUser(api, 'staff@example.com');
    await api.call('POST', `/api/v1/venues/${venueId}/staff`, { userId: staff.userId, role: 'STAFF' }, owner.token);
    const block = { startAt: localSlot(3, 10).toISOString(), endAt: localSlot(3, 11).toISOString() };
    expect((await api.call('POST', `/api/v1/fields/${fieldId}/blocks`, block, staff.token)).status).toBe(201);
    expect((await api.call('DELETE', `/api/v1/venues/${venueId}/staff/${staff.userId}`, undefined, owner.token)).status).toBe(204);
    expect((await api.call('POST', `/api/v1/fields/${fieldId}/blocks`, { ...block, startAt: localSlot(3, 14).toISOString(), endAt: localSlot(3, 15).toISOString() }, staff.token)).status).toBe(403);
  });
});

describe('fields, hours and availability', () => {
  it('validates opening hours and replaces the whole schedule', async () => {
    const { fieldId } = await setupVenue(api, owner, cityId);
    const put = (hours: unknown) => api.call('PUT', `/api/v1/fields/${fieldId}/opening-hours`, { hours }, owner.token);
    expect((await put([{ weekday: 1, open: '20:00', close: '18:00' }])).status).toBe(400);
    expect((await put([{ weekday: 1, open: '08:00', close: '12:00' }, { weekday: 1, open: '11:00', close: '14:00' }])).status).toBe(400);
    expect((await put([{ weekday: 9, open: '08:00', close: '12:00' }])).status).toBe(400);
    expect((await put([{ weekday: 1, open: '8am', close: '12:00' }])).status).toBe(400);

    expect((await put([{ weekday: 1, open: '08:00', close: '12:00' }, { weekday: 1, open: '16:00', close: '22:00' }])).status).toBe(200);
    const venueId = (await api.call('GET', '/api/v1/venues/mine', undefined, owner.token)).body.venues[0].id;
    const hours = (await api.call('GET', `/api/v1/venues/${venueId}`, undefined, owner.token)).body.venue.fields[0].openingHours;
    expect(hours).toEqual([{ weekday: 1, open: '08:00', close: '12:00' }, { weekday: 1, open: '16:00', close: '22:00' }]);
  });

  it('lists bookable slots in local time, minus past slots, blocks and active holds', async () => {
    const { fieldId } = await setupVenue(api, owner, cityId);
    const day = localParts(localSlot(4, 12), 'Asia/Hebron');
    const date = `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
    const get = () => api.call('GET', `/api/v1/fields/${fieldId}/availability?date=${date}`, undefined, owner.token);

    const free = await get();
    expect(free.status).toBe(200);
    expect(free.body.slots).toHaveLength(15); // 08:00-23:00, 60-minute slots
    expect(free.body.slots[0]).toMatchObject({ startAt: localSlot(4, 8).toISOString(), available: true, price: 100 });

    await api.call('POST', `/api/v1/fields/${fieldId}/blocks`, { startAt: localSlot(4, 10).toISOString(), endAt: localSlot(4, 12).toISOString() }, owner.token);
    const booker = await makeUser(api, 'b@example.com');
    await api.call('POST', '/api/v1/bookings', { venueFieldId: fieldId, startAt: localSlot(4, 18).toISOString(), durationMinutes: 120 }, booker.token);

    const busy = (await get()).body.slots.filter((s: { available: boolean }) => !s.available).map((s: { startAt: string }) => localParts(new Date(s.startAt), 'Asia/Hebron').hour);
    expect(busy).toEqual([10, 11, 18, 19]);
  });

  it('closed days have no slots; invalid dates are rejected', async () => {
    const { fieldId } = await setupVenue(api, owner, cityId);
    await api.call('PUT', `/api/v1/fields/${fieldId}/opening-hours`, { hours: [{ weekday: 1, open: '08:00', close: '10:00' }] }, owner.token);
    const closed = localParts(localSlot(4, 12), 'Asia/Hebron').weekday === 1 ? localSlot(5, 12) : localSlot(4, 12);
    const p = localParts(closed, 'Asia/Hebron');
    const res = await api.call('GET', `/api/v1/fields/${fieldId}/availability?date=${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`, undefined, owner.token);
    expect(res.body.slots).toEqual([]);
    expect((await api.call('GET', `/api/v1/fields/${fieldId}/availability?date=tomorrow`, undefined, owner.token)).status).toBe(400);
  });
});

describe('venue blocks (D11): owner-managed unavailable time, never a booking', () => {
  it('blocks a period; overlapping blocks are refused; deleting a block frees it', async () => {
    const { fieldId } = await setupVenue(api, owner, cityId);
    const body = { startAt: localSlot(3, 18).toISOString(), endAt: localSlot(3, 20).toISOString(), reason: 'OFFLINE_BOOKING', note: 'phone customer' };
    const made = await api.call('POST', `/api/v1/fields/${fieldId}/blocks`, body, owner.token);
    expect(made.status).toBe(201);

    const clash = await api.call('POST', `/api/v1/fields/${fieldId}/blocks`, { ...body, startAt: localSlot(3, 19).toISOString(), endAt: localSlot(3, 21).toISOString() }, owner.token);
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('BLOCK_OVERLAP');

    const booker = await makeUser(api, 'b@example.com');
    const slot = { venueFieldId: fieldId, startAt: localSlot(3, 18).toISOString(), durationMinutes: 60 };
    expect((await api.call('POST', '/api/v1/bookings', slot, booker.token)).body.error.code).toBe('SLOT_UNAVAILABLE');

    expect((await api.call('DELETE', `/api/v1/blocks/${made.body.blocks[0].id}`, undefined, owner.token)).status).toBe(204);
    expect((await api.call('POST', '/api/v1/bookings', slot, booker.token)).status).toBe(201);
  });

  it('refuses to block over a pending/confirmed booking and lists the ones in the way', async () => {
    const { fieldId } = await setupVenue(api, owner, cityId);
    const booker = await makeUser(api, 'b@example.com');
    const booking = await api.call('POST', '/api/v1/bookings', { venueFieldId: fieldId, startAt: localSlot(3, 18).toISOString(), durationMinutes: 60 }, booker.token);

    const res = await api.call('POST', `/api/v1/fields/${fieldId}/blocks`, { startAt: localSlot(3, 17).toISOString(), endAt: localSlot(3, 19).toISOString() }, owner.token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BLOCK_CONFLICTS_BOOKING');
    expect(res.body.error.details[0]).toMatchObject({ id: booking.body.booking.id, status: 'PENDING' });
  });

  it('can block every field of the venue at once', async () => {
    const { venueId, fieldId } = await setupVenue(api, owner, cityId);
    await api.call('POST', `/api/v1/venues/${venueId}/fields`, { name: 'Field 2', format: 'F5', pricePerHour: 60 }, owner.token);
    const res = await api.call('POST', `/api/v1/fields/${fieldId}/blocks`, { startAt: localSlot(3, 9).toISOString(), endAt: localSlot(3, 11).toISOString(), reason: 'MAINTENANCE', allFields: true }, owner.token);
    expect(res.body.blocks).toHaveLength(2);
    expect(new Set(res.body.blocks.map((b: { groupId: string }) => b.groupId)).size).toBe(1);
    expect(plusMinutes(new Date(res.body.blocks[0].startAt), 120).toISOString()).toBe(new Date(res.body.blocks[0].endAt).toISOString());
  });
});
