import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/lib/crypto';
import { verifyPassword } from '../src/lib/password';
import { resetDb, startApp } from './helpers/client';
import { addDevice, addNotification } from './helpers/push';
import { acceptChallenge, challenge, makeTeam, T } from './helpers/teams';
import { inHours, makeUser, matchBody, PASSWORD, type TestUser } from './helpers/users';
import { localSlot, plusMinutes, setupVenue } from './helpers/venues';

let api: Awaited<ReturnType<typeof startApp>>;
let cityId: string;
let admin: TestUser;

const U = '/api/v1/users/me';
const M = '/api/v1/matches';
const B = '/api/v1/bookings';
const V = '/api/v1/venues';
const prismaP = async () => (await import('../src/lib/prisma')).prisma;
const preview = (u: TestUser) => api.call('GET', `${U}/deletion-blockers`, undefined, u.token);
const remove = (u: TestUser, password = PASSWORD) => api.call('POST', `${U}/delete`, { password }, u.token);
const codes = (res: { body: { blockers?: { code: string }[] } }) => (res.body.blockers ?? []).map((b) => b.code).sort();
/** Raw statements with triggers off for the transaction: how a test puts a row into a state the API would not allow directly. */
async function raw(...statements: string[]) {
  const prisma = await prismaP();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    for (const s of statements) await tx.$executeRawUnsafe(s);
  });
}

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
});

const newMatch = async (by: TestUser, over: Record<string, unknown> = {}) => (await api.call('POST', M, matchBody(over), by.token)).body.match.id as string;
const bookSlot = async (by: TestUser, fieldId: string, day: number, hour = 18) => {
  const res = await api.call('POST', B, { venueFieldId: fieldId, startAt: localSlot(day, hour).toISOString(), durationMinutes: 60 }, by.token);
  expect(res.status).toBe(201);
  return res.body.booking.id as string;
};
const confirmBooking = async (by: TestUser, id: string) => expect((await api.call('POST', `${B}/${id}/confirm`, {}, by.token)).status).toBe(200);

// ───────────────────────────── blockers ─────────────────────────────

describe('what blocks deletion (D18, A1, A5): the preview and the deletion agree', () => {
  it('a clean account can be deleted; the endpoints need authentication', async () => {
    const u = await makeUser(api, 'clean@example.com');
    expect((await preview(u)).body).toEqual({ canDelete: true, blockers: [] });
    expect((await api.call('GET', `${U}/deletion-blockers`)).status).toBe(401);
    expect((await api.call('POST', `${U}/delete`, { password: PASSWORD })).status).toBe(401);
  });

  it('A1: upcoming matches block (OPEN, FULL, SCHEDULED, IN_PROGRESS, CLOSED_UNCONFIRMED in its 7-day window); COMPLETED, CANCELLED and an expired window do not; a started match must be COMPLETED, not cancelled', async () => {
    const org = await makeUser(api, 'org@example.com');
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push(await newMatch(org, { title: `Organized game ${i}`, startAt: inHours(24 * (i + 3)) }));
    const [open, full, scheduled, running, started, recoverable, expired, completed, cancelled] = ids as [string, string, string, string, string, string, string, string, string];
    await raw(
      `UPDATE "match" SET status = 'FULL' WHERE id = '${full}'`,
      `UPDATE "match" SET type = 'TEAM_CHALLENGE', capacity = NULL, status = 'SCHEDULED' WHERE id = '${scheduled}'`, // SCHEDULED exists only for team matches
      `UPDATE "match" SET status = 'IN_PROGRESS' WHERE id = '${running}'`,
      `UPDATE "match" SET start_at = now() - interval '2 hours', end_at = now() - interval '30 minutes' WHERE id = '${started}'`, // past its start, still OPEN
      `UPDATE "match" SET status = 'CLOSED_UNCONFIRMED', closed_unconfirmed_at = now() - interval '2 days' WHERE id = '${recoverable}'`,
      `UPDATE "match" SET status = 'CLOSED_UNCONFIRMED', closed_unconfirmed_at = now() - interval '8 days' WHERE id = '${expired}'`,
      `UPDATE "match" SET status = 'COMPLETED', completed_at = now() WHERE id = '${completed}'`,
      `UPDATE "match" SET status = 'CANCELLED', cancelled_at = now() WHERE id = '${cancelled}'`,
    );

    const res = await preview(org);
    expect(res.status).toBe(200);
    expect(res.body.canDelete).toBe(false);
    expect(codes(res)).toEqual(['ORGANIZES_UPCOMING_MATCHES']);
    const blocker = res.body.blockers[0];
    expect(blocker.count).toBe(6);
    expect(new Set(blocker.resourceIds)).toEqual(new Set([open, full, scheduled, running, started, recoverable]));
    const action = (id: string) => blocker.items.find((i: { id: string }) => i.id === id).action;
    expect([open, full, scheduled].map(action)).toEqual(['cancel', 'cancel', 'cancel']);
    expect([running, started].map(action)).toEqual(['complete', 'complete']); // a started match cannot be cancelled by its organizer
    expect(action(recoverable)).toBe('cancel_or_complete');
    expect(blocker.resolution).toMatch(/cancel/i);

    // the resolution the response names really works
    expect((await api.call('POST', `${M}/${open}/cancel`, {}, org.token)).status).toBe(200);
    expect((await api.call('POST', `${M}/${started}/cancel`, {}, org.token)).status).toBe(409); // as announced: it must be completed
    expect((await api.call('POST', `${M}/${started}/complete`, undefined, org.token)).status).toBe(200);
    expect((await preview(org)).body.blockers[0].count).toBe(4);
  });

  it('teams: a captain with other members, and a member or vice captain, block; a sole captain does not (A3)', async () => {
    const A = await makeTeam(api, 'a');
    expect(codes(await preview(A.captain))).toEqual(['CAPTAINS_TEAM_WITH_MEMBERS']);
    expect((await preview(A.captain)).body.blockers[0].resourceIds).toEqual([A.teamId]);
    for (const who of [A.vice, A.members[3]!]) {
      const res = await preview(who);
      expect(codes(res)).toEqual(['TEAM_MEMBERSHIP']);
      expect(res.body.blockers[0]).toMatchObject({ count: 1, resourceIds: [A.teamId] });
    }
    const solo = await makeUser(api, 'solo@example.com');
    expect((await api.call('POST', T, { name: 'Solo team' }, solo.token)).status).toBe(201);
    expect((await preview(solo)).body.canDelete).toBe(true);
  });

  it('A5: an ACTIVE venue blocks, INACTIVE and SUSPENDED do not; future pending, confirmed and block entries of owned venues each block separately; expired holds, started bookings and EXTERNAL bookings do not', async () => {
    const prisma = await prismaP();
    const owner = await makeUser(api, 'owner@example.com');
    const player = await makeUser(api, 'player@example.com');
    const { venueId, fieldId } = await setupVenue(api, owner, cityId);
    expect(codes(await preview(owner))).toEqual(['OWNS_ACTIVE_VENUES']);
    expect((await preview(owner)).body.blockers[0].resourceIds).toEqual([venueId]);

    const pending = await bookSlot(player, fieldId, 5);
    const confirmed = await bookSlot(player, fieldId, 6);
    await confirmBooking(owner, confirmed);
    const expiredHold = await bookSlot(player, fieldId, 7);
    const started = await bookSlot(player, fieldId, 8);
    await confirmBooking(owner, started);
    const blockStart = localSlot(9, 10);
    const block = await api.call('POST', `/api/v1/fields/${fieldId}/blocks`, { startAt: blockStart.toISOString(), endAt: plusMinutes(blockStart, 60).toISOString(), reason: 'OFFLINE_BOOKING' }, owner.token);
    expect(block.status).toBe(201);
    // an owner-side external booking record by someone else: self-reported, reserves nothing, never a blocker
    const ext = await api.call('POST', `${B}/external`, { extVenueName: 'Some pitch', startAt: localSlot(5, 20).toISOString(), endAt: plusMinutes(localSlot(5, 20), 60).toISOString(), totalPrice: 0, currency: 'ILS' }, owner.token);
    expect(ext.status).toBe(201);
    await raw(
      `UPDATE booking SET hold_expires_at = now() - interval '1 minute' WHERE id = '${expiredHold}'`,
      `UPDATE booking SET start_at = now() - interval '3 hours', end_at = now() - interval '2 hours', time_range = tstzrange(now() - interval '3 hours', now() - interval '2 hours', '[)') WHERE id = '${started}'`,
    );

    // while ACTIVE: the venue blocks together with its bookings and block
    expect(codes(await preview(owner))).toEqual(['OWNS_ACTIVE_VENUES', 'VENUE_FUTURE_BLOCKS', 'VENUE_FUTURE_CONFIRMED_BOOKINGS', 'VENUE_FUTURE_PENDING_BOOKINGS']);

    // deactivated (INACTIVE): the venue no longer blocks, the future bookings and the block still do
    expect((await api.call('PATCH', `${V}/${venueId}`, { status: 'INACTIVE' }, owner.token)).status).toBe(200);
    const res = await preview(owner);
    expect(codes(res)).toEqual(['VENUE_FUTURE_BLOCKS', 'VENUE_FUTURE_CONFIRMED_BOOKINGS', 'VENUE_FUTURE_PENDING_BOOKINGS']);
    const by = (code: string) => res.body.blockers.find((b: { code: string }) => b.code === code);
    expect(by('VENUE_FUTURE_PENDING_BOOKINGS')).toMatchObject({ count: 1, resourceIds: [pending] }); // not the expired hold
    expect(by('VENUE_FUTURE_CONFIRMED_BOOKINGS')).toMatchObject({ count: 1, resourceIds: [confirmed] }); // not the one that already started
    expect(by('VENUE_FUTURE_BLOCKS')).toMatchObject({ count: 1, resourceIds: [block.body.blocks[0].id] });

    // resolve them with the existing endpoints; SUSPENDED counts as deactivated as well
    expect((await api.call('POST', `${B}/${pending}/reject`, {}, owner.token)).status).toBe(200);
    expect((await api.call('POST', `${B}/${confirmed}/cancel`, {}, owner.token)).status).toBe(200);
    expect((await api.call('DELETE', `/api/v1/blocks/${block.body.blocks[0].id}`, undefined, owner.token)).status).toBe(204);
    expect((await preview(owner)).body.canDelete).toBe(true);
    await prisma.venue.update({ where: { id: venueId }, data: { status: 'SUSPENDED' } });
    expect((await preview(owner)).body.canDelete).toBe(true);
    // the EXTERNAL booking is untouched by all of it
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: ext.body.booking.id } })).status).toBe('CONFIRMED');
  });

  it('several blockers at once are all returned, and the deletion refuses with exactly what the preview showed, changing nothing', async () => {
    const prisma = await prismaP();
    const owner = await makeUser(api, 'owner@example.com');
    await setupVenue(api, owner, cityId);
    const matchId = await newMatch(owner);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });

    const pre = await preview(owner);
    expect(codes(pre)).toEqual(['ORGANIZES_UPCOMING_MATCHES', 'OWNS_ACTIVE_VENUES']);
    const res = await remove(owner);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_DELETION_BLOCKED');
    expect(res.body.error.details.blockers).toEqual(pre.body.blockers);
    expect(res.body.error.details.blockers[0].resourceIds).toContain(matchId);

    expect(await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } })).toEqual(before); // nothing changed
    expect(await prisma.adminAuditLog.count({ where: { action: 'ACCOUNT_DELETED' } })).toBe(0);
    expect((await api.call('GET', '/api/v1/users/me', undefined, owner.token)).status).toBe(200); // still signed in
  });

  it('an administrator cannot delete their account (403 ADMIN_CANNOT_DELETE, before the password is even checked); a wrong password is refused and changes nothing', async () => {
    expect((await preview(admin)).body.error.code).toBe('ADMIN_CANNOT_DELETE');
    const res = await remove(admin, 'wrong password');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_CANNOT_DELETE');

    const u = await makeUser(api, 'user@example.com');
    const wrong = await remove(u, 'not the password');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('WRONG_PASSWORD');
    expect((await api.call('POST', `${U}/delete`, {}, u.token)).status).toBe(400); // validation: the password is required
    const prisma = await prismaP();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.userId } })).status).toBe('ACTIVE');
  });
});

// ───────────────────────────── a successful deletion ─────────────────────────────

describe('a successful deletion: cleanup, anonymization in place, history kept', () => {
  it('does everything D18 / A2 / A4 / A6 / A7 describe, in one go', async () => {
    const prisma = await prismaP();
    const owner = await makeUser(api, 'venue-owner@example.com'); // owns the venue U works at and books
    const host = await makeUser(api, 'host@example.com'); // organizes the matches U joins
    const friend = await makeUser(api, 'friend@example.com');
    const u = await makeUser(api, 'leaver@example.com');
    const { venueId, fieldId } = await setupVenue(api, owner, cityId);

    // U's join requests: one pending (withdrawn), one accepted (kept)
    const m1 = await newMatch(host, { title: 'Pending request game', startAt: inHours(80) });
    const m2 = await newMatch(host, { title: 'Accepted game', startAt: inHours(100) });
    const r1 = (await api.call('POST', `${M}/${m1}/requests`, {}, u.token)).body.request.id as string;
    const r2 = (await api.call('POST', `${M}/${m2}/requests`, {}, u.token)).body.request.id as string;
    expect((await api.call('POST', `${M}/${m2}/requests/${r2}/accept`, {}, host.token)).status).toBe(200);
    // invitations addressed to U
    const privateMatch = await newMatch(host, { title: 'Private game', visibility: 'PRIVATE', startAt: inHours(120) });
    expect((await api.call('POST', `${M}/${privateMatch}/invitations`, { userId: u.userId }, host.token)).status).toBeLessThan(300);
    const teamOwner = await makeUser(api, 'team-owner@example.com');
    const team = (await api.call('POST', T, { name: 'Inviting team' }, teamOwner.token)).body.team.id as string;
    expect((await api.call('POST', `${T}/${team}/invitations`, { userId: u.userId }, teamOwner.token)).status).toBe(201);
    // U's own bookings: pending + confirmed (cancelled), external (untouched); U works as staff at the venue
    const b1 = await bookSlot(u, fieldId, 5);
    const b2 = await bookSlot(u, fieldId, 6);
    await confirmBooking(owner, b2);
    const ext = (await api.call('POST', `${B}/external`, { extVenueName: 'Elsewhere', startAt: localSlot(7, 20).toISOString(), endAt: plusMinutes(localSlot(7, 20), 60).toISOString(), totalPrice: 10, currency: 'ILS' }, u.token)).body.booking.id as string;
    expect((await api.call('POST', `${V}/${venueId}/staff`, { userId: u.userId, role: 'STAFF' }, owner.token)).status).toBe(201);
    // chat, report, favourite, blocks, devices, tokens, a review, a notification with a delivery
    const dm = await api.call('POST', '/api/v1/chats/direct', { userId: host.userId }, u.token);
    expect(dm.status).toBe(200);
    const chatId = dm.body.conversationId as string;
    expect((await api.call('POST', `/api/v1/chats/${chatId}/messages`, { body: 'See you at the match, call me +970591234567' }, u.token)).status).toBe(201);
    expect((await api.call('POST', '/api/v1/reports', { targetType: 'USER', targetId: host.userId, reason: 'OTHER', details: 'personal details I typed' }, u.token)).status).toBe(201);
    expect((await api.call('POST', '/api/v1/users/me/blocks', { userId: friend.userId }, u.token)).status).toBeLessThan(300);
    expect((await api.call('POST', '/api/v1/users/me/blocks', { userId: u.userId }, friend.token)).status).toBeLessThan(300);
    await prisma.favorite.create({ data: { userId: u.userId, targetType: 'VENUE', targetId: venueId } });
    const device = await addDevice(u.userId);
    const note = await addNotification(u.userId, 'MATCH_INVITATION');
    await prisma.pushDelivery.create({ data: { notificationId: note.id, userId: u.userId, deviceTokenId: device.id, expoToken: device.token } });
    const resetToken = 'reset-token-for-the-deleted-account';
    await prisma.userToken.create({ data: { userId: u.userId, type: 'PASSWORD_RESET', tokenHash: sha256(resetToken), expiresAt: new Date(Date.now() + 3_600_000) } });
    await raw(
      `INSERT INTO review (match_id, reviewer_id, reviewed_id, sportsmanship_score, skill_score, reliability_score, comment) VALUES ('${m2}', '${u.userId}', '${host.userId}', 5, 4, 5, 'great organizer, call me')`,
    );
    const login = await api.call('POST', '/api/v1/auth/login', { email: u.email, password: PASSWORD });
    const refreshToken = login.body.refreshToken as string;
    const auditBefore = await prisma.adminAuditLog.count();
    expect(await prisma.mailOutbox.count({ where: { userId: u.userId } })).toBeGreaterThan(0);
    expect((await preview(u)).body.canDelete).toBe(true);

    // ───────── delete ─────────
    const res = await remove(u);
    expect(res.status).toBe(204);

    // anonymized in place (A7)
    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
    expect(after).toMatchObject({ email: `deleted-${u.userId}@deleted.invalid`, fullName: 'Deleted user', avatarUrl: null, emailVerifiedAt: null, lastLoginAt: null, status: 'DELETED' });
    expect(after.passwordHash).toMatch(/^\$argon2/);
    expect(await verifyPassword(after.passwordHash, PASSWORD)).toBe(false);

    // cannot authenticate any more
    expect((await api.call('GET', '/api/v1/users/me', undefined, u.token)).status).toBe(401);
    expect((await api.call('POST', '/api/v1/auth/login', { email: u.email, password: PASSWORD })).status).toBe(401);
    expect((await api.call('POST', '/api/v1/auth/refresh', { refreshToken })).status).toBe(401);
    const reset = await api.call('POST', '/api/v1/auth/reset-password', { token: resetToken, newPassword: 'a brand new password 1' });
    expect(reset.status).toBe(400);
    expect(reset.body.error.code).toBe('INVALID_TOKEN'); // the token was erased with the account (not a validation error)
    expect(await prisma.refreshToken.count({ where: { userId: u.userId } })).toBe(0);

    // A2 cleanup
    expect((await prisma.matchRequest.findUniqueOrThrow({ where: { id: r1 } })).status).toBe('WITHDRAWN');
    expect((await prisma.matchRequest.findUniqueOrThrow({ where: { id: r2 } })).status).toBe('ACCEPTED');
    expect((await prisma.matchParticipant.findFirstOrThrow({ where: { matchId: m2, userId: u.userId } })).status).toBe('CONFIRMED'); // kept
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b1 } })).status).toBe('CANCELLED');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b2 } })).status).toBe('CANCELLED');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: ext } })).status).toBe('CONFIRMED'); // external: untouched
    for (const id of [b1, b2]) {
      expect(await prisma.bookingEvent.count({ where: { bookingId: id, toStatus: 'CANCELLED' } })).toBe(1);
      expect(await prisma.notification.count({ where: { type: 'BOOKING_CANCELLED', resourceId: id, userId: owner.userId } })).toBe(1); // the venue is told, once
    }
    // A4
    expect(await prisma.venueStaff.count({ where: { userId: u.userId } })).toBe(0);
    expect((await prisma.matchInvitation.findFirstOrThrow({ where: { inviteeId: u.userId } })).status).toBe('EXPIRED');
    expect((await prisma.teamInvitation.findFirstOrThrow({ where: { inviteeId: u.userId } })).status).toBe('EXPIRED');

    // personal rows erased, nothing new arrives for the deleted account
    for (const count of [
      await prisma.notification.count({ where: { userId: u.userId } }),
      await prisma.pushDelivery.count({ where: { userId: u.userId } }),
      await prisma.deviceToken.count({ where: { userId: u.userId } }),
      await prisma.mailOutbox.count({ where: { userId: u.userId } }),
      await prisma.userToken.count({ where: { userId: u.userId } }),
      await prisma.blockedUser.count({ where: { OR: [{ blockerId: u.userId }, { blockedId: u.userId }] } }),
      await prisma.favorite.count({ where: { userId: u.userId } }),
      await prisma.playerProfile.count({ where: { userId: u.userId } }),
    ]) expect(count).toBe(0);

    // A6 / D18: history kept, shown as "Deleted user"
    const messages = await api.call('GET', `/api/v1/chats/${chatId}/messages`, undefined, host.token);
    expect(messages.body.messages[0]).toMatchObject({ body: 'See you at the match, call me +970591234567', sender: { id: u.userId, fullName: 'Deleted user', deleted: true } });
    expect(messages.body.messages[0].sender).not.toHaveProperty('status');
    expect(messages.body.canWrite).toBe(false); // a direct chat with a deleted peer is read-only
    const send = await api.call('POST', `/api/v1/chats/${chatId}/messages`, { body: 'anyone there?' }, host.token);
    expect(send.status).toBe(403);
    expect(send.body.error.code).toBe('CHAT_READ_ONLY');
    expect((await prisma.report.findFirstOrThrow({ where: { reporterId: u.userId } })).details).toBe('personal details I typed');
    expect((await prisma.review.findFirstOrThrow({ where: { reviewerId: u.userId } })).comment).toBe('great organizer, call me');
    const participants = await api.call('GET', `${M}/${m2}/participants`, undefined, host.token);
    expect(participants.body.participants.find((p: { userId: string }) => p.userId === u.userId)).toMatchObject({ fullName: 'Deleted user', deleted: true });
    expect(await prisma.match.count()).toBe(3); // no match deleted or cancelled
    expect((await prisma.match.findMany({ where: { status: 'CANCELLED' } }))).toHaveLength(0);

    // notifications: the deleted account gets nothing new (a match of someone else it still plays in is cancelled)
    expect((await api.call('POST', `${M}/${m2}/cancel`, {}, host.token)).status).toBe(200);
    expect(await prisma.notification.count({ where: { userId: u.userId } })).toBe(0);

    // one immutable audit record, counts only
    const records = await prisma.adminAuditLog.findMany({ where: { action: 'ACCOUNT_DELETED' } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ actorId: u.userId, targetType: 'USER', targetId: u.userId });
    expect(records[0]!.metadata).toEqual({ withdrawnRequests: 1, cancelledBookings: 2, cancelledChallenges: 0, removedStaffRoles: 1, expiredMatchInvitations: 1, expiredTeamInvitations: 1 });
    expect(JSON.stringify(records[0])).not.toMatch(/leaver@example\.com|Player leaver/);
    expect(await prisma.adminAuditLog.count()).toBe(auditBefore + 1); // earlier records untouched
    await expect(prisma.$executeRawUnsafe(`UPDATE admin_audit_log SET reason = 'x' WHERE action = 'ACCOUNT_DELETED'`)).rejects.toThrow();

    // the same e-mail address can register again, as a new account
    const again = await api.call('POST', '/api/v1/auth/register', { email: u.email, password: PASSWORD, fullName: 'Back again', locale: 'en' });
    expect(again.status).toBe(201);
    expect(again.body.user.id).not.toBe(u.userId);

    // repeated request with the old token: refused, nothing more happens
    expect((await remove(u)).status).toBe(401);
    expect(await prisma.adminAuditLog.count({ where: { action: 'ACCOUNT_DELETED' } })).toBe(1);
  });

  it('A3 + A2: a sole captain is deleted, the team, its membership row and history stay; the outgoing pending challenge it created is cancelled (the challenged staff are told once)', async () => {
    const prisma = await prismaP();
    const u = await makeUser(api, 'captain@example.com');
    const teamId = (await api.call('POST', T, { name: 'Captain team' }, u.token)).body.team.id as string;
    const mates: TestUser[] = [];
    for (let i = 0; i < 4; i++) {
      const m = await makeUser(api, `mate${i}@example.com`);
      const inv = await api.call('POST', `${T}/${teamId}/invitations`, { userId: m.userId }, u.token);
      expect((await api.call('POST', `${T}/invitations/${inv.body.invitation.id}/accept`, {}, m.token)).status).toBe(200);
      mates.push(m);
    }
    const other = await makeTeam(api, 'b');
    const sent = await challenge(api, { teamId, captain: u, vice: u, members: [u] }, u, other);
    expect(sent.status).toBe(201);
    const challengeId = sent.body.challenge.id as string;
    for (const m of mates) expect((await api.call('POST', `${T}/${teamId}/leave`, {}, m.token)).status).toBeLessThan(300);
    expect((await preview(u)).body.canDelete).toBe(true); // alone in the team now

    expect((await remove(u)).status).toBe(204);

    expect((await prisma.teamChallenge.findUniqueOrThrow({ where: { id: challengeId } })).status).toBe('CANCELLED');
    for (const staff of [other.captain, other.vice]) {
      expect(await prisma.notification.count({ where: { type: 'CHALLENGE_CANCELLED', userId: staff.userId, resourceId: challengeId } })).toBe(1);
    }
    expect(await prisma.team.count({ where: { id: teamId } })).toBe(1);
    expect(await prisma.teamMember.count({ where: { teamId, userId: u.userId, role: 'CAPTAIN' } })).toBe(1); // the membership row is kept
    const team = await api.call('GET', `${T}/${teamId}`, undefined, other.captain.token);
    expect(team.body.team.members[0]).toMatchObject({ userId: u.userId, fullName: 'Deleted user', deleted: true });
    expect((await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'ACCOUNT_DELETED' } })).metadata).toMatchObject({ cancelledChallenges: 1 });
    // an ACCEPTED challenge would not have been touched (its match is a blocker instead): see the race tests
    expect((await acceptChallenge(api, challengeId, other.captain)).status).toBe(409);
  });
});

// ───────────────────────────── venues of a deleted owner ─────────────────────────────

describe('venues owned by a deleted account (A5)', () => {
  it('an admin can still manage the venue and reactivate it from INACTIVE and from SUSPENDED; the deleted owner is not notified', async () => {
    const prisma = await prismaP();
    const owner = await makeUser(api, 'owner@example.com');
    const { venueId } = await setupVenue(api, owner, cityId);
    const second = await setupVenue(api, owner, cityId);
    expect((await api.call('PATCH', `${V}/${venueId}`, { status: 'INACTIVE' }, owner.token)).status).toBe(200);
    expect((await api.call('PATCH', `${V}/${second.venueId}`, { status: 'INACTIVE' }, owner.token)).status).toBe(200);
    await prisma.venue.update({ where: { id: second.venueId }, data: { status: 'SUSPENDED' } });
    expect((await remove(owner)).status).toBe(204);
    expect(await prisma.venue.count({ where: { ownerId: owner.userId } })).toBe(2); // the venues stay, owned by the anonymized account

    // management keeps working (an admin has every permission on every venue)
    const edit = await api.call('PATCH', `${V}/${venueId}`, { description: 'Managed by an administrator' }, admin.token);
    expect(edit.status).toBe(200);
    // reactivation from INACTIVE and from SUSPENDED
    const a = await api.call('POST', `/api/v1/admin/venues/${venueId}/reactivate`, undefined, admin.token);
    const b = await api.call('POST', `/api/v1/admin/venues/${second.venueId}/reactivate`, undefined, admin.token);
    expect([a.status, b.status]).toEqual([204, 204]);
    expect((await prisma.venue.findMany({ where: { ownerId: owner.userId } })).map((v) => v.status)).toEqual(['ACTIVE', 'ACTIVE']);
    const records = await prisma.adminAuditLog.findMany({ where: { action: 'VENUE_REACTIVATED' }, orderBy: { createdAt: 'asc' } });
    expect(records.map((r) => (r.metadata as { fromStatus: string }).fromStatus).sort()).toEqual(['INACTIVE', 'SUSPENDED']);
    expect(await prisma.notification.count({ where: { userId: owner.userId } })).toBe(0); // nothing for the deleted owner
    // an ACTIVE venue cannot be "reactivated"; no new booking can be made on a venue that is not active (guard)
    expect((await api.call('POST', `/api/v1/admin/venues/${venueId}/reactivate`, undefined, admin.token)).status).toBe(409);
  });
});

// ───────────────────────────── atomicity and repeats ─────────────────────────────

describe('all or nothing, and safe to repeat', () => {
  it('a failure part-way (the audit record cannot be written) rolls back everything: account, requests, bookings, sessions', async () => {
    const prisma = await prismaP();
    const owner = await makeUser(api, 'owner@example.com');
    const host = await makeUser(api, 'host@example.com');
    const u = await makeUser(api, 'rollback@example.com');
    const { fieldId } = await setupVenue(api, owner, cityId);
    const matchId = await newMatch(host, { startAt: inHours(80) });
    const requestId = (await api.call('POST', `${M}/${matchId}/requests`, {}, u.token)).body.request.id as string;
    const bookingId = await bookSlot(u, fieldId, 5);
    await confirmBooking(owner, bookingId);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: u.userId } });

    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION priv01_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER trg_priv01_test_fail BEFORE INSERT ON "admin_audit_log" FOR EACH ROW EXECUTE FUNCTION priv01_test_fail()`);
    try {
      expect((await remove(u)).status).toBe(500);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_priv01_test_fail ON "admin_audit_log"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS priv01_test_fail()`);
    }

    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.userId } })).toEqual(before);
    expect((await prisma.matchRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe('PENDING');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe('CONFIRMED');
    expect(await prisma.bookingEvent.count({ where: { bookingId, toStatus: 'CANCELLED' } })).toBe(0);
    expect(await prisma.notification.count({ where: { type: 'BOOKING_CANCELLED', resourceId: bookingId } })).toBe(0);
    expect((await api.call('GET', '/api/v1/users/me', undefined, u.token)).status).toBe(200); // still signed in
    expect((await remove(u)).status).toBe(204); // and a retry then works
  });

  it('two simultaneous deletions: both succeed, the work is done once, one audit record', async () => {
    const prisma = await prismaP();
    for (let round = 0; round < 3; round++) {
      const u = await makeUser(api, `twice${round}@example.com`);
      const results = await Promise.all([remove(u), remove(u), remove(u)]);
      expect(results.every((r) => r.status === 204)).toBe(true);
      expect(await prisma.adminAuditLog.count({ where: { action: 'ACCOUNT_DELETED', targetId: u.userId } })).toBe(1);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u.userId } })).status).toBe('DELETED');
    }
  });
});

describe('guards: a DELETED account cannot gain new dependencies (database level)', () => {
  it('a match, booking, venue, staff role, join request, membership or challenge cannot be created for a deleted account; ACTIVE and SUSPENDED behave as before', async () => {
    const prisma = await prismaP();
    const owner = await makeUser(api, 'owner@example.com');
    const { venueId, fieldId } = await setupVenue(api, owner, cityId);
    const gone = await makeUser(api, 'gone@example.com');
    const suspended = await makeUser(api, 'suspended@example.com');
    await prisma.user.update({ where: { id: suspended.userId }, data: { status: 'SUSPENDED' } });
    await prisma.user.update({ where: { id: gone.userId }, data: { status: 'DELETED' } });
    const host = await makeUser(api, 'host@example.com');
    const open = await newMatch(host, { startAt: inHours(80) });
    const teamId = (await api.call('POST', T, { name: 'Guarded team' }, host.token)).body.team.id as string;

    const refused = async (sql: string) => {
      const err = await prisma.$executeRawUnsafe(sql).then(() => null, (e: Error) => e);
      expect(err?.message ?? '').toContain('FYM_USER_DELETED');
    };
    const start = localSlot(12, 18).toISOString();
    const end = plusMinutes(localSlot(12, 18), 90).toISOString();
    await refused(`INSERT INTO "match" (organizer_id, type, status, visibility, format, title, start_at, end_at, capacity, updated_at) VALUES ('${gone.userId}', 'OPEN_MATCH', 'OPEN', 'PUBLIC', 'F7', 'Ghost match', '${start}', '${end}', 4, now())`);
    await refused(`INSERT INTO booking (source, status, created_by_id, venue_field_id, start_at, end_at, total_price, hold_expires_at, updated_at) VALUES ('IN_APP', 'PENDING', '${gone.userId}', '${fieldId}', '${start}', '${end}', 10, now() + interval '2 hours', now())`);
    await refused(`INSERT INTO venue_staff (venue_id, user_id, role, permissions) VALUES ('${venueId}', '${gone.userId}', 'STAFF', '{}')`);
    await refused(`INSERT INTO match_request (match_id, user_id) VALUES ('${open}', '${gone.userId}')`);
    await refused(`INSERT INTO team_member (team_id, user_id, role) VALUES ('${teamId}', '${gone.userId}', 'MEMBER')`);
    // a suspended account is NOT refused here: its behaviour is unchanged
    await prisma.$executeRawUnsafe(`INSERT INTO team_member (team_id, user_id, role) VALUES ('${teamId}', '${suspended.userId}', 'MEMBER')`);
    // a captaincy change to a deleted account is refused too
    await prisma.$executeRawUnsafe(`UPDATE team_member SET user_id = user_id WHERE team_id = '${teamId}'`); // a no-op update is fine
    await prisma.$executeRawUnsafe(`INSERT INTO team_member (team_id, user_id, role) VALUES ('${teamId}', '${owner.userId}', 'MEMBER')`);
    await prisma.user.update({ where: { id: owner.userId }, data: { status: 'DELETED' } });
    await refused(`UPDATE team_member SET role = 'VICE_CAPTAIN' WHERE team_id = '${teamId}' AND user_id = '${owner.userId}'`);

    // a booking cannot be inserted on a venue that is not ACTIVE (booking guard), even for an active user
    const player = await makeUser(api, 'player@example.com');
    await prisma.user.update({ where: { id: owner.userId }, data: { status: 'ACTIVE' } });
    await prisma.venue.update({ where: { id: venueId }, data: { status: 'INACTIVE' } });
    const err = await prisma
      .$executeRawUnsafe(`INSERT INTO booking (source, status, created_by_id, venue_field_id, start_at, end_at, total_price, hold_expires_at, updated_at) VALUES ('IN_APP', 'PENDING', '${player.userId}', '${fieldId}', '${start}', '${end}', 10, now() + interval '2 hours', now())`)
      .then(() => null, (e: Error) => e);
    expect(err?.message ?? '').toContain('FYM_VENUE_NOT_ACTIVE');
  });
});

// ───────────────────────────── changes to existing behaviour ─────────────────────────────

describe('what changed around deletion', () => {
  it('a captaincy cannot be handed to a suspended or deleted account', async () => {
    const prisma = await prismaP();
    const A = await makeTeam(api, 'a');
    for (const status of ['SUSPENDED', 'DELETED'] as const) {
      await prisma.user.update({ where: { id: A.members[3]!.userId }, data: { status } });
      const res = await api.call('POST', `${T}/${A.teamId}/transfer-captaincy`, { userId: A.members[3]!.userId }, A.captain.token);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('USER_UNAVAILABLE');
    }
    expect(await prisma.teamMember.count({ where: { teamId: A.teamId, role: 'CAPTAIN', userId: A.captain.userId } })).toBe(1);
    await prisma.user.update({ where: { id: A.members[3]!.userId }, data: { status: 'ACTIVE' } });
    expect((await api.call('POST', `${T}/${A.teamId}/transfer-captaincy`, { userId: A.members[3]!.userId }, A.captain.token)).status).toBe(200); // an active member still works
  });

  it('a password-reset link never works for an account that is not active', async () => {
    const prisma = await prismaP();
    const user = await makeUser(api, 'resetter@example.com');
    const raw = 'a-valid-looking-reset-token';
    await prisma.userToken.create({ data: { userId: user.userId, type: 'PASSWORD_RESET', tokenHash: sha256(raw), expiresAt: new Date(Date.now() + 3_600_000) } });
    await prisma.user.update({ where: { id: user.userId }, data: { status: 'SUSPENDED' } });
    const res = await api.call('POST', '/api/v1/auth/reset-password', { token: raw, newPassword: 'another new password 1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('the bookings cancelled by a deletion carry the reason "account deleted"; a match cancellation still says "match cancelled"', async () => {
    const prisma = await prismaP();
    const owner = await makeUser(api, 'owner@example.com');
    const u = await makeUser(api, 'reason@example.com');
    const { fieldId } = await setupVenue(api, owner, cityId);
    const id = await bookSlot(u, fieldId, 5);
    expect((await remove(u)).status).toBe(204);
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id } });
    expect(booking).toMatchObject({ status: 'CANCELLED', cancelReason: 'account deleted', cancelledById: u.userId });
    expect(await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: id, toStatus: 'CANCELLED' } })).toMatchObject({ reason: 'account deleted' });
  });

  it('suspension and notification rows of other people are unchanged: a suspended account still receives notifications, a deleted one never', async () => {
    const prisma = await prismaP();
    const host = await makeUser(api, 'host@example.com');
    const suspended = await makeUser(api, 'suspended@example.com');
    const gone = await makeUser(api, 'gone@example.com');
    const matchId = await newMatch(host, { startAt: inHours(80) });
    for (const who of [suspended, gone]) {
      const r = (await api.call('POST', `${M}/${matchId}/requests`, {}, who.token)).body.request.id as string;
      expect((await api.call('POST', `${M}/${matchId}/requests/${r}/accept`, {}, host.token)).status).toBe(200);
    }
    await prisma.user.update({ where: { id: suspended.userId }, data: { status: 'SUSPENDED' } });
    expect((await remove(gone)).status).toBe(204);
    expect((await api.call('POST', `${M}/${matchId}/cancel`, {}, host.token)).status).toBe(200);
    expect(await prisma.notification.count({ where: { userId: suspended.userId, type: 'MATCH_CANCELLED' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: gone.userId } })).toBe(0);
  });
});
