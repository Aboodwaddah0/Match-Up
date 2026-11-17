import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, matchBody, moveMatchTime, type TestUser } from './helpers/users';
import { localSlot, setupVenue } from './helpers/venues';

let api: Awaited<ReturnType<typeof startApp>>;
let owner: TestUser;
let player: TestUser;
let cityId: string;
let venueId: string;
let fieldId: string;

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
  player = await makeUser(api, 'player@example.com');
  ({ venueId, fieldId } = await setupVenue(api, owner, cityId));
});

const book = (u: TestUser, startAt: Date, durationMinutes = 60, over: Record<string, unknown> = {}) =>
  api.call('POST', '/api/v1/bookings', { venueFieldId: fieldId, startAt: startAt.toISOString(), durationMinutes, ...over }, u.token);
const act = (u: TestUser, id: string, what: string, body?: unknown) => api.call('POST', `/api/v1/bookings/${id}/${what}`, body ?? {}, u.token);
const status = async (id: string) => (await api.call('GET', `/api/v1/bookings/${id}`, undefined, player.token)).body.booking.status as string;

async function prismaClient() {
  return (await import('../src/lib/prisma')).prisma;
}

describe('requesting a booking', () => {
  it('creates a PENDING request holding the slot for 2h, priced from the hourly rate', async () => {
    const res = await book(player, localSlot(5, 18), 120);
    expect(res.status).toBe(201);
    const b = res.body.booking;
    expect(b).toMatchObject({ source: 'IN_APP', status: 'PENDING', totalPrice: 200, currency: 'ILS', venue: { name: 'Hebron Arena' }, field: { name: 'Field 1' } });
    const holdMs = new Date(b.holdExpiresAt).getTime() - Date.now();
    expect(holdMs).toBeGreaterThan(119 * 60_000);
    expect(holdMs).toBeLessThanOrEqual(120 * 60_000);
    expect(JSON.stringify(b)).not.toContain(player.email);
  });

  it('needs a verified e-mail and an active field', async () => {
    const unverified = await makeUser(api, 'uv@example.com', { verified: false });
    expect((await book(unverified, localSlot(5, 18))).body.error.code).toBe('EMAIL_NOT_VERIFIED');
    await api.call('PATCH', `/api/v1/fields/${fieldId}`, { isActive: false }, owner.token);
    expect((await book(player, localSlot(5, 18))).body.error.code).toBe('FIELD_NOT_FOUND');
  });

  it.each([
    ['outside opening hours', () => localSlot(5, 6), 60, 409, 'OUTSIDE_OPENING_HOURS'],
    ['ending after closing time', () => localSlot(5, 22), 120, 409, 'OUTSIDE_OPENING_HOURS'],
    ['not on a slot boundary', () => localSlot(5, 18, 30), 60, 400, 'INVALID_START'],
    ['not a whole number of slots', () => localSlot(5, 18), 90 + 15, 400, 'INVALID_DURATION'],
    ['in the past', () => localSlot(-1, 18), 60, 400, 'DATE_IN_PAST'],
  ])('rejects a request %s', async (_n, start, minutes, httpStatus, code) => {
    const res = await book(player, start(), minutes);
    expect(res.status).toBe(httpStatus);
    expect(res.body.error.code).toBe(code);
  });

  it('refuses overlapping requests but allows back-to-back ones', async () => {
    const other = await makeUser(api, 'o@example.com');
    expect((await book(player, localSlot(5, 18), 60)).status).toBe(201);
    const clash = await book(other, localSlot(5, 18), 60);
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('SLOT_UNAVAILABLE');
    expect((await book(other, localSlot(5, 19), 60)).status).toBe(201); // 19:00 starts exactly when 18:00-19:00 ends
  });

  it('two simultaneous requests for the same slot: exactly one wins', async () => {
    const other = await makeUser(api, 'o@example.com');
    const results = await Promise.all([book(player, localSlot(6, 20)), book(other, localSlot(6, 20))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('SLOT_UNAVAILABLE');
  });

  it('limits simultaneous pending requests per user (anti slot-hoarding)', async () => {
    for (const hour of [9, 11, 13]) expect((await book(player, localSlot(5, hour))).status).toBe(201);
    const res = await book(player, localSlot(5, 15));
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_PENDING_BOOKINGS');
  });
});

describe('the venue answers (D11)', () => {
  it('staff see the inbox, confirm, and the requester is notified; strangers see nothing', async () => {
    const staff = await makeUser(api, 'staff@example.com');
    await api.call('POST', `/api/v1/venues/${venueId}/staff`, { userId: staff.userId, role: 'STAFF' }, owner.token);
    const id = (await book(player, localSlot(5, 18))).body.booking.id;

    const { prisma } = await import('../src/lib/prisma');
    expect(await prisma.notification.count({ where: { type: 'BOOKING_REQUEST_RECEIVED', userId: { in: [owner.userId, staff.userId] } } })).toBe(2);

    const inbox = await api.call('GET', `/api/v1/venues/${venueId}/bookings?status=PENDING`, undefined, staff.token);
    expect(inbox.body.bookings).toHaveLength(1);
    expect(inbox.body.bookings[0].requester).toMatchObject({ fullName: 'Player player' });
    expect((await api.call('GET', `/api/v1/venues/${venueId}/bookings`, undefined, player.token)).status).toBe(403);

    const stranger = await makeUser(api, 'x@example.com');
    expect((await api.call('GET', `/api/v1/bookings/${id}`, undefined, stranger.token)).status).toBe(404);
    expect((await act(stranger, id, 'confirm')).status).toBe(404);
    expect((await act(player, id, 'confirm')).status).toBe(404); // requesters cannot approve themselves

    const confirmed = await act(staff, id, 'confirm');
    expect(confirmed.body.booking).toMatchObject({ status: 'CONFIRMED', holdExpiresAt: null });
    expect(await prisma.notification.count({ where: { userId: player.userId, type: 'BOOKING_CONFIRMED' } })).toBe(1);
    expect((await act(owner, id, 'reject')).body.error.code).toBe('INVALID_STATE');
  });

  it('a rejected request releases the slot immediately', async () => {
    const other = await makeUser(api, 'o@example.com');
    const id = (await book(player, localSlot(5, 18))).body.booking.id;
    const rejected = await act(owner, id, 'reject', { reason: 'Maintenance that evening' });
    expect(rejected.body.booking).toMatchObject({ status: 'REJECTED', cancelReason: 'Maintenance that evening' });
    expect((await book(other, localSlot(5, 18))).status).toBe(201);
  });

  it('venue staff cannot answer their own booking request', async () => {
    const staff = await makeUser(api, 'staff@example.com');
    await api.call('POST', `/api/v1/venues/${venueId}/staff`, { userId: staff.userId, role: 'STAFF' }, owner.token);
    const id = (await book(staff, localSlot(5, 18))).body.booking.id;
    expect((await act(staff, id, 'confirm')).body.error.code).toBe('CANNOT_DECIDE_OWN_BOOKING');
    expect((await act(owner, id, 'confirm')).body.booking.status).toBe('CONFIRMED');
  });

  it('confirm and reject racing each other: only the first answer counts', async () => {
    const id = (await book(player, localSlot(5, 18))).body.booking.id;
    const results = await Promise.all([act(owner, id, 'confirm'), act(owner, id, 'reject')]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(['CONFIRMED', 'REJECTED']).toContain(await status(id));
  });
});

describe('the 2-hour hold (D1)', () => {
  it('an expired request can no longer be confirmed, and no longer blocks the slot', async () => {
    const other = await makeUser(api, 'o@example.com');
    const id = (await book(player, localSlot(5, 18))).body.booking.id;
    const prisma = await prismaClient();
    await prisma.booking.update({ where: { id }, data: { holdExpiresAt: new Date(Date.now() - 60_000) } }); // 2h have passed

    // before any sweeper runs: the owner is told, deterministically, by the DB clock
    const late = await act(owner, id, 'confirm');
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('HOLD_EXPIRED');

    // and a new request for the same slot succeeds; the stale one is expired on the spot
    expect((await book(other, localSlot(5, 18))).status).toBe(201);
    expect(await status(id)).toBe('EXPIRED');
  });

  it('the sweeper expires unanswered requests and tells the requester; it is idempotent', async () => {
    const { runLifecycleJobs } = await import('../src/jobs/match-lifecycle');
    const id = (await book(player, localSlot(5, 18))).body.booking.id;
    const prisma = await prismaClient();
    expect((await runLifecycleJobs()).expired).toBe(0); // hold still alive
    await prisma.booking.update({ where: { id }, data: { holdExpiresAt: new Date(Date.now() - 1_000) } });

    expect((await runLifecycleJobs()).expired).toBe(1);
    expect((await runLifecycleJobs()).expired).toBe(0);
    expect(await status(id)).toBe('EXPIRED');
    expect(await prisma.notification.count({ where: { userId: player.userId, type: 'BOOKING_EXPIRED' } })).toBe(1);
    expect(await prisma.bookingEvent.count({ where: { bookingId: id, toStatus: 'EXPIRED' } })).toBe(1);
  });

  it('a request made shortly before the start holds only until the start', async () => {
    const soon = new Date(Date.now() + 30 * 60_000); // not slot aligned, so insert directly
    const prisma = await prismaClient();
    const b = await prisma.booking.create({
      data: { source: 'IN_APP', status: 'PENDING', createdById: player.userId, venueFieldId: fieldId, startAt: soon, endAt: new Date(soon.getTime() + 3_600_000), totalPrice: 100 },
    });
    expect(b.holdExpiresAt!.getTime()).toBe(soon.getTime());
  });

  it('confirmed bookings are completed by the job once they are over', async () => {
    const { runLifecycleJobs } = await import('../src/jobs/match-lifecycle');
    const id = (await book(player, localSlot(5, 18))).body.booking.id;
    await act(owner, id, 'confirm');
    const prisma = await prismaClient();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRawUnsafe(`UPDATE booking SET start_at = now() - interval '3 hours', end_at = now() - interval '2 hours' WHERE id = '${id}'`);
    });
    expect((await runLifecycleJobs()).completed).toBe(1);
    expect(await status(id)).toBe('COMPLETED');
  });
});

describe('cancelling', () => {
  it('the requester can cancel; the slot is freed and the venue is told', async () => {
    const other = await makeUser(api, 'o@example.com');
    const id = (await book(player, localSlot(5, 18))).body.booking.id;
    await act(owner, id, 'confirm');
    const stranger = await makeUser(api, 'x@example.com');
    expect((await act(stranger, id, 'cancel')).status).toBe(404);

    expect((await act(player, id, 'cancel', { reason: 'plans changed' })).body.booking.status).toBe('CANCELLED');
    const { prisma } = await import('../src/lib/prisma');
    expect(await prisma.notification.count({ where: { userId: owner.userId, type: 'BOOKING_CANCELLED' } })).toBe(1);
    expect((await book(other, localSlot(5, 18))).status).toBe(201);
    expect((await act(player, id, 'cancel')).body.error.code).toBe('INVALID_STATE');
  });

  it('the venue can cancel a CONFIRMED booking (not a pending one: that is a rejection)', async () => {
    const pending = (await book(player, localSlot(5, 18))).body.booking.id;
    expect((await act(owner, pending, 'cancel')).body.error.code).toBe('USE_REJECT');
    await act(owner, pending, 'confirm');
    expect((await act(owner, pending, 'cancel', { reason: 'pitch flooded' })).body.booking.status).toBe('CANCELLED');
    const { prisma } = await import('../src/lib/prisma');
    expect(await prisma.notification.count({ where: { userId: player.userId, type: 'BOOKING_CANCELLED' } })).toBe(1);
  });
});

describe('external bookings (made outside the app)', () => {
  const external = (over: Record<string, unknown> = {}) => ({
    extVenueName: 'Al-Quds Pitch', extVenueAddress: 'Somewhere 5', extVenuePhone: '0599000000',
    startAt: localSlot(4, 19).toISOString(), endAt: localSlot(4, 21).toISOString(), totalPrice: 240, ...over,
  });

  it('records a self-reported snapshot for a venue that is not on the platform', async () => {
    const res = await api.call('POST', '/api/v1/bookings/external', external(), player.token);
    expect(res.status).toBe(201);
    expect(res.body.booking).toMatchObject({
      source: 'EXTERNAL', status: 'CONFIRMED', totalPrice: 240, venue: null, field: null,
      external: { venueName: 'Al-Quds Pitch', venuePhone: '0599000000', verified: false },
    });
    expect((await api.call('POST', '/api/v1/bookings/external', external({ extVenueName: undefined }), player.token)).status).toBe(400);
    expect((await api.call('POST', '/api/v1/bookings/external', external({ endAt: localSlot(4, 18).toISOString() }), player.token)).status).toBe(400);
  });

  it('never reserves a registered field, and the venue cannot decide it', async () => {
    const id = (await api.call('POST', '/api/v1/bookings/external', external(), player.token)).body.booking.id;
    expect((await book(player, localSlot(4, 19))).status).toBe(201); // the real field is still free
    expect((await act(owner, id, 'confirm')).status).toBe(400);
    expect((await act(player, id, 'cancel')).body.booking.status).toBe('CANCELLED');
  });
});

describe('bookings and matches stay separate but can be linked', () => {
  async function confirmedBooking(who: TestUser, day = 5, hour = 18, minutes = 120) {
    const id = (await book(who, localSlot(day, hour), minutes)).body.booking.id;
    await act(owner, id, 'confirm');
    return id as string;
  }
  const createMatch = (u: TestUser, bookingId: string, over: Record<string, unknown> = {}) =>
    api.call('POST', '/api/v1/matches', matchBody({ startAt: localSlot(5, 18).toISOString(), durationMinutes: 90, bookingId, ...over }), u.token);

  it('a match can use the organizer\'s CONFIRMED booking; location defaults come from the venue', async () => {
    const bookingId = await confirmedBooking(player);
    const res = await createMatch(player, bookingId);
    expect(res.status).toBe(201);
    expect(res.body.match).toMatchObject({ locationName: 'Hebron Arena', latitude: 31.53, venueConfirmed: true, booking: { id: bookingId, status: 'CONFIRMED', source: 'IN_APP' } });
    expect(res.body.match.city.nameEn).toBe('Hebron');
  });

  it('a match can exist without any booking', async () => {
    const res = await api.call('POST', '/api/v1/matches', matchBody(), player.token);
    expect(res.body.match).toMatchObject({ booking: null, venueConfirmed: null });
  });

  it('refuses pending bookings, other people\'s bookings, matches outside the booked time, and a second active match', async () => {
    const pending = (await book(player, localSlot(5, 18), 120)).body.booking.id;
    expect((await createMatch(player, pending)).body.error.code).toBe('BOOKING_NOT_CONFIRMED');

    const confirmed = await confirmedBooking(player, 6, 18);
    const other = await makeUser(api, 'o@example.com');
    expect((await createMatch(other, confirmed, { startAt: localSlot(6, 18).toISOString() })).body.error.code).toBe('BOOKING_NOT_OWNED');
    expect((await createMatch(player, confirmed, { startAt: localSlot(6, 20).toISOString(), durationMinutes: 90 })).body.error.code).toBe('MATCH_OUTSIDE_BOOKING');

    expect((await createMatch(player, confirmed, { startAt: localSlot(6, 18).toISOString() })).status).toBe(201);
    expect((await createMatch(player, confirmed, { startAt: localSlot(6, 18).toISOString(), title: 'Second one' })).body.error.code).toBe('BOOKING_ALREADY_LINKED');
  });

  it('when the venue cancels, the match stays but is flagged "venue not confirmed" and people are told', async () => {
    const bookingId = await confirmedBooking(player);
    const matchId = (await createMatch(player, bookingId)).body.match.id;
    const joiner = await makeUser(api, 'j@example.com');
    const ask = await api.call('POST', `/api/v1/matches/${matchId}/requests`, {}, joiner.token);
    await api.call('POST', `/api/v1/matches/${matchId}/requests/${ask.body.request.id}/accept`, {}, player.token);

    await act(owner, bookingId, 'cancel', { reason: 'closed' });
    const match = (await api.call('GET', `/api/v1/matches/${matchId}`, undefined, joiner.token)).body.match;
    expect(match).toMatchObject({ status: 'OPEN', venueConfirmed: false, booking: { status: 'CANCELLED' } });
    const { prisma } = await import('../src/lib/prisma');
    expect(await prisma.notification.count({ where: { type: 'MATCH_VENUE_UNCONFIRMED', userId: { in: [player.userId, joiner.userId] } } })).toBe(2);
  });

  it('cancelling a match can also release the booking, freeing the venue slot', async () => {
    const bookingId = await confirmedBooking(player);
    const matchId = (await createMatch(player, bookingId)).body.match.id;
    const other = await makeUser(api, 'o@example.com');

    // default: the booking is kept
    const kept = await api.call('POST', `/api/v1/matches/${matchId}/cancel`, {}, player.token);
    expect(kept.body.match.status).toBe('CANCELLED');
    expect(await status(bookingId)).toBe('CONFIRMED');

    const second = await confirmedBooking(player, 6, 18);
    const m2 = (await createMatch(player, second, { startAt: localSlot(6, 18).toISOString() })).body.match.id;
    await api.call('POST', `/api/v1/matches/${m2}/cancel`, { releaseBooking: true }, player.token);
    expect(await status(second)).toBe('CANCELLED');
    expect((await book(other, localSlot(6, 18), 120)).status).toBe(201);
  });
});

describe('matches linked to a past booking window', () => {
  it('time of a linked match must stay inside its booking when edited', async () => {
    const id = (await book(player, localSlot(5, 18), 120)).body.booking.id;
    await act(owner, id, 'confirm');
    const matchId = (await api.call('POST', '/api/v1/matches', matchBody({ startAt: localSlot(5, 18).toISOString(), durationMinutes: 90, bookingId: id }), player.token)).body.match.id;
    const moved = await api.call('PATCH', `/api/v1/matches/${matchId}`, { startAt: localSlot(5, 21).toISOString() }, player.token);
    expect(moved.status).toBe(400);
    expect(moved.body.error.code).toBe('MATCH_OUTSIDE_BOOKING');
    void moveMatchTime;
  });
});
