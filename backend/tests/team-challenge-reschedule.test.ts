import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { acceptChallenge, challenge, makeTeam, T, transferCaptaincy, type Team } from './helpers/teams';
import { inHours, makeUser, type TestUser } from './helpers/users';
import { localSlot, plusMinutes, setupVenue } from './helpers/venues';

let api: Awaited<ReturnType<typeof startApp>>;
let A: Team;
let B: Team;
let admin: TestUser;
let outsider: TestUser;
let matchId: string;

const M = '/api/v1/matches';
const prismaP = async () => (await import('../src/lib/prisma')).prisma;
const reschedule = (by: TestUser, body: Record<string, unknown>) => api.call('PATCH', `${M}/${matchId}`, body, by.token);
const matchRow = async () => (await prismaP()).match.findUniqueOrThrow({ where: { id: matchId } });
const timeNotifications = async (userId: string) => (await prismaP()).notification.count({ where: { userId, type: 'MATCH_TIME_CHANGED', resourceId: matchId } });
const addToRoster = (team: Team, by: TestUser, user: TestUser) => api.call('POST', `${T}/${team.teamId}/matches/${matchId}/roster`, { userId: user.userId }, by.token);

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
  A = await makeTeam(api, 'a');
  B = await makeTeam(api, 'b');
  admin = await makeUser(api, 'admin@example.com');
  await (await prismaP()).user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
  outsider = await makeUser(api, 'outsider@example.com');
  const c = await challenge(api, A, A.captain, B);
  matchId = (await acceptChallenge(api, c.body.challenge.id, B.captain)).body.match.id as string;
});

const later = (hours: number) => inHours(hours);

describe('rescheduling a team match (D12 + D19)', () => {
  it('the organizer reschedules while both rosters are empty: the time moves, the status stays SCHEDULED, both teams\' captain and vice captain are told (never the organizer, never plain members)', async () => {
    const before = await matchRow();
    const newStart = later(100);
    const res = await reschedule(A.captain, { startAt: newStart });
    expect(res.status).toBe(200);
    const after = await matchRow();
    expect(after.startAt.toISOString()).toBe(new Date(newStart).toISOString());
    expect(after.endAt.getTime() - after.startAt.getTime()).toBe(before.endAt.getTime() - before.startAt.getTime()); // the duration is kept
    expect(after.status).toBe('SCHEDULED');
    expect(after.organizerId).toBe(A.captain.userId);

    for (const u of [A.vice, B.captain, B.vice]) expect(await timeNotifications(u.userId)).toBe(1);
    for (const u of [A.captain, A.members[2]!, B.members[3]!, outsider]) expect(await timeNotifications(u.userId)).toBe(0);
    const note = await (await prismaP()).notification.findFirstOrThrow({ where: { userId: B.captain.userId, type: 'MATCH_TIME_CHANGED' } });
    expect(JSON.stringify(note.params)).toContain(new Date(newStart).toISOString());
  });

  it('editing only the title, description or notes is allowed and tells nobody (the time did not change)', async () => {
    const res = await reschedule(A.captain, { title: 'Friday derby', description: 'Bring bibs', notes: 'Gate 2' });
    expect(res.status).toBe(200);
    expect(await matchRow()).toMatchObject({ title: 'Friday derby', description: 'Bring bibs', notes: 'Gate 2' });
    for (const u of [A.vice, B.captain, B.vice]) expect(await timeNotifications(u.userId)).toBe(0);
  });

  it('only the recorded organizer: neither captain nor vice captain of either team gets organizer rights from their role; an admin keeps the audited override', async () => {
    expect((await transferCaptaincy(api, A, A.captain, A.vice)).status).toBe(200); // A1 is the captain of A now, A0 is still the organizer
    const start = (await matchRow()).startAt.toISOString();
    for (const who of [A.vice, B.captain, B.vice, A.members[3]!, outsider]) {
      const res = await reschedule(who, { startAt: later(120) });
      expect(res.status, who.email).toBe(403);
    }
    expect((await matchRow()).startAt.toISOString()).toBe(start);

    expect((await reschedule(A.captain, { startAt: later(110) })).status).toBe(200); // the organizer, who is no longer captain
    const adminRes = await reschedule(admin, { startAt: later(130) });
    expect(adminRes.status).toBe(200);
    const audit = await (await prismaP()).adminAuditLog.findMany({ where: { targetId: matchId } });
    expect(audit.map((a) => a.action)).toEqual(['MATCH_EDITED_BY_ADMIN']); // only the admin's edit is recorded
  });

  it('refused while EITHER roster has a confirmed player (D12): 409, nothing changes, nobody is told, the roster is untouched; allowed again once it is emptied', async () => {
    const prisma = await prismaP();
    const start = (await matchRow()).startAt.toISOString();
    expect((await addToRoster(B, B.vice, B.members[3]!)).status).toBe(201); // only the opposing team has picked a player
    const rosterBefore = await prisma.matchParticipant.findMany({ where: { matchId }, orderBy: { id: 'asc' } });

    const refused = await reschedule(A.captain, { startAt: later(100) });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('MATCH_TIME_LOCKED');
    expect((await matchRow()).startAt.toISOString()).toBe(start);
    expect(await prisma.matchParticipant.findMany({ where: { matchId }, orderBy: { id: 'asc' } })).toEqual(rosterBefore); // not silently changed
    for (const u of [A.vice, B.captain, B.vice]) expect(await timeNotifications(u.userId)).toBe(0);

    // the organizer's own team as well
    expect((await addToRoster(A, A.vice, A.members[2]!)).status).toBe(201);
    expect((await reschedule(A.captain, { startAt: later(101) })).status).toBe(409);
    // changing title / notes does not touch the time and is still fine with rosters filled
    expect((await reschedule(A.captain, { title: 'Still editable' })).status).toBe(200);

    // roster emptied by the teams themselves (the D12 way out is cancelling; here the captains remove their players)
    expect((await api.call('DELETE', `${T}/${B.teamId}/matches/${matchId}/roster/${B.members[3]!.userId}`, undefined, B.vice.token)).status).toBeLessThan(300);
    expect((await api.call('DELETE', `${T}/${A.teamId}/matches/${matchId}/roster/${A.members[2]!.userId}`, undefined, A.vice.token)).status).toBeLessThan(300);
    expect((await reschedule(A.captain, { startAt: later(102) })).status).toBe(200);
    // the (removed) roster rows still exist exactly as the captains left them
    expect(await prisma.matchParticipant.count({ where: { matchId, status: 'CONFIRMED' } })).toBe(0);
    expect(await prisma.matchParticipant.count({ where: { matchId } })).toBe(2);
  });

  it('rejects a time in the past, a match that is cancelled, and every field a team match does not have', async () => {
    const prisma = await prismaP();
    expect((await reschedule(A.captain, { startAt: new Date(Date.now() - 3_600_000).toISOString() })).status).toBeGreaterThanOrEqual(400);
    for (const body of [{ capacity: 4 }, { requiredSkillLevel: 'ADVANCED' }, { pricePerPlayer: 10 }, { locationName: 'Somewhere' }, { bookingId: null }, { requiredPositions: [{ position: 'GOALKEEPER', count: 1 }] }]) {
      const res = await reschedule(A.captain, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('NOT_EDITABLE_FOR_TEAM_MATCH');
    }
    expect((await matchRow()).capacity).toBeNull();
    expect((await api.call('POST', `${M}/${matchId}/cancel`, {}, A.captain.token)).status).toBe(200);
    const res = await reschedule(A.captain, { startAt: later(100) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
    expect(await prisma.notification.count({ where: { type: 'MATCH_TIME_CHANGED' } })).toBe(0);
  });

  it('a started team match cannot be rescheduled', async () => {
    const { moveMatchTime } = await import('./helpers/users');
    await moveMatchTime(matchId, -1, 1);
    const res = await reschedule(A.captain, { startAt: later(100) });
    expect(res.status).toBe(409);
  });

  it('bookings stay independent: a booking linked to the match keeps its own status and times, and the match may only move inside it', async () => {
    const prisma = await prismaP();
    const venueOwner = await makeUser(api, 'venue-owner@example.com');
    const city = await prisma.city.create({ data: { nameAr: 'الخليل', nameEn: 'Hebron' } });
    const { fieldId } = await setupVenue(api, venueOwner, city.id);
    const bookingStart = localSlot(6, 18);
    const booked = await api.call('POST', '/api/v1/bookings', { venueFieldId: fieldId, startAt: bookingStart.toISOString(), endAt: plusMinutes(bookingStart, 120).toISOString() }, A.captain.token);
    expect(booked.status).toBe(201);
    const bookingId = booked.body.booking.id as string;
    expect((await api.call('POST', `/api/v1/bookings/${bookingId}/confirm`, undefined, venueOwner.token)).status).toBe(200);

    // put the match inside the booked window and link them (the way a link is made today for matches is not available for team matches, so the row is linked directly)
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRawUnsafe(`UPDATE "match" SET start_at = '${bookingStart.toISOString()}', end_at = '${plusMinutes(bookingStart, 90).toISOString()}', booking_id = '${bookingId}' WHERE id = '${matchId}'`);
    });
    const bookingBefore = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });

    const outside = await reschedule(A.captain, { startAt: plusMinutes(bookingStart, 90).toISOString(), durationMinutes: 90 }); // ends after the booking
    expect(outside.status).toBe(400);
    expect(outside.body.error.code).toBe('MATCH_OUTSIDE_BOOKING');
    const inside = await reschedule(A.captain, { startAt: plusMinutes(bookingStart, 15).toISOString() });
    expect(inside.status).toBe(200);
    expect((await matchRow()).startAt.toISOString()).toBe(plusMinutes(bookingStart, 15).toISOString());

    const bookingAfter = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(bookingAfter).toEqual(bookingBefore); // the booking was not touched by the reschedule
  });

  it('a reschedule racing a roster pick never produces an error or a half-state: either it wins, or the pick came first and it is refused', async () => {
    const prisma = await prismaP();
    const start = (await matchRow()).startAt.toISOString();
    const [moved, picked] = await Promise.all([reschedule(A.captain, { startAt: later(150) }), addToRoster(A, A.vice, A.members[2]!)]);
    expect([200, 409]).toContain(moved.status);
    expect(picked.status).toBe(201);
    const confirmed = await prisma.matchParticipant.count({ where: { matchId, status: 'CONFIRMED' } });
    expect(confirmed).toBe(1);
    const now = (await matchRow()).startAt.toISOString();
    expect(moved.status === 200 ? now !== start : now === start).toBe(true); // the response matches what happened
  });
});
