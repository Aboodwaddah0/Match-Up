import type { Prisma } from '@prisma/client';
import { recordAdminAudit } from '../../lib/audit';
import { randomToken } from '../../lib/crypto';
import { withDeadlockRetry } from '../../lib/db-errors';
import { AppError } from '../../lib/errors';
import { hashPassword, verifyPassword } from '../../lib/password';
import { prisma } from '../../lib/prisma';
import { disconnectUser } from '../../lib/realtime';
import type { Actor } from '../../types/actor';
import { releaseBookingForMatch } from '../bookings/bookings.service';
import { cancelPendingChallengeInTx } from '../teams/challenges.service';

/*
 * Account deletion (PRIV-01, D18): "block until clean, then anonymize in place".
 *
 *  1. The BLOCKERS (things the user must resolve themselves) are computed by `computeBlockers`, used by BOTH the read-only preview and the
 *     deletion itself, so the two can never disagree. Nothing that is a blocker is ever cleaned up silently.
 *  2. When nothing blocks, ONE transaction cleans up what D18 / A2 / A4 allow (withdraw pending requests, cancel own future in-app bookings,
 *     cancel own outgoing pending challenges, drop staff roles, expire invitations addressed to the user), erases the personal rows, revokes every
 *     session and anonymizes the user row. History (matches, participations, teams, bookings, reports, reviews, messages, audit) is never touched.
 *
 * LOCK ORDER (re-verified against the final code; see the migration header of the guard triggers for the other half):
 *   a. pending team invitations addressed to the user      FOR UPDATE, by id   (an invitation accept holds the invitation row and then
 *                                                                               needs a share lock on the user row; taking the invitation first
 *                                                                               here gives both the SAME order, so they cannot deadlock)
 *   b. the user row                                         FOR NO KEY UPDATE   (NOT FOR UPDATE: that would conflict with the key-share lock every
 *                                                                               notification insert takes, and deadlock with a venue cancelling
 *                                                                               this user's booking while it notifies them). The guard triggers
 *                                                                               take FOR SHARE on this row, which conflicts with it, so anything that
 *                                                                               creates a dependency on the user serializes with the deletion.
 *                                                                               (The anonymizing UPDATE at the very END changes the unique email and so
 *                                                                               does take the stronger lock; it waits only for in-flight inserts that
 *                                                                               reference the user, and none of those can be waiting for a row this
 *                                                                               transaction holds: they hold the booking / venue / invitation row they
 *                                                                               work on BEFORE inserting, and this transaction takes those rows first.)
 *   c. the venues the user OWNS, FOR NO KEY UPDATE in id order (and only those): an owner or admin reactivating one, a booking request being
 *      inserted (trg_01_booking_venue_active) and a VenueBlock being inserted (trg_01_venue_block_venue_share) all take a lock on the venue row
 *      that conflicts with this, so they either finish first (and the blocker check below sees them) or wait for the deletion. Venue before
 *      field, user row before venue row: the same order those code paths use, so there is no cycle.
 *   d. blockers are evaluated (plain reads: every dependency that could still appear is held back or refused by the locks and guards)
 *   e. the user's pending join requests, then own bookings (each through its own row lock, BOOK-01 / BOOK-02), pending challenges, staff rows,
 *      and finally, AFTER the anonymizing UPDATE (which takes a FOR UPDATE-strength lock on the user row, because it changes the unique email),
 *      the user's notification rows: in-flight notifiers have committed by then, and a push fan-out that skips locked rows can neither add
 *      deliveries to them nor be broken by their removal
 * Nothing here ever waits for a MATCH row, so there is no cycle with the match-first rule used everywhere else.
 */

type Db = Prisma.TransactionClient | typeof import('../../lib/prisma').prisma;

const MAX_IDS = 50;

export interface Blocker {
  /** Stable, machine-readable. */
  code: string;
  /** How many resources block (may exceed resourceIds.length). */
  count: number;
  /** At most 50 ids, in id order. */
  resourceIds: string[];
  /** What the user has to do. */
  resolution: string;
  /** Organizer matches only: the exact action per match (a started match can only be completed, not cancelled). */
  items?: { id: string; status: string; action: 'cancel' | 'complete' | 'cancel_or_complete' }[];
}

interface IdRow {
  id: string;
  total: bigint;
}

const totalOf = (rows: IdRow[]) => (rows.length === 0 ? 0 : Number(rows[0]!.total));

/**
 * Everything that stops the account from being deleted right now. One read per kind, all with the same conditions the preview shows.
 * `db` is the connection or the transaction: inside the deletion transaction it runs after the user row is locked.
 */
export async function computeBlockers(db: Db, userId: string): Promise<Blocker[]> {
  const blockers: Blocker[] = [];

  // A1: upcoming matches the user organizes. A match whose start has passed but that is still OPEN / FULL / SCHEDULED is started lazily on the
  // next access, after which an organizer can only COMPLETE it, so it is reported as a match to complete.
  const matches = await db.$queryRaw<{ id: string; status: string; started: boolean; total: bigint }[]>`
    SELECT id, status::text AS status, (status IN ('OPEN', 'FULL', 'SCHEDULED') AND start_at <= now()) AS started, count(*) OVER() AS total
      FROM "match"
     WHERE organizer_id = ${userId}::uuid
       AND (status IN ('OPEN', 'FULL', 'SCHEDULED', 'IN_PROGRESS')
            OR (status = 'CLOSED_UNCONFIRMED' AND now() <= closed_unconfirmed_at + fym_unconfirmed_recovery()))
     ORDER BY id LIMIT ${MAX_IDS}`;
  if (matches.length > 0) {
    blockers.push({
      code: 'ORGANIZES_UPCOMING_MATCHES',
      count: totalOf(matches),
      resourceIds: matches.map((m) => m.id),
      resolution:
        'Cancel each match that has not started (POST /api/v1/matches/:id/cancel). A match that has already started cannot be cancelled by its organizer: complete it (POST /api/v1/matches/:id/complete). See items[].action.',
      items: matches.map((m) => {
        const status = m.started ? 'IN_PROGRESS' : m.status;
        return { id: m.id, status, action: status === 'IN_PROGRESS' ? 'complete' : status === 'CLOSED_UNCONFIRMED' ? 'cancel_or_complete' : 'cancel' };
      }),
    });
  }

  const captains = await db.$queryRaw<IdRow[]>`
    SELECT tm.team_id AS id, count(*) OVER() AS total FROM team_member tm
     WHERE tm.user_id = ${userId}::uuid AND tm.role = 'CAPTAIN'
       AND EXISTS (SELECT 1 FROM team_member o WHERE o.team_id = tm.team_id AND o.user_id <> tm.user_id)
     ORDER BY tm.team_id LIMIT ${MAX_IDS}`;
  if (captains.length > 0) {
    blockers.push({
      code: 'CAPTAINS_TEAM_WITH_MEMBERS',
      count: totalOf(captains),
      resourceIds: captains.map((t) => t.id),
      resolution: 'Transfer the captaincy to another member first (POST /api/v1/teams/:teamId/transfer-captaincy).',
    });
  }

  const memberships = await db.$queryRaw<IdRow[]>`
    SELECT team_id AS id, count(*) OVER() AS total FROM team_member
     WHERE user_id = ${userId}::uuid AND role IN ('MEMBER', 'VICE_CAPTAIN') ORDER BY team_id LIMIT ${MAX_IDS}`;
  if (memberships.length > 0) {
    blockers.push({
      code: 'TEAM_MEMBERSHIP',
      count: totalOf(memberships),
      resourceIds: memberships.map((t) => t.id),
      resolution: 'Leave each team yourself (POST /api/v1/teams/:teamId/leave). You are never removed from a team automatically.',
    });
  }

  // A5: an ACTIVE venue must be deactivated first; INACTIVE and SUSPENDED already count as deactivated.
  const venues = await db.$queryRaw<IdRow[]>`
    SELECT id, count(*) OVER() AS total FROM venue WHERE owner_id = ${userId}::uuid AND status = 'ACTIVE' ORDER BY id LIMIT ${MAX_IDS}`;
  if (venues.length > 0) {
    blockers.push({
      code: 'OWNS_ACTIVE_VENUES',
      count: totalOf(venues),
      resourceIds: venues.map((v) => v.id),
      resolution: 'Deactivate each venue you own (PATCH /api/v1/venues/:venueId with status INACTIVE). Venue ownership cannot be transferred.',
    });
  }

  // Future bookings of the owner's venues, whatever the venue's status. Pending holds that already expired, and bookings that started or
  // ended, do not block. (EXTERNAL bookings are self-reported snapshots that reserve no registered venue: they never appear here.)
  const pending = await db.$queryRaw<IdRow[]>`
    SELECT b.id, count(*) OVER() AS total FROM booking b JOIN venue_field f ON f.id = b.venue_field_id JOIN venue v ON v.id = f.venue_id
     WHERE v.owner_id = ${userId}::uuid AND b.status = 'PENDING' AND b.hold_expires_at > now() AND b.start_at > now() ORDER BY b.id LIMIT ${MAX_IDS}`;
  if (pending.length > 0) {
    blockers.push({
      code: 'VENUE_FUTURE_PENDING_BOOKINGS',
      count: totalOf(pending),
      resourceIds: pending.map((b) => b.id),
      resolution: 'Answer each pending booking request of your venues: reject it (POST /api/v1/bookings/:bookingId/reject) or confirm it and then cancel it.',
    });
  }
  const confirmed = await db.$queryRaw<IdRow[]>`
    SELECT b.id, count(*) OVER() AS total FROM booking b JOIN venue_field f ON f.id = b.venue_field_id JOIN venue v ON v.id = f.venue_id
     WHERE v.owner_id = ${userId}::uuid AND b.status = 'CONFIRMED' AND b.start_at > now() ORDER BY b.id LIMIT ${MAX_IDS}`;
  if (confirmed.length > 0) {
    blockers.push({
      code: 'VENUE_FUTURE_CONFIRMED_BOOKINGS',
      count: totalOf(confirmed),
      resourceIds: confirmed.map((b) => b.id),
      resolution: 'Cancel each confirmed future booking of your venues (POST /api/v1/bookings/:bookingId/cancel); the player is told.',
    });
  }

  // Offline time the owner blocked on their own venues (VenueBlock: how an owner records a booking made outside the app). Never deleted automatically.
  const blocks = await db.$queryRaw<IdRow[]>`
    SELECT vb.id, count(*) OVER() AS total FROM venue_block vb JOIN venue_field f ON f.id = vb.venue_field_id JOIN venue v ON v.id = f.venue_id
     WHERE v.owner_id = ${userId}::uuid AND vb.end_at > now() ORDER BY vb.id LIMIT ${MAX_IDS}`;
  if (blocks.length > 0) {
    blockers.push({
      code: 'VENUE_FUTURE_BLOCKS',
      count: totalOf(blocks),
      resourceIds: blocks.map((b) => b.id),
      resolution: 'Delete each future block of your venues (DELETE /api/v1/blocks/:blockId). Blocks are never removed automatically.',
    });
  }

  return blockers;
}

function assertNotAdmin(actor: Actor): void {
  if (actor.role === 'ADMIN') throw new AppError(403, 'ADMIN_CANNOT_DELETE', 'An administrator account cannot be deleted; ask another administrator to change the role first');
}

/** Read-only preview: exactly the blockers the deletion would refuse with. */
export async function getDeletionBlockers(actor: Actor) {
  assertNotAdmin(actor);
  const blockers = await computeBlockers(prisma, actor.userId);
  return { canDelete: blockers.length === 0, blockers };
}

/**
 * Deletes (anonymizes) the caller's own account after re-checking the password. 409 ACCOUNT_DELETION_BLOCKED lists everything to resolve first
 * and changes nothing. Cleanup, anonymization and the audit record are ONE transaction: all of it or none of it. Repeated or simultaneous
 * requests are safe: the second one finds the account already DELETED and does nothing.
 */
export async function deleteAccount(actor: Actor, password: string, requestId?: string): Promise<void> {
  assertNotAdmin(actor);
  const user = await prisma.user.findUnique({ where: { id: actor.userId }, select: { passwordHash: true, status: true } });
  if (!user || user.status !== 'ACTIVE') throw new AppError(401, 'INVALID_TOKEN', 'Access token is invalid or expired');
  if (!(await verifyPassword(user.passwordHash, password))) throw new AppError(400, 'WRONG_PASSWORD', 'Password is incorrect');
  // A valid argon2 hash of a random secret that is never stored: verifying any password against it fails, and nothing can throw on its format.
  const unusablePasswordHash = await hashPassword(randomToken(32));

  await withDeadlockRetry(() => prisma.$transaction((tx) => deleteInTransaction(tx, actor.userId, unusablePasswordHash, requestId), { timeout: 30_000, maxWait: 10_000 }));
  disconnectUser(actor.userId); // live sockets end now, not at the next reconnect
}

async function deleteInTransaction(tx: Prisma.TransactionClient, userId: string, unusablePasswordHash: string, requestId?: string): Promise<void> {
  const self: Actor = { userId, role: 'USER' };

  // a. invitations first (see the lock-order note above), b. then the user row
  await tx.$queryRaw`SELECT id FROM team_invitation WHERE invitee_id = ${userId}::uuid AND status = 'PENDING' ORDER BY id FOR UPDATE`;
  const rows = await tx.$queryRaw<{ status: string; platform_role: string }[]>`
    SELECT status::text AS status, platform_role::text AS platform_role FROM "user" WHERE id = ${userId}::uuid FOR NO KEY UPDATE`;
  const me = rows[0];
  if (!me) throw new AppError(401, 'INVALID_TOKEN', 'Access token is invalid or expired');
  if (me.status === 'DELETED') return; // a simultaneous request already did it: nothing left to do
  if (me.status !== 'ACTIVE') throw new AppError(409, 'INVALID_STATE', 'This account cannot be deleted right now');
  if (me.platform_role === 'ADMIN') throw new AppError(403, 'ADMIN_CANNOT_DELETE', 'An administrator account cannot be deleted');

  // c. the owned venues (status, future bookings and blocks are decided under these locks), d. blockers, now that nothing new can attach
  await tx.$queryRaw`SELECT id FROM venue WHERE owner_id = ${userId}::uuid ORDER BY id FOR NO KEY UPDATE`;
  const blockers = await computeBlockers(tx, userId);
  if (blockers.length > 0) {
    throw new AppError(409, 'ACCOUNT_DELETION_BLOCKED', 'Resolve these before deleting the account', { blockers });
  }

  // e. cleanup D18 / A2 / A4 allow
  const requests = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM match_request WHERE user_id = ${userId}::uuid AND status = 'PENDING' ORDER BY id FOR UPDATE`;
  if (requests.length > 0) {
    await tx.matchRequest.updateMany({ where: { id: { in: requests.map((r) => r.id) }, status: 'PENDING' }, data: { status: 'WITHDRAWN' } });
  }

  // The user's OWN future in-app bookings, through the booking release (row lock + locked status, BOOK-01 / BOOK-02, event, venue managers told).
  // An expired hold is left to the expiry sweeper. External bookings are never touched.
  const bookings = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM booking
     WHERE created_by_id = ${userId}::uuid AND source = 'IN_APP' AND status IN ('PENDING', 'CONFIRMED') AND start_at > now()
       AND (status = 'CONFIRMED' OR hold_expires_at > now())
     ORDER BY id`;
  let cancelledBookings = 0;
  for (const b of bookings) if (await releaseBookingForMatch(tx, self, b.id, 'account deleted')) cancelledBookings++;

  // Outgoing challenges still pending that this user created (the organizer recorded at creation, BIZ-02); accepted ones and matches are untouched.
  const challenges = await tx.$queryRaw<{ id: string; challenged_team_id: string }[]>`
    SELECT id, challenged_team_id FROM team_challenge WHERE organizer_id = ${userId}::uuid AND status = 'PENDING' AND expires_at > now() ORDER BY id FOR UPDATE`;
  let cancelledChallenges = 0;
  for (const c of challenges) if (await cancelPendingChallengeInTx(tx, self, c.id, c.challenged_team_id)) cancelledChallenges++;

  await tx.$queryRaw`SELECT venue_id FROM venue_staff WHERE user_id = ${userId}::uuid ORDER BY venue_id FOR UPDATE`;
  const staff = await tx.venueStaff.deleteMany({ where: { userId } });
  const matchInvitations = await tx.matchInvitation.updateMany({ where: { inviteeId: userId, status: 'PENDING' }, data: { status: 'EXPIRED' } });
  const teamInvitations = await tx.teamInvitation.updateMany({ where: { inviteeId: userId, status: 'PENDING' }, data: { status: 'EXPIRED' } });

  // Personal rows. Messages, reviews, reports, participations, memberships and audit rows stay.
  await tx.deviceToken.deleteMany({ where: { userId } });
  await tx.mailOutbox.deleteMany({ where: { userId } }); // holds the original address
  await tx.userToken.deleteMany({ where: { userId } });
  await tx.refreshToken.deleteMany({ where: { userId } }); // every session
  await tx.blockedUser.deleteMany({ where: { OR: [{ blockerId: userId }, { blockedId: userId }] } });
  await tx.favorite.deleteMany({ where: { userId } });
  await tx.playerProfile.deleteMany({ where: { userId } }); // positions cascade from the profile

  // Anonymize in place. The placeholder comes from the immutable primary key, so it is unique, and the reserved ".invalid" domain never resolves.
  // This UPDATE changes a unique key column (email), so Postgres takes a FOR UPDATE lock on the user row for it: it waits for transactions that
  // are in the middle of inserting a row that references this user (a notification, an event, ...) and, once it holds the lock, nothing new can
  // reference the user until this transaction ends.
  await tx.user.update({
    where: { id: userId },
    data: { email: `deleted-${userId}@deleted.invalid`, passwordHash: unusablePasswordHash, fullName: 'Deleted user', avatarUrl: null, emailVerifiedAt: null, lastLoginAt: null, status: 'DELETED' },
  });

  // The notifications are erased NOW, after that lock, not before it: a notifier that was already inserting a row for this user has committed it
  // by the time the lock is granted, and this statement (a new snapshot) sees and removes it. (Rows from a notifier that only STARTS its insert
  // while this transaction holds the lock commit after it; those are removed by the lifecycle job purgeDeletedUserNotifications.)
  await tx.$queryRaw`SELECT id FROM notification WHERE user_id = ${userId}::uuid ORDER BY id FOR UPDATE`;
  await tx.pushDelivery.deleteMany({ where: { userId } });
  await tx.notification.deleteMany({ where: { userId } });

  // One immutable record, in the same transaction. Counts only: no e-mail, name or any other personal value.
  await recordAdminAudit(tx, {
    actorId: userId,
    action: 'ACCOUNT_DELETED',
    targetType: 'USER',
    targetId: userId,
    metadata: {
      withdrawnRequests: requests.length,
      cancelledBookings,
      cancelledChallenges,
      removedStaffRoles: staff.count,
      expiredMatchInvitations: matchInvitations.count,
      expiredTeamInvitations: teamInvitations.count,
    },
    requestId,
  });
}
