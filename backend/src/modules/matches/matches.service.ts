import { Prisma, type MatchStatus } from '@prisma/client';
import type { z } from 'zod';
import { areBlocked } from '../../lib/blocks';
import { withDeadlockRetry } from '../../lib/db-errors';
import { AppError } from '../../lib/errors';
import { recordAdminAudit } from '../../lib/audit';
import { lockMatch } from '../../lib/locks';
import { prisma } from '../../lib/prisma';
import type { Actor } from '../../types/actor';
import { releaseBookingForMatch } from '../bookings/bookings.service';
import { notify } from '../notifications/notify';
import type { createMatchSchema, mineSchema, searchSchema, updateMatchSchema } from './matches.schemas';

const FORMAT_SIZE = { F5: 5, F7: 7, F11: 11 } as const;
const MINUTE = 60_000;

export const matchInclude = {
  organizer: { select: { id: true, fullName: true, avatarUrl: true } },
  city: { select: { id: true, nameAr: true, nameEn: true } },
  requiredPositions: true,
  booking: { select: { id: true, status: true, source: true } },
} satisfies Prisma.MatchInclude;
export type MatchRow = Prisma.MatchGetPayload<{ include: typeof matchInclude }>;

type Relation = 'ORGANIZER' | 'PARTICIPANT' | 'REQUESTED' | 'INVITED' | 'NONE';

// ───────────────────────── derived values (never stored, D17) ─────────────────────────

/** Confirmed players per match, counted from participant rows. confirmed_count / available_spots are DERIVED, never stored (D17). */
async function confirmedCounts(matchIds: string[]): Promise<Map<string, number>> {
  if (matchIds.length === 0) return new Map();
  const rows = await prisma.matchParticipant.groupBy({
    by: ['matchId'],
    where: { matchId: { in: matchIds }, status: 'CONFIRMED' },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.matchId, r._count._all]));
}

/** How the viewer relates to each match (organizer / participant / requested / invited), for the `myRelation` field. */
async function relationsFor(matchIds: string[], userId: string): Promise<Map<string, Relation>> {
  const [parts, reqs, invs] = await Promise.all([
    prisma.matchParticipant.findMany({ where: { userId, matchId: { in: matchIds }, status: 'CONFIRMED' }, select: { matchId: true } }),
    prisma.matchRequest.findMany({ where: { userId, matchId: { in: matchIds }, status: 'PENDING' }, select: { matchId: true } }),
    prisma.matchInvitation.findMany({ where: { inviteeId: userId, matchId: { in: matchIds }, status: 'PENDING' }, select: { matchId: true } }),
  ]);
  const map = new Map<string, Relation>();
  invs.forEach((r) => map.set(r.matchId, 'INVITED'));
  reqs.forEach((r) => map.set(r.matchId, 'REQUESTED'));
  parts.forEach((r) => map.set(r.matchId, 'PARTICIPANT'));
  return map;
}

/** Builds the API shape of matches for one viewer; derived counts apply to OPEN_MATCH only (a team challenge has no capacity). */
export async function toDtos(rows: MatchRow[], actor: Actor, distances?: Map<string, number>) {
  const ids = rows.map((r) => r.id);
  const [counts, relations] = await Promise.all([confirmedCounts(ids), relationsFor(ids, actor.userId)]);
  return rows.map((m) => {
    const isOpenMatch = m.type === 'OPEN_MATCH';
    const confirmedCount = isOpenMatch ? (counts.get(m.id) ?? 0) : null;
    const relation: Relation = m.organizerId === actor.userId ? 'ORGANIZER' : (relations.get(m.id) ?? 'NONE');
    return {
      id: m.id,
      type: m.type,
      status: m.status,
      visibility: m.visibility,
      title: m.title,
      description: m.description,
      notes: m.notes,
      format: m.format,
      startAt: m.startAt,
      endAt: m.endAt,
      timezone: m.timezone,
      city: m.city,
      locationName: m.locationName,
      latitude: m.latitude,
      longitude: m.longitude,
      distanceKm: distances?.has(m.id) ? Math.round(distances.get(m.id)! * 10) / 10 : undefined,
      requiredSkillLevel: m.requiredSkillLevel,
      requiredPositions: m.requiredPositions.map((p) => ({ position: p.position, count: p.count })),
      pricePerPlayer: m.pricePerPlayer === null ? null : Number(m.pricePerPlayer),
      currency: m.currency,
      capacity: m.capacity,
      confirmedCount,
      availableSpots: isOpenMatch ? m.capacity! - confirmedCount! : null,
      organizer: m.organizer,
      // The venue link. venueConfirmed=false means the booking was rejected/cancelled/expired ("venue not confirmed").
      booking: m.booking,
      venueConfirmed: m.booking ? ['CONFIRMED', 'COMPLETED'].includes(m.booking.status) : null,
      myRelation: relation,
    };
  });
}

// ───────────────────────── access ─────────────────────────

/**
 * Moves ONE match whose start time has passed from OPEN / FULL / SCHEDULED to IN_PROGRESS, right now.
 * The background sweeper does this for every match once a minute, but correctness must not depend on a timer having fired
 * (design principle): whoever touches a match after its start time first brings it up to date. The UPDATE re-checks the
 * status and the DATABASE clock under a row lock, so racing with the sweeper (or another request) records the transition once.
 * Returns true when this call moved the match.
 */
export async function startMatchIfDue(id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ from_status: MatchStatus }[]>`
      WITH due AS (
        SELECT id, status FROM "match"
         WHERE id = ${id}::uuid AND status IN ('OPEN', 'FULL', 'SCHEDULED') AND start_at <= now()
         FOR NO KEY UPDATE)
      UPDATE "match" m SET status = 'IN_PROGRESS' FROM due WHERE m.id = due.id
      RETURNING due.status::text AS from_status`;
    if (rows.length === 0) return false;
    await tx.matchEvent.create({ data: { matchId: id, fromStatus: rows[0]!.from_status, toStatus: 'IN_PROGRESS', reason: 'auto: start time reached (on access)' } });
    return true;
  });
}

/**
 * A match with its relations; 404 if it does not exist. No visibility check: use loadViewableMatch / loadManageableMatch for that.
 * A match that is past its start time but still OPEN / FULL / SCHEDULED (the sweeper has not run yet) is started first, so every
 * caller sees and enforces the real state (no cancelling a running match, attendance and completion allowed).
 */
export async function loadMatch(id: string): Promise<MatchRow> {
  let m = await prisma.match.findUnique({ where: { id }, include: matchInclude });
  if (!m) throw new AppError(404, 'MATCH_NOT_FOUND', 'Match not found');
  if (m.startAt <= new Date() && ['OPEN', 'FULL', 'SCHEDULED'].includes(m.status) && (await startMatchIfDue(id))) {
    m = await prisma.match.findUniqueOrThrow({ where: { id }, include: matchInclude });
  }
  return m;
}

/** Private matches exist only for the organizer, invited players, requesters, participants and admins. Blocked users never see each other's matches. */
export async function loadViewableMatch(id: string, actor: Actor): Promise<MatchRow> {
  const m = await loadMatch(id);
  const notFound = new AppError(404, 'MATCH_NOT_FOUND', 'Match not found');
  if (actor.role === 'ADMIN' || m.organizerId === actor.userId) return m;

  if (await areBlocked(m.organizerId, actor.userId)) throw notFound; // a block hides the match entirely

  if (m.visibility === 'PRIVATE') {
    const related = await prisma.match.count({
      where: {
        id,
        OR: [
          { participants: { some: { userId: actor.userId } } },
          { requests: { some: { userId: actor.userId } } },
          { invitations: { some: { inviteeId: actor.userId } } },
        ],
      },
    });
    if (related === 0) throw notFound;
  }
  return m;
}

/** Like loadViewableMatch, but only the organizer or an admin passes (403 otherwise). */
export async function loadManageableMatch(id: string, actor: Actor): Promise<MatchRow> {
  const m = await loadViewableMatch(id, actor);
  if (m.organizerId !== actor.userId && actor.role !== 'ADMIN') {
    throw new AppError(403, 'FORBIDDEN', 'Only the organizer can manage this match');
  }
  return m;
}

/** Warn-only (D3): does the viewer already have a CONFIRMED match overlapping this one? */
export async function hasScheduleConflict(m: MatchRow, userId: string): Promise<boolean> {
  const n = await prisma.matchParticipant.count({
    where: {
      userId,
      status: 'CONFIRMED',
      matchId: { not: m.id },
      match: { startAt: { lt: m.endAt }, endAt: { gt: m.startAt }, status: { in: ['OPEN', 'FULL', 'SCHEDULED', 'IN_PROGRESS'] } },
    },
  });
  return n > 0;
}

/** Appends a row to the match's status history (audit trail of every lifecycle transition). */
async function recordEvent(tx: Prisma.TransactionClient, matchId: string, actorId: string, from: MatchStatus, to: MatchStatus, reason?: string | null) {
  await tx.matchEvent.create({ data: { matchId, actorId, fromStatus: from, toStatus: to, reason: reason ?? undefined } });
}

/**
 * Tells the database triggers that this transaction is run by an admin (transaction-local setting).
 * Some lifecycle transitions are admin-only, e.g. recovering a CLOSED_UNCONFIRMED match after the organizer's 7-day window.
 */
async function markAdminActor(tx: Prisma.TransactionClient, actor: Actor): Promise<void> {
  // Lets the DB state machine allow admin-only transitions (see fym_match_guard).
  if (actor.role === 'ADMIN') await tx.$queryRaw`SELECT set_config('fym.actor_is_admin', 'true', true)`;
}

/**
 * An admin acting on a match they do NOT organize (AUD-01: cancel, complete / recover and edit are recorded). An admin managing their own match is an ordinary organizer action and
 * is not logged as an override.
 */
function isAdminOverride(actor: Actor, organizerId: string): boolean {
  return actor.role === 'ADMIN' && actor.userId !== organizerId;
}

/**
 * What an admin edit changed, for the audit log (AUD-01). Free text (title, description, notes, place name), coordinates, the
 * linked booking and the required positions are reported by NAME only, never by value: they can hold personal or location data
 * and the log can never be edited. Scalar fields that carry no personal data are reported as before / after.
 */
function describeMatchEdit(m: MatchRow, input: z.infer<typeof updateMatchSchema>, startAt: Date, endAt: Date, timeChanged: boolean) {
  const changedFields: string[] = [];
  const before: Record<string, string | number | null> = {};
  const after: Record<string, string | number | null> = {};
  const named = (field: string, provided: unknown, current: unknown) => {
    if (provided !== undefined && provided !== current) changedFields.push(field);
  };
  named('title', input.title, m.title);
  named('description', input.description, m.description);
  named('notes', input.notes, m.notes);
  named('locationName', input.locationName, m.locationName);
  named('booking', input.bookingId, m.bookingId);
  if ((input.latitude !== undefined && input.latitude !== m.latitude) || (input.longitude !== undefined && input.longitude !== m.longitude)) changedFields.push('location');
  if (input.requiredPositions) {
    const key = (list: { position: string; count: number }[]) => JSON.stringify([...list].sort((a, b) => a.position.localeCompare(b.position)).map((p) => [p.position, p.count]));
    if (key(input.requiredPositions) !== key(m.requiredPositions)) changedFields.push('requiredPositions');
  }
  const valued = (field: string, provided: string | number | null | undefined, current: string | number | null) => {
    if (provided === undefined || provided === current) return;
    changedFields.push(field);
    before[field] = current;
    after[field] = provided;
  };
  valued('capacity', input.capacity, m.capacity);
  valued('requiredSkillLevel', input.requiredSkillLevel, m.requiredSkillLevel);
  valued('pricePerPlayer', input.pricePerPlayer, m.pricePerPlayer === null ? null : Number(m.pricePerPlayer));
  valued('cityId', input.cityId, m.cityId);
  if (timeChanged) {
    changedFields.push('time');
    before.startAt = m.startAt.toISOString();
    before.endAt = m.endAt.toISOString();
    after.startAt = startAt.toISOString();
    after.endAt = endAt.toISOString();
  }
  return { changedFields, before, after };
}

/** 400 when the city id does not exist (cities are seeded reference data). */
async function assertCityExists(cityId?: string | null) {
  if (cityId && !(await prisma.city.findUnique({ where: { id: cityId } }))) throw new AppError(400, 'INVALID_CITY', 'Unknown city');
}

// ───────────────────────── use cases ─────────────────────────

/**
 * Creates an OPEN_MATCH owned by the caller. `capacity` is the number of players wanted through the app (D13),
 * not the whole pitch. An optional `bookingId` links the organizer's own CONFIRMED booking (the match must fit inside it);
 * location and city default from that booking's venue. The DB trigger sets the initial status and validates the link.
 */
export async function createMatch(actor: Actor, input: z.infer<typeof createMatchSchema>) {
  await assertCityExists(input.cityId);
  // Booking and Match stay separate entities: the match only references the booking; location defaults come from its venue.
  const booked = input.bookingId
    ? await prisma.booking.findUnique({ where: { id: input.bookingId }, include: { field: { include: { venue: true } } } })
    : null;
  if (input.bookingId && !booked) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
  const venue = booked?.field?.venue;
  const startAt = new Date(input.startAt);
  const endAt = input.endAt ? new Date(input.endAt) : new Date(startAt.getTime() + (input.durationMinutes ?? 90) * MINUTE);

  const m = await prisma.match.create({
    data: {
      organizerId: actor.userId,
      type: 'OPEN_MATCH',
      status: 'OPEN', // DB trigger enforces the initial status per type (D15)
      visibility: input.visibility,
      format: input.format,
      title: input.title,
      description: input.description,
      notes: input.notes,
      startAt,
      endAt,
      cityId: input.cityId ?? venue?.cityId,
      locationName: input.locationName ?? venue?.name,
      latitude: input.latitude ?? (input.longitude == null ? venue?.latitude : undefined),
      longitude: input.longitude ?? (input.latitude == null ? venue?.longitude : undefined),
      bookingId: input.bookingId ?? undefined, // DB trigger: CONFIRMED, made by the organizer, match fits inside it
      requiredSkillLevel: input.requiredSkillLevel,
      pricePerPlayer: input.pricePerPlayer,
      capacity: input.capacity,
      requiredPositions: { create: input.requiredPositions },
    },
    include: matchInclude,
  });
  return (await toDtos([m], actor))[0]!;
}

/** Match details for a viewer who is allowed to see it. The organizer and admins also get the pending-request count. */
export async function getMatch(actor: Actor, id: string) {
  const m = await loadViewableMatch(id, actor);
  const [dto] = await toDtos([m], actor);
  const isOrganizer = m.organizerId === actor.userId;
  return {
    ...dto!,
    bookingId: m.bookingId,
    ...(m.type === 'TEAM_CHALLENGE' ? { sides: await teamSides(m.id, m.format) } : {}),
    scheduleConflict: isOrganizer ? false : await hasScheduleConflict(m, actor.userId),
    ...(isOrganizer || actor.role === 'ADMIN'
      ? { pendingRequestCount: await prisma.matchRequest.count({ where: { matchId: id, status: 'PENDING' } }) }
      : {}),
  };
}

/** TEAM_CHALLENGE: the two sides with how many players each has confirmed vs the format requires. */
/** TEAM_CHALLENGE only: the two sides with how many players each has confirmed vs the format requires. */
async function teamSides(matchId: string, format: keyof typeof FORMAT_SIZE) {
  const sides = await prisma.matchTeam.findMany({
    where: { matchId },
    orderBy: { side: 'asc' },
    include: { team: { select: { id: true, name: true, logoUrl: true } }, _count: { select: { participants: { where: { status: 'CONFIRMED' } } } } },
  });
  return sides.map((s) => ({ side: s.side, team: s.team, rosterCount: s._count.participants, required: FORMAT_SIZE[format] }));
}

/** The start / end an edit results in, relative to the match as it is NOW (read under the lock). */
function resolveEditedTimes(cur: MatchRow, input: z.infer<typeof updateMatchSchema>) {
  const startAt = input.startAt ? new Date(input.startAt) : cur.startAt;
  const keptDuration = cur.endAt.getTime() - cur.startAt.getTime();
  const endAt = input.endAt
    ? new Date(input.endAt)
    : input.durationMinutes
      ? new Date(startAt.getTime() + input.durationMinutes * MINUTE)
      : input.startAt
        ? new Date(startAt.getTime() + keptDuration)
        : cur.endAt;
  const timeChanged = startAt.getTime() !== cur.startAt.getTime() || endAt.getTime() !== cur.endAt.getTime();
  return { startAt, endAt, timeChanged };
}

/**
 * Edits an OPEN / FULL open match (organizer or admin). Rules enforced by the DB triggers, so they hold under races:
 * capacity never below the confirmed count and not after start; the time can change only while nobody is confirmed (D12).
 * Pending requesters are notified when the time changes.
 */
export async function updateMatch(actor: Actor, id: string, input: z.infer<typeof updateMatchSchema>, requestId?: string) {
  const m = await loadManageableMatch(id, actor);
  if (m.type !== 'OPEN_MATCH' || !['OPEN', 'FULL'].includes(m.status)) {
    throw new AppError(409, 'INVALID_STATE', 'Only open matches can be edited');
  }
  await assertCityExists(input.cityId);
  if (input.capacity !== undefined && input.capacity > 2 * FORMAT_SIZE[m.format]) {
    throw new AppError(400, 'INVALID_CAPACITY', 'Capacity cannot exceed the total players of the format');
  }

  await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    const lockedStatus = await lockMatch(tx, id); // match row first, always (see lib/locks.ts)
    // Everything below works on the row AS LOCKED, never on the copy read before the transaction: another edit, a cancel or a
    // start may have committed in between. The same locked state decides what changed, is updated, and is written to the audit log.
    if (!['OPEN', 'FULL'].includes(lockedStatus)) throw new AppError(409, 'INVALID_STATE', 'Only open matches can be edited');
    const cur = await tx.match.findUniqueOrThrow({ where: { id }, include: matchInclude });
    const { startAt, endAt, timeChanged } = resolveEditedTimes(cur, input);

    await tx.match.update({
      where: { id },
      data: {
        title: input.title,
        description: input.description,
        notes: input.notes,
        capacity: input.capacity, // DB trigger: not below confirmed, not after start, recomputes OPEN/FULL
        requiredSkillLevel: input.requiredSkillLevel,
        pricePerPlayer: input.pricePerPlayer,
        cityId: input.cityId,
        locationName: input.locationName,
        latitude: input.latitude,
        longitude: input.longitude,
        bookingId: input.bookingId, // null unlinks; linking is validated by the DB
        ...(timeChanged ? { startAt, endAt } : {}), // DB trigger: only while nobody is confirmed (D12)
      },
    });
    if (isAdminOverride(actor, cur.organizerId)) {
      // Written right after the update, inside the same transaction. An edit that changes nothing leaves no record.
      const edit = describeMatchEdit(cur, input, startAt, endAt, timeChanged);
      if (edit.changedFields.length > 0) {
        await recordAdminAudit(tx, { actorId: actor.userId, action: 'MATCH_EDITED_BY_ADMIN', targetType: 'MATCH', targetId: id, metadata: { organizerId: cur.organizerId, ...edit }, requestId });
      }
    }
    if (input.requiredPositions) {
      await tx.matchRequiredPosition.deleteMany({ where: { matchId: id } });
      await tx.matchRequiredPosition.createMany({ data: input.requiredPositions.map((p) => ({ matchId: id, ...p })) });
    }
    if (timeChanged) {
      const pending = await tx.matchRequest.findMany({ where: { matchId: id, status: 'PENDING' }, select: { userId: true } });
      await notify(tx, pending.map((r) => r.userId), 'MATCH_TIME_CHANGED', { matchId: id, title: cur.title, startAt: startAt.toISOString() }, { type: 'match', id });
    }
  }));
  return getMatch(actor, id);
}

/**
 * Cancels a match (an explicit human decision, unlike CLOSED_UNCONFIRMED which means "unknown").
 * The DB trigger moves participants to MATCH_CANCELLED (slots freed, no penalty) and expires pending requests and
 * invitations. `releaseBooking` also cancels the organizer's own in-app booking so the venue slot is freed.
 * Everything happens in ONE transaction, so the match, its participants and the booking never disagree.
 */
export async function cancelMatch(actor: Actor, id: string, reason?: string | null, releaseBooking = false, requestId?: string) {
  const m = await loadManageableMatch(id, actor);
  // Organizers cancel before start (or recover a CLOSED_UNCONFIRMED match). Cancelling a match
  // that is already running is an admin decision.
  const organizerStates: MatchStatus[] = ['OPEN', 'FULL', 'SCHEDULED', 'CLOSED_UNCONFIRMED'];
  const adminStates: MatchStatus[] = [...organizerStates, 'IN_PROGRESS'];
  if (!(actor.role === 'ADMIN' ? adminStates : organizerStates).includes(m.status)) {
    throw new AppError(409, 'INVALID_STATE', 'This match cannot be cancelled in its current status');
  }

  // Retried as a whole if Postgres picks it as a deadlock victim; the lock order below makes that rare.
  await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    const fromStatus = await lockMatch(tx, id); // match row first: a concurrent accept / leave queues behind us instead of deadlocking
    const [participants, requests] = await Promise.all([
      tx.matchParticipant.findMany({ where: { matchId: id, status: 'CONFIRMED' }, select: { userId: true } }),
      tx.matchRequest.findMany({ where: { matchId: id, status: 'PENDING' }, select: { userId: true } }),
    ]);
    await markAdminActor(tx, actor);
    // DB trigger: participants -> MATCH_CANCELLED (slots freed, no penalty), pending requests/invitations expire.
    await tx.match.update({ where: { id }, data: { status: 'CANCELLED', cancelledById: actor.userId, cancelReason: reason ?? undefined } });
    if (isAdminOverride(actor, m.organizerId)) {
      await recordAdminAudit(tx, { actorId: actor.userId, action: 'MATCH_CANCELLED_BY_ADMIN', targetType: 'MATCH', targetId: id, reason, metadata: { fromStatus, toStatus: 'CANCELLED', organizerId: m.organizerId }, requestId });
    }
    await recordEvent(tx, id, actor.userId, fromStatus, 'CANCELLED', reason);
    if (releaseBooking && m.bookingId) await releaseBookingForMatch(tx, actor, m.bookingId);
    await notify(tx, [...participants, ...requests].map((r) => r.userId).filter((u) => u !== actor.userId), 'MATCH_CANCELLED',
      { matchId: id, title: m.title, reason: reason ?? null }, { type: 'match', id });
  }));
  return getMatch(actor, id);
}

/** Only the organizer (or an admin) confirms the match really took place (D5). */
export async function completeMatch(actor: Actor, id: string, requestId?: string) {
  const m = await loadManageableMatch(id, actor);
  if (!['IN_PROGRESS', 'CLOSED_UNCONFIRMED'].includes(m.status)) {
    throw new AppError(409, 'INVALID_STATE', 'Only a started match can be completed');
  }
  await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
    const fromStatus = await lockMatch(tx, id);
    await markAdminActor(tx, actor);
    // DB trigger: stamps completed_at, finalizes attendance (anyone not NO_SHOW -> ATTENDED), 7-day recovery rule.
    await tx.match.update({ where: { id }, data: { status: 'COMPLETED', completedById: actor.userId } });
    if (isAdminOverride(actor, m.organizerId)) {
      // Completing a CLOSED_UNCONFIRMED match is a recovery (after the organizer's 7-day window only an admin can do it).
      const action = fromStatus === 'CLOSED_UNCONFIRMED' ? 'MATCH_RECOVERED_BY_ADMIN' : 'MATCH_COMPLETED_BY_ADMIN';
      await recordAdminAudit(tx, { actorId: actor.userId, action, targetType: 'MATCH', targetId: id, metadata: { fromStatus, toStatus: 'COMPLETED', organizerId: m.organizerId }, requestId });
    }
    await recordEvent(tx, id, actor.userId, fromStatus, 'COMPLETED');
  }));
  return getMatch(actor, id);
}

// ───────────────────────── discovery ─────────────────────────

/**
 * Public discovery of open matches. Hides private matches, matches already started, and matches of organizers who have
 * a block with the viewer. With lat/lng it sorts by distance, using `earth_box` (index-friendly) before the exact
 * `earth_distance` check, same technique as venue search.
 */
export async function searchMatches(actor: Actor, q: z.infer<typeof searchSchema>) {
  const conds: Prisma.Sql[] = [
    Prisma.sql`m.type = 'OPEN_MATCH'`,
    Prisma.sql`m.visibility = 'PUBLIC'`,
    Prisma.sql`m.start_at > now()`,
    q.includeFull ? Prisma.sql`m.status IN ('OPEN', 'FULL')` : Prisma.sql`m.status = 'OPEN'`,
    Prisma.sql`NOT EXISTS (SELECT 1 FROM blocked_user b WHERE (b.blocker_id = m.organizer_id AND b.blocked_id = ${actor.userId}::uuid) OR (b.blocker_id = ${actor.userId}::uuid AND b.blocked_id = m.organizer_id))`,
  ];
  if (!q.includeFull) conds.push(Prisma.sql`(m.capacity - c.n) >= ${q.minSpots}`);
  if (q.cityId) conds.push(Prisma.sql`m.city_id = ${q.cityId}::uuid`);
  if (q.from) conds.push(Prisma.sql`m.start_at >= ${new Date(q.from)}`);
  if (q.to) conds.push(Prisma.sql`m.start_at <= ${new Date(q.to)}`);
  if (q.format) conds.push(Prisma.sql`m.format = ${q.format}::match_format`);
  if (q.skillLevel) conds.push(Prisma.sql`(m.required_skill_level IS NULL OR m.required_skill_level = ${q.skillLevel}::skill_level)`);
  if (q.position) conds.push(Prisma.sql`EXISTS (SELECT 1 FROM match_required_position r WHERE r.match_id = m.id AND r.position = ${q.position}::"position")`);
  if (q.maxPrice !== undefined) conds.push(Prisma.sql`(m.price_per_player IS NULL OR m.price_per_player <= ${q.maxPrice})`);

  if (q.suitableForMe) {
    const profile = await prisma.playerProfile.findUnique({ where: { userId: actor.userId }, include: { positions: true } });
    if (!profile) throw new AppError(403, 'PROFILE_REQUIRED', 'Create your player profile first');
    const mine = profile.positions.map((p) => p.position);
    conds.push(Prisma.sql`(m.required_skill_level IS NULL OR m.required_skill_level = ${profile.skillLevel}::skill_level)`);
    conds.push(Prisma.sql`(NOT EXISTS (SELECT 1 FROM match_required_position r WHERE r.match_id = m.id)
      OR EXISTS (SELECT 1 FROM match_required_position r WHERE r.match_id = m.id AND r.position::text = ANY(${mine}::text[])))`);
  }

  let distance = Prisma.sql`NULL::float8`;
  let order = Prisma.sql`m.start_at ASC, m.id ASC`;
  if (q.lat !== undefined && q.lng !== undefined) {
    const meters = q.radiusKm * 1000;
    const here = Prisma.sql`ll_to_earth(${q.lat}::float8, ${q.lng}::float8)`;
    const there = Prisma.sql`ll_to_earth(m.latitude, m.longitude)`;
    conds.push(Prisma.sql`m.latitude IS NOT NULL AND earth_box(${here}, ${meters}::float8) @> ${there} AND earth_distance(${here}, ${there}) <= ${meters}::float8`);
    distance = Prisma.sql`earth_distance(${here}, ${there}) / 1000.0`;
    order = Prisma.sql`distance_km ASC, m.start_at ASC, m.id ASC`;
  }

  const offset = (q.page - 1) * q.pageSize;
  const found = await prisma.$queryRaw<{ id: string; distance_km: number | null }[]>`
    SELECT m.id, ${distance} AS distance_km
      FROM "match" m
      CROSS JOIN LATERAL (SELECT count(*)::int AS n FROM match_participant p WHERE p.match_id = m.id AND p.status = 'CONFIRMED') c
     WHERE ${Prisma.join(conds, ' AND ')}
     ORDER BY ${order}
     LIMIT ${q.pageSize + 1} OFFSET ${offset}`;

  const hasMore = found.length > q.pageSize;
  const pageIds = found.slice(0, q.pageSize);
  const rows = await prisma.match.findMany({ where: { id: { in: pageIds.map((r) => r.id) } }, include: matchInclude });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = pageIds.map((r) => byId.get(r.id)).filter((r): r is MatchRow => r !== undefined);
  const distances = new Map(pageIds.filter((r) => r.distance_km !== null).map((r) => [r.id, Number(r.distance_km)]));

  return { matches: await toDtos(ordered, actor, distances), page: q.page, pageSize: q.pageSize, hasMore };
}

/** My matches: organized by me / I am confirmed in / I asked to join. */
/** The viewer's matches by role (organized / playing / requested) and scope (upcoming / past). */
export async function myMatches(actor: Actor, q: z.infer<typeof mineSchema>) {
  const now = new Date();
  const time: Prisma.MatchWhereInput = q.scope === 'upcoming' ? { endAt: { gte: now } } : { endAt: { lt: now } };
  const where: Prisma.MatchWhereInput =
    q.role === 'organized'
      ? { organizerId: actor.userId, ...time }
      : q.role === 'playing'
        ? { participants: { some: { userId: actor.userId, status: 'CONFIRMED' } }, ...time }
        : { requests: { some: { userId: actor.userId, status: 'PENDING' } }, ...time };

  const rows = await prisma.match.findMany({
    where,
    include: matchInclude,
    orderBy: [{ startAt: q.scope === 'upcoming' ? 'asc' : 'desc' }, { id: 'asc' }],
    skip: (q.page - 1) * q.pageSize,
    take: q.pageSize + 1,
  });
  return { matches: await toDtos(rows.slice(0, q.pageSize), actor), page: q.page, pageSize: q.pageSize, hasMore: rows.length > q.pageSize };
}
