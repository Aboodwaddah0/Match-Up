import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, matchBody, type TestUser } from './helpers/users';
import { localSlot, setupVenue } from './helpers/venues';

/*
 * BOOK-02: cancelling a match with `releaseBooking: true` and a direct cancellation of the same booking must change the booking ONCE.
 * Real concurrent requests and, for a deterministic ordering, a cancellation held open in a second transaction.
 */

let api: Awaited<ReturnType<typeof startApp>>;
let owner: TestUser; // owns the venue
let player: TestUser; // the organizer: requests the booking and organizes the match
let admin: TestUser;
let cityId: string;
let fieldId: string;

const B = '/api/v1/bookings';
const M = '/api/v1/matches';
const prismaP = async () => (await import('../src/lib/prisma')).prisma;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  owner = await makeUser(api, 'owner@example.com');
  player = await makeUser(api, 'player@example.com');
  admin = await makeUser(api, 'admin@example.com');
  await prisma.user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
  ({ fieldId } = await setupVenue(api, owner, cityId));
});

let day = 4;
/** A CONFIRMED booking of `player` and an open match organized by `player` inside it (a fresh day each time). */
async function linked() {
  day++;
  const startAt = localSlot(day, 18);
  const booking = await api.call('POST', B, { venueFieldId: fieldId, startAt: startAt.toISOString(), durationMinutes: 120 }, player.token);
  expect(booking.status).toBe(201);
  const bookingId = booking.body.booking.id as string;
  expect((await api.call('POST', `${B}/${bookingId}/confirm`, {}, owner.token)).status).toBe(200);
  const match = await api.call('POST', M, matchBody({ startAt: startAt.toISOString(), durationMinutes: 90, bookingId }), player.token);
  expect(match.status).toBe(201);
  return { bookingId, matchId: match.body.match.id as string };
}

const cancelMatch = (by: TestUser, matchId: string) => api.call('POST', `${M}/${matchId}/cancel`, { releaseBooking: true }, by.token);
const cancelBooking = (by: TestUser, bookingId: string) => api.call('POST', `${B}/${bookingId}/cancel`, { reason: 'changed plans' }, by.token);

const cancelledEvents = async (bookingId: string) => (await prismaP()).bookingEvent.count({ where: { bookingId, toStatus: 'CANCELLED' } });
const cancelNotifications = async (bookingId: string) => (await prismaP()).notification.count({ where: { type: 'BOOKING_CANCELLED', resourceId: bookingId } });
const bookingStatus = async (bookingId: string) => (await (await prismaP()).booking.findUniqueOrThrow({ where: { id: bookingId } })).status;
const matchStatus = async (matchId: string) => (await (await prismaP()).match.findUniqueOrThrow({ where: { id: matchId } })).status;
const conflict = (r: { status: number; body: { error?: { code?: string } } }) => r.status === 409 && r.body.error?.code === 'INVALID_STATE';

describe('match cancellation (releaseBooking) racing a direct cancellation of the booking', () => {
  it('requester cancels the booking while the match is cancelled: one transition, one event, one notification, the match is cancelled (repeated)', async () => {
    for (let round = 0; round < 6; round++) {
      const { bookingId, matchId } = await linked();
      const [matchRes, bookingRes] = await Promise.all([cancelMatch(player, matchId), cancelBooking(player, bookingId)]);
      expect(matchRes.status).toBe(200); // cancelling the match never fails because the booking was already gone
      expect(bookingRes.status === 200 || conflict(bookingRes)).toBe(true);
      expect(await matchStatus(matchId)).toBe('CANCELLED');
      expect(await bookingStatus(bookingId)).toBe('CANCELLED');
      expect(await cancelledEvents(bookingId)).toBe(1);
      expect(await cancelNotifications(bookingId)).toBe(1);
    }
  });

  it('the venue cancels the CONFIRMED booking while the match is cancelled: one transition, one notification (repeated)', async () => {
    for (let round = 0; round < 6; round++) {
      const { bookingId, matchId } = await linked();
      const [matchRes, venueRes] = await Promise.all([cancelMatch(player, matchId), cancelBooking(owner, bookingId)]);
      expect(matchRes.status).toBe(200);
      expect(venueRes.status === 200 || conflict(venueRes)).toBe(true);
      expect(await bookingStatus(bookingId)).toBe('CANCELLED');
      expect(await cancelledEvents(bookingId)).toBe(1);
      expect(await cancelNotifications(bookingId)).toBe(1); // whoever won told the other side, once
    }
  });

  it('an admin cancels the match (releasing the booking) while an admin cancels the booking: exactly one of them is credited with the booking in the audit log', async () => {
    const prisma = await prismaP();
    for (let round = 0; round < 6; round++) {
      const { bookingId, matchId } = await linked();
      const [matchRes, bookingRes] = await Promise.all([cancelMatch(admin, matchId), cancelBooking(admin, bookingId)]);
      expect(matchRes.status).toBe(200);
      expect(bookingRes.status === 200 || conflict(bookingRes)).toBe(true);
      expect(await cancelledEvents(bookingId)).toBe(1);

      const records = await prisma.adminAuditLog.findMany({ where: { OR: [{ targetId: matchId }, { metadata: { path: ['bookingId'], equals: bookingId } }] } });
      const matchRecord = records.filter((r) => r.action === 'MATCH_CANCELLED_BY_ADMIN');
      const bookingRecords = records.filter((r) => r.action === 'BOOKING_CANCELLED_BY_ADMIN');
      expect(matchRecord).toHaveLength(1);
      const credited = (matchRecord[0]!.metadata as { bookingId?: string }).bookingId === bookingId ? 1 : 0;
      expect(credited + bookingRecords.length).toBe(1); // one transition, one audit mention
    }
  });
});

describe('a cancellation of the booking that is still in flight (deterministic ordering)', () => {
  it('the match cancellation waits for it, then leaves the booking alone: no second transition, event, notification or audit mention', async () => {
    const prisma = await prismaP();
    const { bookingId, matchId } = await linked();

    // another transaction has already cancelled the booking but has not committed yet
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const inFlight = prisma.$transaction(
      async (tx) => {
        await tx.booking.update({ where: { id: bookingId }, data: { status: 'CANCELLED', cancelledById: player.userId, cancelReason: 'held open' } });
        await tx.bookingEvent.create({ data: { bookingId, actorId: player.userId, fromStatus: 'CONFIRMED', toStatus: 'CANCELLED', reason: 'held open' } });
        entered();
        await hold;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await inside;

    let settled = false;
    const cancelling = cancelMatch(admin, matchId).then((r) => ((settled = true), r));
    await sleep(600);
    expect(settled).toBe(false); // the match cancellation is queued behind the booking's cancellation, not racing past it
    release();
    await inFlight;
    const res = await cancelling;

    expect(res.status).toBe(200);
    expect(await matchStatus(matchId)).toBe('CANCELLED');
    expect(await bookingStatus(bookingId)).toBe('CANCELLED');
    expect(await cancelledEvents(bookingId)).toBe(1); // only the held-open transaction's event
    expect(await cancelNotifications(bookingId)).toBe(0); // the release did not notify again
    const record = await prisma.adminAuditLog.findFirstOrThrow({ where: { targetId: matchId, action: 'MATCH_CANCELLED_BY_ADMIN' } });
    expect((record.metadata as { bookingId?: string }).bookingId).toBeUndefined(); // the booking was not released by this operation
  });

  it('a booking cancellation that starts while the match cancellation is in flight is refused with 409 and changes nothing twice', async () => {
    const { bookingId, matchId } = await linked();
    // slow the match-cancel's booking update so the direct cancellation really arrives while it holds the booking row
    const prisma = await prismaP();
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION book02_test_slow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'CANCELLED' AND OLD.status <> 'CANCELLED' THEN PERFORM pg_sleep(0.8); END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER trg_book02_test_slow BEFORE UPDATE ON "booking" FOR EACH ROW EXECUTE FUNCTION book02_test_slow()`);
    try {
      const matchPromise = cancelMatch(player, matchId);
      await sleep(300); // the match cancellation is now inside its slowed booking update
      const direct = await cancelBooking(player, bookingId);
      const matchRes = await matchPromise;
      expect(matchRes.status).toBe(200);
      expect(conflict(direct)).toBe(true);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_book02_test_slow ON "booking"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS book02_test_slow()`);
    }
    expect(await cancelledEvents(bookingId)).toBe(1);
    expect(await cancelNotifications(bookingId)).toBe(1); // the release told the venue; the refused cancellation told nobody
  });
});

describe('sequential behaviour is unchanged', () => {
  it('cancelling the match releases the booking once; cancelling the booking again afterwards is a 409 with nothing added', async () => {
    const { bookingId, matchId } = await linked();
    expect((await cancelMatch(player, matchId)).status).toBe(200);
    expect(await bookingStatus(bookingId)).toBe('CANCELLED');
    expect(conflict(await cancelBooking(player, bookingId))).toBe(true);
    expect(conflict(await cancelBooking(owner, bookingId))).toBe(true);
    expect(await cancelledEvents(bookingId)).toBe(1);
    expect(await cancelNotifications(bookingId)).toBe(1);
  });

  it('a booking that is already cancelled is not released or announced again when its match is cancelled', async () => {
    const prisma = await prismaP();
    const { bookingId, matchId } = await linked();
    expect((await cancelBooking(owner, bookingId)).status).toBe(200); // the venue cancels first
    const notifiedBefore = await cancelNotifications(bookingId);
    const res = await cancelMatch(admin, matchId);
    expect(res.status).toBe(200);
    expect(await matchStatus(matchId)).toBe('CANCELLED');
    expect(await cancelledEvents(bookingId)).toBe(1);
    expect(await cancelNotifications(bookingId)).toBe(notifiedBefore);
    const record = await prisma.adminAuditLog.findFirstOrThrow({ where: { targetId: matchId, action: 'MATCH_CANCELLED_BY_ADMIN' } });
    expect((record.metadata as { bookingId?: string }).bookingId).toBeUndefined();
  });

  it('the normal release still works: the booking is cancelled once, the venue is told once, the slot is free, and an admin cancelling names the booking', async () => {
    const prisma = await prismaP();
    const mine = await linked();
    expect((await cancelMatch(player, mine.matchId)).status).toBe(200);
    expect(await bookingStatus(mine.bookingId)).toBe('CANCELLED');
    expect(await cancelledEvents(mine.bookingId)).toBe(1);
    expect(await cancelNotifications(mine.bookingId)).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'BOOKING_CANCELLED', resourceId: mine.bookingId, userId: owner.userId } })).toBe(1);

    const other = await linked();
    expect((await cancelMatch(admin, other.matchId)).status).toBe(200);
    expect(await bookingStatus(other.bookingId)).toBe('CANCELLED');
    const record = await prisma.adminAuditLog.findFirstOrThrow({ where: { targetId: other.matchId, action: 'MATCH_CANCELLED_BY_ADMIN' } });
    expect((record.metadata as { bookingId?: string }).bookingId).toBe(other.bookingId);
  });

  it('without releaseBooking the booking is untouched, and a stranger still cannot cancel the match', async () => {
    const { bookingId, matchId } = await linked();
    const stranger = await makeUser(api, 'stranger@example.com');
    expect((await api.call('POST', `${M}/${matchId}/cancel`, {}, stranger.token)).status).toBe(403);
    expect((await api.call('POST', `${M}/${matchId}/cancel`, {}, player.token)).status).toBe(200);
    expect(await bookingStatus(bookingId)).toBe('CONFIRMED');
    expect(await cancelledEvents(bookingId)).toBe(0);
  });
});
