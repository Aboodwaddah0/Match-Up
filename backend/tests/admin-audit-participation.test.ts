import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, matchBody, moveMatchTime, type TestUser } from './helpers/users';
import { localSlot, setupVenue } from './helpers/venues';

let api: Awaited<ReturnType<typeof startApp>>;
let admin: TestUser;
let org: TestUser;
let p1: TestUser;
let p2: TestUser;
let outsider: TestUser;
let cityId: string;

const M = '/api/v1/matches';
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
  org = await makeUser(api, 'org@example.com');
  p1 = await makeUser(api, 'p1@example.com');
  p2 = await makeUser(api, 'p2@example.com');
  outsider = await makeUser(api, 'outsider@example.com');
});

/** A trigger that makes writes to one table fail: the business operation and its audit record must succeed or fail together. */
async function failWritesOn(table: string, event: 'INSERT' | 'UPDATE', fn: () => Promise<void>) {
  const prisma = await prismaP();
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION audit2_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER trg_audit2_test_fail BEFORE ${event} ON "${table}" FOR EACH ROW EXECUTE FUNCTION audit2_test_fail()`);
  try {
    await fn();
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_audit2_test_fail ON "${table}"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS audit2_test_fail()`);
  }
}

const newMatch = async (by: TestUser = org, over: Record<string, unknown> = {}) => (await api.call('POST', M, matchBody(over), by.token)).body.match.id as string;
const ask = async (matchId: string, by: TestUser) => (await api.call('POST', `${M}/${matchId}/requests`, {}, by.token)).body.request.id as string;
const decide = (matchId: string, requestId: string, what: 'accept' | 'reject', by: TestUser) => api.call('POST', `${M}/${matchId}/requests/${requestId}/${what}`, {}, by.token);
/** A confirmed participant, accepted by the ORGANIZER (so nothing is recorded yet). */
async function confirmed(matchId: string, who: TestUser, organizer: TestUser = org) {
  const r = await ask(matchId, who);
  expect((await decide(matchId, r, 'accept', organizer)).status).toBe(200);
}
/** The match has started (lazy start on the first read). */
async function start(matchId: string, by: TestUser = org) {
  await moveMatchTime(matchId, -2, -0.5);
  await api.call('GET', `${M}/${matchId}`, undefined, by.token);
}
const participantStatus = async (matchId: string, userId: string) => (await (await prismaP()).matchParticipant.findUnique({ where: { matchId_userId: { matchId, userId } } }))?.status;
const requestStatus = async (id: string) => (await (await prismaP()).matchRequest.findUniqueOrThrow({ where: { id } })).status;
const noPersonalData = (rows: unknown) => {
  const text = JSON.stringify(rows);
  for (const bad of ['@example.com', 'Player ', 'token', 'password']) expect(text).not.toContain(bad);
};

// ───────────────────────────── join request decisions ─────────────────────────────

describe('an admin deciding a join request on another organizer\'s match', () => {
  it('accepting leaves exactly one record with minimal metadata, and the player is confirmed', async () => {
    const matchId = await newMatch();
    const requestId = await ask(matchId, p1);
    expect((await decide(matchId, requestId, 'accept', admin)).status).toBe(200);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: admin.userId, action: 'JOIN_REQUEST_ACCEPTED_BY_ADMIN', targetType: 'MATCH', targetId: matchId, reason: null });
    expect(rows[0]!.metadata).toEqual({ fromStatus: 'PENDING', toStatus: 'ACCEPTED', organizerId: org.userId, requestId, subjectUserId: p1.userId });
    expect(rows[0]!.requestId).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    expect(await participantStatus(matchId, p1.userId)).toBe('CONFIRMED');
    noPersonalData(rows);
  });

  it('rejecting leaves exactly one record, and nobody is confirmed', async () => {
    const matchId = await newMatch();
    const requestId = await ask(matchId, p1);
    expect((await decide(matchId, requestId, 'reject', admin)).status).toBe(200);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'JOIN_REQUEST_REJECTED_BY_ADMIN', targetId: matchId });
    expect(rows[0]!.metadata).toEqual({ fromStatus: 'PENDING', toStatus: 'REJECTED', organizerId: org.userId, requestId, subjectUserId: p1.userId });
    expect(await participantStatus(matchId, p1.userId)).toBeUndefined();
  });

  it('no record when it is not an override: the organizer decides, or an admin decides on their OWN match', async () => {
    const mine = await newMatch(org);
    await decide(mine, await ask(mine, p1), 'accept', org);
    await decide(mine, await ask(mine, p2), 'reject', org);
    const adminOwn = await newMatch(admin);
    await decide(adminOwn, await ask(adminOwn, p1), 'accept', admin);
    await decide(adminOwn, await ask(adminOwn, p2), 'reject', admin);
    expect(await count()).toBe(0);
  });

  it('refused or failed decisions leave no record', async () => {
    const matchId = await newMatch();
    const requestId = await ask(matchId, p1);
    expect((await decide(matchId, requestId, 'accept', outsider)).status).toBe(403); // neither organizer nor admin
    expect((await decide(matchId, '00000000-0000-4000-8000-000000000000', 'accept', admin)).status).toBe(404);
    expect((await decide(matchId, requestId, 'accept', org)).status).toBe(200);
    expect(await count()).toBe(0);
    expect((await decide(matchId, requestId, 'accept', admin)).status).toBe(409); // already decided
    expect((await decide(matchId, requestId, 'reject', admin)).status).toBe(409);
    const other = await newMatch(org, { title: 'Another match' });
    expect((await decide(other, requestId, 'accept', admin)).status).toBe(404); // the request belongs to another match
    expect(await count()).toBe(0);
  });

  it('a match that is full refuses the acceptance, and the refused attempt leaves no record', async () => {
    const matchId = await newMatch(org, { capacity: 1 });
    const first = await ask(matchId, p1);
    const second = await ask(matchId, p2);
    await decide(matchId, first, 'accept', org);
    const res = await decide(matchId, second, 'accept', admin);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await count()).toBe(0);
    expect(await requestStatus(second)).toBe('PENDING');
  });

  it('rollback: if the decision fails after the record was written, the record rolls back with it', async () => {
    const matchId = await newMatch();
    const requestId = await ask(matchId, p1);
    await failWritesOn('notification', 'INSERT', async () => {
      expect((await decide(matchId, requestId, 'accept', admin)).status).toBe(500);
    });
    expect(await count()).toBe(0);
    expect(await requestStatus(requestId)).toBe('PENDING');
    expect(await participantStatus(matchId, p1.userId)).toBeUndefined();
  });

  it('rollback: if the record cannot be written, the decision is NOT applied', async () => {
    const matchId = await newMatch();
    const requestId = await ask(matchId, p1);
    await failWritesOn('admin_audit_log', 'INSERT', async () => {
      expect((await decide(matchId, requestId, 'accept', admin)).status).toBe(500);
    });
    expect(await requestStatus(requestId)).toBe('PENDING');
    expect(await participantStatus(matchId, p1.userId)).toBeUndefined();
    expect(await count()).toBe(0);
  });

  it('concurrency: an admin and the organizer decide the SAME request at once; the record exists if and only if the admin\'s decision is the final state', async () => {
    const prisma = await prismaP();
    for (let round = 0; round < 8; round++) {
      const matchId = await newMatch(org, { title: `Decision race ${round}`, startAt: new Date(Date.now() + (100 + round * 4) * 3_600_000).toISOString() });
      const requestId = await ask(matchId, p1);
      const [byAdmin, byOrganizer] = await Promise.all([decide(matchId, requestId, 'accept', admin), decide(matchId, requestId, 'reject', org)]);
      expect([byAdmin.status, byOrganizer.status].sort()).toEqual([200, 409]); // exactly one decision wins
      const finalStatus = await requestStatus(requestId);
      const audits = await prisma.adminAuditLog.count({ where: { targetId: matchId } });
      if (byAdmin.status === 200) {
        expect(finalStatus).toBe('ACCEPTED');
        expect(audits).toBe(1);
        expect(await participantStatus(matchId, p1.userId)).toBe('CONFIRMED');
      } else {
        expect(finalStatus).toBe('REJECTED');
        expect(audits).toBe(0); // the admin lost: nothing happened, nothing is recorded
        expect(await participantStatus(matchId, p1.userId)).toBeUndefined();
      }
    }
  });

  it('concurrency: two admins accept the same request at once; ONE record, one confirmed participant', async () => {
    const prisma = await prismaP();
    const admin2 = await makeUser(api, 'admin2@example.com');
    await prisma.user.update({ where: { id: admin2.userId }, data: { platformRole: 'ADMIN' } });
    for (let round = 0; round < 8; round++) {
      const matchId = await newMatch(org, { title: `Two admins ${round}`, startAt: new Date(Date.now() + (200 + round * 4) * 3_600_000).toISOString() });
      const requestId = await ask(matchId, p1);
      const [a, b] = await Promise.all([decide(matchId, requestId, 'accept', admin), decide(matchId, requestId, 'accept', admin2)]);
      expect([a.status, b.status]).toContain(200);
      expect(await requestStatus(requestId)).toBe('ACCEPTED');
      expect(await prisma.adminAuditLog.count({ where: { targetId: matchId } })).toBe(1);
      expect(await prisma.matchParticipant.count({ where: { matchId, status: 'CONFIRMED' } })).toBe(1);
    }
  });
});

// ───────────────────────────── participant removal ─────────────────────────────

describe('an admin removing a participant from another organizer\'s match', () => {
  const remove = (matchId: string, userId: string, by: TestUser) => api.call('DELETE', `${M}/${matchId}/participants/${userId}`, undefined, by.token);

  it('leaves exactly one record with minimal metadata', async () => {
    const matchId = await newMatch();
    await confirmed(matchId, p1);
    expect((await remove(matchId, p1.userId, admin)).status).toBe(204);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: admin.userId, action: 'PARTICIPANT_REMOVED_BY_ADMIN', targetType: 'MATCH', targetId: matchId });
    expect(rows[0]!.metadata).toEqual({ fromStatus: 'CONFIRMED', toStatus: 'REMOVED', organizerId: org.userId, subjectUserId: p1.userId });
    expect(await participantStatus(matchId, p1.userId)).toBe('REMOVED');
    noPersonalData(rows);
  });

  it('no record for the organizer, or for an admin on their own match', async () => {
    const mine = await newMatch(org);
    await confirmed(mine, p1);
    expect((await remove(mine, p1.userId, org)).status).toBe(204);
    const adminOwn = await newMatch(admin);
    await confirmed(adminOwn, p2, admin);
    expect((await remove(adminOwn, p2.userId, admin)).status).toBe(204);
    expect(await count()).toBe(0);
  });

  it('refused or no-op removals leave no record: not a participant, already removed, an outsider', async () => {
    const matchId = await newMatch();
    await confirmed(matchId, p1);
    expect((await remove(matchId, p2.userId, admin)).status).toBe(404); // never joined
    expect((await remove(matchId, p1.userId, outsider)).status).toBe(403);
    expect((await remove(matchId, p1.userId, org)).status).toBe(204);
    expect((await remove(matchId, p1.userId, admin)).status).toBe(404); // already removed: nothing to change
    expect(await count()).toBe(0);
  });

  it('rollback in both directions', async () => {
    const matchId = await newMatch();
    await confirmed(matchId, p1);
    await failWritesOn('notification', 'INSERT', async () => {
      expect((await remove(matchId, p1.userId, admin)).status).toBe(500);
    });
    expect(await count()).toBe(0);
    expect(await participantStatus(matchId, p1.userId)).toBe('CONFIRMED');
    await failWritesOn('admin_audit_log', 'INSERT', async () => {
      expect((await remove(matchId, p1.userId, admin)).status).toBe(500);
    });
    expect(await participantStatus(matchId, p1.userId)).toBe('CONFIRMED');
    expect(await count()).toBe(0);
  });
});

// ───────────────────────────── attendance and no-show ─────────────────────────────

describe('an admin marking attendance on another organizer\'s match', () => {
  const mark = (matchId: string, userId: string, status: string, by: TestUser) => api.call('PATCH', `${M}/${matchId}/participants/${userId}/attendance`, { status }, by.token);

  it('ATTENDED then NO_SHOW each leave one record with the status change', async () => {
    const matchId = await newMatch();
    await confirmed(matchId, p1);
    await start(matchId);
    expect((await mark(matchId, p1.userId, 'ATTENDED', admin)).status).toBe(200);
    expect((await mark(matchId, p1.userId, 'NO_SHOW', admin)).status).toBe(200);
    const rows = await records();
    expect(rows.map((r) => r.action)).toEqual(['PARTICIPANT_ATTENDED_BY_ADMIN', 'PARTICIPANT_NO_SHOW_BY_ADMIN']);
    expect(rows[0]).toMatchObject({ actorId: admin.userId, targetType: 'MATCH', targetId: matchId });
    expect(rows[0]!.metadata).toEqual({ fromStatus: 'UNKNOWN', toStatus: 'ATTENDED', organizerId: org.userId, subjectUserId: p1.userId });
    expect(rows[1]!.metadata).toEqual({ fromStatus: 'ATTENDED', toStatus: 'NO_SHOW', organizerId: org.userId, subjectUserId: p1.userId });
    noPersonalData(rows);
  });

  it('marking a player with the status they already have changes nothing and is not recorded', async () => {
    const matchId = await newMatch();
    await confirmed(matchId, p1);
    await start(matchId);
    await mark(matchId, p1.userId, 'NO_SHOW', admin);
    expect((await mark(matchId, p1.userId, 'NO_SHOW', admin)).status).toBe(200); // same as before: still answered, no new record
    expect(await count()).toBe(1);
  });

  it('the same status again by a DIFFERENT confirmer is a real change and is recorded; by the same confirmer it is a true no-op', async () => {
    const prisma = await prismaP();
    const confirmerOf = async (matchId: string) => (await prisma.matchParticipant.findUniqueOrThrow({ where: { matchId_userId: { matchId, userId: p1.userId } } })).attendanceConfirmedById;
    const matchId = await newMatch();
    await confirmed(matchId, p1);
    await start(matchId);

    await mark(matchId, p1.userId, 'NO_SHOW', org); // the organizer confirms: ordinary, nothing recorded
    expect(await count()).toBe(0);
    expect(await confirmerOf(matchId)).toBe(org.userId);

    await mark(matchId, p1.userId, 'NO_SHOW', admin); // same status, but the admin becomes the confirmer: recorded
    expect(await count()).toBe(1);
    expect(await confirmerOf(matchId)).toBe(admin.userId);
    expect((await records())[0]).toMatchObject({ actorId: admin.userId, action: 'PARTICIPANT_NO_SHOW_BY_ADMIN', targetId: matchId });
    expect((await records())[0]!.metadata).toEqual({ fromStatus: 'NO_SHOW', toStatus: 'NO_SHOW', organizerId: org.userId, subjectUserId: p1.userId });

    await mark(matchId, p1.userId, 'NO_SHOW', admin); // same status, same confirmer: nothing changes, nothing recorded
    expect(await count()).toBe(1);

    await mark(matchId, p1.userId, 'NO_SHOW', org); // the organizer takes the confirmation back: ordinary, nothing recorded
    expect(await count()).toBe(1);
    expect(await confirmerOf(matchId)).toBe(org.userId);
    await mark(matchId, p1.userId, 'NO_SHOW', admin); // and the admin overrides again: a new change
    expect(await count()).toBe(2);
  });

  it('no record for the organizer, or for an admin on their own match', async () => {
    const mine = await newMatch(org);
    await confirmed(mine, p1);
    await start(mine);
    await mark(mine, p1.userId, 'ATTENDED', org);
    await mark(mine, p1.userId, 'NO_SHOW', org);
    const adminOwn = await newMatch(admin);
    await confirmed(adminOwn, p2, admin);
    await start(adminOwn, admin);
    await mark(adminOwn, p2.userId, 'ATTENDED', admin);
    await mark(adminOwn, p2.userId, 'NO_SHOW', admin);
    expect(await count()).toBe(0);
  });

  it('refused or failed attempts leave no record: before the start, not a participant, an outsider, a bad status', async () => {
    const matchId = await newMatch();
    await confirmed(matchId, p1);
    const early = await mark(matchId, p1.userId, 'NO_SHOW', admin);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('ATTENDANCE_TOO_EARLY');
    await start(matchId);
    expect((await mark(matchId, p2.userId, 'ATTENDED', admin)).status).toBeGreaterThanOrEqual(400); // never joined
    expect((await mark(matchId, p1.userId, 'ATTENDED', outsider)).status).toBe(403);
    expect((await mark(matchId, p1.userId, 'MAYBE', admin)).status).toBe(400);
    expect(await count()).toBe(0);
    expect((await (await prismaP()).matchParticipant.findUniqueOrThrow({ where: { matchId_userId: { matchId, userId: p1.userId } } })).attendanceStatus).toBe('UNKNOWN');
  });

  it('rollback: if the record cannot be written, the attendance is NOT changed (the record is the last write, so there is no later step to fail)', async () => {
    const matchId = await newMatch();
    await confirmed(matchId, p1);
    await start(matchId);
    await failWritesOn('admin_audit_log', 'INSERT', async () => {
      expect((await mark(matchId, p1.userId, 'NO_SHOW', admin)).status).toBe(500);
    });
    expect(await count()).toBe(0);
    expect((await (await prismaP()).matchParticipant.findUniqueOrThrow({ where: { matchId_userId: { matchId, userId: p1.userId } } })).attendanceStatus).toBe('UNKNOWN');
  });
});

// ───────────────────────────── private invitations ─────────────────────────────

describe('an admin inviting a player to another organizer\'s match', () => {
  const invite = (matchId: string, userId: string, by: TestUser) => api.call('POST', `${M}/${matchId}/invitations`, { userId }, by.token);
  const invitation = async (matchId: string, inviteeId: string) => (await prismaP()).matchInvitation.findUnique({ where: { matchId_inviteeId: { matchId, inviteeId } } });

  it('a new invitation leaves exactly one record', async () => {
    const matchId = await newMatch(org, { visibility: 'PRIVATE' });
    expect((await invite(matchId, p1.userId, admin)).status).toBeLessThan(300);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: admin.userId, action: 'MATCH_INVITATION_SENT_BY_ADMIN', targetType: 'MATCH', targetId: matchId });
    expect(rows[0]!.metadata).toEqual({ fromStatus: null, toStatus: 'PENDING', organizerId: org.userId, subjectUserId: p1.userId });
    expect((await invitation(matchId, p1.userId))?.invitedById).toBe(admin.userId);
    noPersonalData(rows);
  });

  it('inviting again with nothing different is not a state change; a different inviter, or a declined invitation, is', async () => {
    const matchId = await newMatch(org, { visibility: 'PRIVATE' });
    await invite(matchId, p1.userId, admin);
    await invite(matchId, p1.userId, admin); // already pending, same inviter: nothing changed
    expect(await count()).toBe(1);

    await invite(matchId, p2.userId, org); // the organizer invites p2 (ordinary: no record)
    expect(await count()).toBe(1);
    await invite(matchId, p2.userId, admin); // the admin takes over the invitation: it changes
    expect(await count()).toBe(2);
    expect((await records())[1]!.metadata).toMatchObject({ fromStatus: 'PENDING', toStatus: 'PENDING', subjectUserId: p2.userId });

    await (await prismaP()).$executeRawUnsafe(`UPDATE match_invitation SET status = 'DECLINED' WHERE match_id = '${matchId}' AND invitee_id = '${p1.userId}'`);
    await invite(matchId, p1.userId, admin); // a declined invitation is renewed
    expect(await count()).toBe(3);
    expect((await records())[2]!.metadata).toMatchObject({ fromStatus: 'DECLINED', toStatus: 'PENDING' });
  });

  it('no record for the organizer, or for an admin on their own match', async () => {
    const mine = await newMatch(org, { visibility: 'PRIVATE' });
    await invite(mine, p1.userId, org);
    const adminOwn = await newMatch(admin, { visibility: 'PRIVATE' });
    await invite(adminOwn, p2.userId, admin);
    expect(await count()).toBe(0);
  });

  it('refused invitations leave no record: unknown player, the organizer, a cancelled match, an outsider', async () => {
    const matchId = await newMatch(org, { visibility: 'PRIVATE' });
    expect((await invite(matchId, '00000000-0000-4000-8000-000000000000', admin)).status).toBe(404);
    expect((await invite(matchId, org.userId, admin)).status).toBe(400);
    expect((await invite(matchId, p1.userId, outsider)).status).toBe(404); // a private match does not exist for an outsider
    await api.call('POST', `${M}/${matchId}/cancel`, {}, org.token);
    expect((await invite(matchId, p1.userId, admin)).status).toBe(409);
    expect(await count()).toBe(0);
    expect(await invitation(matchId, p1.userId)).toBeNull();
  });

  it('rollback in both directions', async () => {
    const matchId = await newMatch(org, { visibility: 'PRIVATE' });
    await failWritesOn('notification', 'INSERT', async () => {
      expect((await invite(matchId, p1.userId, admin)).status).toBe(500);
    });
    expect(await count()).toBe(0);
    expect(await invitation(matchId, p1.userId)).toBeNull();
    await failWritesOn('admin_audit_log', 'INSERT', async () => {
      expect((await invite(matchId, p1.userId, admin)).status).toBe(500);
    });
    expect(await invitation(matchId, p1.userId)).toBeNull();
    expect(await count()).toBe(0);
  });
});

// ───────────────────────────── booking release in the existing cancellation record ─────────────────────────────

describe('an admin cancelling a match: the released booking is named in the existing record', () => {
  let venueOwner: TestUser;
  let fieldId: string;
  beforeEach(async () => {
    venueOwner = await makeUser(api, 'venue-owner@example.com');
    ({ fieldId } = await setupVenue(api, venueOwner, cityId));
  });

  /** A CONFIRMED booking of the organizer and a match that uses it. */
  async function matchWithBooking(day: number) {
    const slot = localSlot(day, 18);
    const booking = (await api.call('POST', '/api/v1/bookings', { venueFieldId: fieldId, startAt: slot.toISOString(), durationMinutes: 120 }, org.token)).body.booking.id as string;
    expect((await api.call('POST', `/api/v1/bookings/${booking}/confirm`, {}, venueOwner.token)).status).toBe(200);
    const matchId = (await api.call('POST', M, matchBody({ startAt: slot.toISOString(), durationMinutes: 90, bookingId: booking }), org.token)).body.match.id as string;
    return { booking, matchId };
  }
  const bookingStatus = async (id: string) => (await (await prismaP()).booking.findUniqueOrThrow({ where: { id } })).status;
  const cancel = (matchId: string, by: TestUser, body: Record<string, unknown> = {}) => api.call('POST', `${M}/${matchId}/cancel`, body, by.token);

  it('with releaseBooking, the record carries the booking id and the booking is cancelled', async () => {
    const { booking, matchId } = await matchWithBooking(5);
    expect((await cancel(matchId, admin, { releaseBooking: true })).status).toBe(200);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'MATCH_CANCELLED_BY_ADMIN', targetId: matchId });
    expect(rows[0]!.metadata).toEqual({ fromStatus: 'OPEN', toStatus: 'CANCELLED', organizerId: org.userId, bookingId: booking });
    expect(await bookingStatus(booking)).toBe('CANCELLED');
  });

  it('without releaseBooking the record has no booking id and the booking is kept', async () => {
    const { booking, matchId } = await matchWithBooking(6);
    await cancel(matchId, admin);
    expect((await records())[0]!.metadata).toEqual({ fromStatus: 'OPEN', toStatus: 'CANCELLED', organizerId: org.userId });
    expect(await bookingStatus(booking)).toBe('CONFIRMED');
  });

  it('if the booking was NOT actually released (already cancelled, or the match has none), no booking id is recorded', async () => {
    const { booking, matchId } = await matchWithBooking(7);
    expect((await api.call('POST', `/api/v1/bookings/${booking}/cancel`, {}, org.token)).status).toBeLessThan(300); // the requester cancels it first
    await cancel(matchId, admin, { releaseBooking: true });
    const plain = await newMatch(org, { title: 'No booking at all' });
    await cancel(plain, admin, { releaseBooking: true });
    const rows = await records();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(Object.keys(r.metadata as object)).not.toContain('bookingId');
  });

  it('the organizer cancelling with releaseBooking creates no admin record, and an admin cancelling their own match neither', async () => {
    const { booking, matchId } = await matchWithBooking(8);
    await cancel(matchId, org, { releaseBooking: true });
    expect(await bookingStatus(booking)).toBe('CANCELLED');
    const adminOwn = await newMatch(admin);
    await cancel(adminOwn, admin, { releaseBooking: true });
    expect(await count()).toBe(0);
  });

  it('a failed cancellation leaves no record and keeps the booking', async () => {
    const { booking, matchId } = await matchWithBooking(9);
    await failWritesOn('match_event', 'INSERT', async () => {
      expect((await cancel(matchId, admin, { releaseBooking: true })).status).toBe(500);
    });
    expect(await count()).toBe(0);
    expect(await bookingStatus(booking)).toBe('CONFIRMED');
    expect((await (await prismaP()).match.findUniqueOrThrow({ where: { id: matchId } })).status).toBe('OPEN');
  });
});

// ───────────────────────────── the read endpoint still filters and paginates ─────────────────────────────

describe('GET /admin/audit-log with the new actions', () => {
  async function seedHistory() {
    const matchId = await newMatch();
    const r1 = await ask(matchId, p1);
    const r2 = await ask(matchId, p2);
    await decide(matchId, r1, 'accept', admin);
    await decide(matchId, r2, 'reject', admin);
    await api.call('DELETE', `${M}/${matchId}/participants/${p1.userId}`, undefined, admin.token);
    return matchId;
  }

  it('filters by each new action, by target and by actor, combined with the old filters', async () => {
    const matchId = await seedHistory();
    const get = async (qs: string) => (await api.call('GET', `${A}/audit-log?${qs}`, undefined, admin.token)).body;
    expect((await get('action=JOIN_REQUEST_ACCEPTED_BY_ADMIN')).total).toBe(1);
    expect((await get('action=JOIN_REQUEST_REJECTED_BY_ADMIN')).total).toBe(1);
    expect((await get('action=PARTICIPANT_REMOVED_BY_ADMIN')).total).toBe(1);
    for (const a of ['PARTICIPANT_ATTENDED_BY_ADMIN', 'PARTICIPANT_NO_SHOW_BY_ADMIN', 'MATCH_INVITATION_SENT_BY_ADMIN']) expect((await get(`action=${a}`)).total).toBe(0);
    const forMatch = await get(`targetType=MATCH&targetId=${matchId}`);
    expect(forMatch.total).toBe(3);
    expect(forMatch.entries.map((e: { action: string }) => e.action)).toEqual(['PARTICIPANT_REMOVED_BY_ADMIN', 'JOIN_REQUEST_REJECTED_BY_ADMIN', 'JOIN_REQUEST_ACCEPTED_BY_ADMIN']); // newest first
    expect((await get(`actorId=${admin.userId}&action=PARTICIPANT_REMOVED_BY_ADMIN`)).total).toBe(1);
    expect((await api.call('GET', `${A}/audit-log?action=NOT_AN_ACTION`, undefined, admin.token)).status).toBe(400);
  });

  it('paginates the new records without repeats', async () => {
    await seedHistory();
    const seen: string[] = [];
    for (const page of [1, 2]) {
      const res = await api.call('GET', `${A}/audit-log?targetType=MATCH&pageSize=2&page=${page}`, undefined, admin.token);
      expect(res.body.total).toBe(3);
      seen.push(...res.body.entries.map((e: { id: string }) => e.id));
    }
    expect(new Set(seen).size).toBe(3);
  });

  it('the records stay append-only: the new actions cannot be updated or deleted either', async () => {
    await seedHistory();
    const prisma = await prismaP();
    const [row] = await records();
    await expect(prisma.adminAuditLog.update({ where: { id: row!.id }, data: { reason: 'edited' } })).rejects.toThrow(/FYM_AUDIT_IMMUTABLE/);
    await expect(prisma.adminAuditLog.deleteMany({})).rejects.toThrow(/FYM_AUDIT_IMMUTABLE/);
  });
});

// ───────────────────────────── a change is announced once ─────────────────────────────

describe('notifications follow real changes only', () => {
  const notifications = async (userId: string, type: string, matchId: string) => (await prismaP()).notification.count({ where: { userId, type, resourceId: matchId } });
  const invite = (matchId: string, userId: string, by: TestUser) => api.call('POST', `${M}/${matchId}/invitations`, { userId }, by.token);

  describe('invitations', () => {
    it('inviting again with nothing different sends no second notification (organizer and admin alike)', async () => {
      const matchId = await newMatch(org, { visibility: 'PRIVATE' });
      expect((await invite(matchId, p1.userId, org)).status).toBeLessThan(300);
      expect((await invite(matchId, p1.userId, org)).status).toBeLessThan(300);
      expect((await invite(matchId, p1.userId, org)).status).toBeLessThan(300);
      expect(await notifications(p1.userId, 'MATCH_INVITATION', matchId)).toBe(1);

      expect((await invite(matchId, p2.userId, admin)).status).toBeLessThan(300);
      expect((await invite(matchId, p2.userId, admin)).status).toBeLessThan(300);
      expect(await notifications(p2.userId, 'MATCH_INVITATION', matchId)).toBe(1);
      expect(await count()).toBe(1); // and one audit record, for the admin's real invitation
    });

    it('a genuinely new or changed invitation is still announced: a different inviter, or a renewed (declined or expired) one', async () => {
      const prisma = await prismaP();
      const matchId = await newMatch(org, { visibility: 'PRIVATE' });
      await invite(matchId, p1.userId, org);
      await invite(matchId, p1.userId, admin); // the admin takes the invitation over: a change
      expect(await notifications(p1.userId, 'MATCH_INVITATION', matchId)).toBe(2);

      await prisma.$executeRawUnsafe(`UPDATE match_invitation SET status = 'DECLINED' WHERE match_id = '${matchId}' AND invitee_id = '${p1.userId}'`);
      await invite(matchId, p1.userId, admin); // renewed after a decline: a change
      expect(await notifications(p1.userId, 'MATCH_INVITATION', matchId)).toBe(3);
      expect((await prisma.matchInvitation.findUniqueOrThrow({ where: { matchId_inviteeId: { matchId, inviteeId: p1.userId } } })).status).toBe('PENDING');

      await prisma.$executeRawUnsafe(`UPDATE match_invitation SET status = 'EXPIRED' WHERE match_id = '${matchId}' AND invitee_id = '${p1.userId}'`);
      await invite(matchId, p1.userId, admin); // renewed after expiry: a change
      expect(await notifications(p1.userId, 'MATCH_INVITATION', matchId)).toBe(4);
    });

    it('simultaneous identical invitations announce once', async () => {
      for (let round = 0; round < 6; round++) {
        const matchId = await newMatch(org, { visibility: 'PRIVATE', title: `Invite race ${round}`, startAt: new Date(Date.now() + (300 + round * 4) * 3_600_000).toISOString() });
        const results = await Promise.all([invite(matchId, p1.userId, admin), invite(matchId, p1.userId, admin), invite(matchId, p1.userId, admin)]);
        expect(results.every((r) => r.status < 300)).toBe(true);
        expect(await notifications(p1.userId, 'MATCH_INVITATION', matchId)).toBe(1);
        expect(await (await prismaP()).adminAuditLog.count({ where: { targetId: matchId } })).toBe(1);
      }
    });
  });

  describe('join request decisions', () => {
    it('two simultaneous acceptances (admin + admin, or organizer three times) tell the player once; the same for rejections', async () => {
      const prisma = await prismaP();
      const admin2 = await makeUser(api, 'admin2@example.com');
      await prisma.user.update({ where: { id: admin2.userId }, data: { platformRole: 'ADMIN' } });
      for (let round = 0; round < 6; round++) {
        const startAt = (offset: number) => new Date(Date.now() + (400 + round * 8 + offset) * 3_600_000).toISOString();
        const a = await newMatch(org, { title: `Accept race A ${round}`, startAt: startAt(0) });
        const ra = await ask(a, p1);
        await Promise.all([decide(a, ra, 'accept', admin), decide(a, ra, 'accept', admin2)]);
        expect(await notifications(p1.userId, 'MATCH_REQUEST_ACCEPTED', a)).toBe(1);

        const b = await newMatch(org, { title: `Accept race B ${round}`, startAt: startAt(4) });
        const rb = await ask(b, p1);
        await Promise.all([decide(b, rb, 'accept', org), decide(b, rb, 'accept', org), decide(b, rb, 'accept', org)]);
        expect(await notifications(p1.userId, 'MATCH_REQUEST_ACCEPTED', b)).toBe(1);
        expect(await prisma.matchParticipant.count({ where: { matchId: b, status: 'CONFIRMED' } })).toBe(1);

        const c = await newMatch(org, { title: `Reject race ${round}`, startAt: startAt(2) });
        const rc = await ask(c, p2);
        await Promise.all([decide(c, rc, 'reject', org), decide(c, rc, 'reject', admin)]);
        expect(await notifications(p2.userId, 'MATCH_REQUEST_REJECTED', c)).toBe(1);
      }
    });

    it('an admin accepting while the organizer rejects: exactly one decision wins and exactly one notification matches it', async () => {
      for (let round = 0; round < 6; round++) {
        const matchId = await newMatch(org, { title: `Opposite race ${round}`, startAt: new Date(Date.now() + (500 + round * 4) * 3_600_000).toISOString() });
        const requestId = await ask(matchId, p1);
        await Promise.all([decide(matchId, requestId, 'accept', admin), decide(matchId, requestId, 'reject', org)]);
        const final = await requestStatus(requestId);
        const accepted = await notifications(p1.userId, 'MATCH_REQUEST_ACCEPTED', matchId);
        const rejected = await notifications(p1.userId, 'MATCH_REQUEST_REJECTED', matchId);
        expect(accepted + rejected).toBe(1);
        expect(final === 'ACCEPTED' ? accepted : rejected).toBe(1);
      }
    });

    it('an ordinary single decision still notifies exactly once', async () => {
      const matchId = await newMatch();
      const r = await ask(matchId, p1);
      expect((await decide(matchId, r, 'accept', org)).status).toBe(200);
      expect(await notifications(p1.userId, 'MATCH_REQUEST_ACCEPTED', matchId)).toBe(1);
    });
  });
});
