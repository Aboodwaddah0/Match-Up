import { Prisma, type MatchStatus } from '@prisma/client';
import type { z } from 'zod';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { notify } from '../notifications/notify';
import type { createMatchSchema, mineSchema, searchSchema, updateMatchSchema } from './matches.schemas';

export interface Actor {
  userId: string;
  role: 'USER' | 'ADMIN';
}

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

async function confirmedCounts(matchIds: string[]): Promise<Map<string, number>> {
  if (matchIds.length === 0) return new Map();
  const rows = await prisma.matchParticipant.groupBy({
    by: ['matchId'],
    where: { matchId: { in: matchIds }, status: 'CONFIRMED' },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.matchId, r._count._all]));
}

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

export async function loadMatch(id: string): Promise<MatchRow> {
  const m = await prisma.match.findUnique({ where: { id }, include: matchInclude });
  if (!m) throw new AppError(404, 'MATCH_NOT_FOUND', 'Match not found');
  return m;
}

/** Private matches exist only for the organizer, invited players, requesters, participants and admins. Blocked users never see each other's matches. */
export async function loadViewableMatch(id: string, actor: Actor): Promise<MatchRow> {
  const m = await loadMatch(id);
  const notFound = new AppError(404, 'MATCH_NOT_FOUND', 'Match not found');
  if (actor.role === 'ADMIN' || m.organizerId === actor.userId) return m;

  const blocked = await prisma.blockedUser.count({
    where: { OR: [{ blockerId: m.organizerId, blockedId: actor.userId }, { blockerId: actor.userId, blockedId: m.organizerId }] },
  });
  if (blocked > 0) throw notFound;

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

async function recordEvent(tx: Prisma.TransactionClient, matchId: string, actorId: string, from: MatchStatus, to: MatchStatus, reason?: string | null) {
  await tx.matchEvent.create({ data: { matchId, actorId, fromStatus: from, toStatus: to, reason: reason ?? undefined } });
}

async function markAdminActor(tx: Prisma.TransactionClient, actor: Actor): Promise<void> {
  // Lets the DB state machine allow admin-only transitions (see fym_match_guard).
  if (actor.role === 'ADMIN') await tx.$queryRaw`SELECT set_config('fym.actor_is_admin', 'true', true)`;
}

async function assertCityExists(cityId?: string | null) {
  if (cityId && !(await prisma.city.findUnique({ where: { id: cityId } }))) throw new AppError(400, 'INVALID_CITY', 'Unknown city');
}

// ───────────────────────── use cases ─────────────────────────

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
async function teamSides(matchId: string, format: keyof typeof FORMAT_SIZE) {
  const sides = await prisma.matchTeam.findMany({
    where: { matchId },
    orderBy: { side: 'asc' },
    include: { team: { select: { id: true, name: true, logoUrl: true } }, _count: { select: { participants: { where: { status: 'CONFIRMED' } } } } },
  });
  return sides.map((s) => ({ side: s.side, team: s.team, rosterCount: s._count.participants, required: FORMAT_SIZE[format] }));
}

export async function updateMatch(actor: Actor, id: string, input: z.infer<typeof updateMatchSchema>) {
  const m = await loadManageableMatch(id, actor);
  if (m.type !== 'OPEN_MATCH' || !['OPEN', 'FULL'].includes(m.status)) {
    throw new AppError(409, 'INVALID_STATE', 'Only open matches can be edited');
  }
  await assertCityExists(input.cityId);
  if (input.capacity !== undefined && input.capacity > 2 * FORMAT_SIZE[m.format]) {
    throw new AppError(400, 'INVALID_CAPACITY', 'Capacity cannot exceed the total players of the format');
  }

  const startAt = input.startAt ? new Date(input.startAt) : m.startAt;
  const keptDuration = m.endAt.getTime() - m.startAt.getTime();
  const endAt = input.endAt
    ? new Date(input.endAt)
    : input.durationMinutes
      ? new Date(startAt.getTime() + input.durationMinutes * MINUTE)
      : input.startAt
        ? new Date(startAt.getTime() + keptDuration)
        : m.endAt;
  const timeChanged = startAt.getTime() !== m.startAt.getTime() || endAt.getTime() !== m.endAt.getTime();

  await prisma.$transaction(async (tx) => {
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
    if (input.requiredPositions) {
      await tx.matchRequiredPosition.deleteMany({ where: { matchId: id } });
      await tx.matchRequiredPosition.createMany({ data: input.requiredPositions.map((p) => ({ matchId: id, ...p })) });
    }
    if (timeChanged) {
      const pending = await tx.matchRequest.findMany({ where: { matchId: id, status: 'PENDING' }, select: { userId: true } });
      await notify(tx, pending.map((r) => r.userId), 'MATCH_TIME_CHANGED', { matchId: id, title: m.title, startAt: startAt.toISOString() }, { type: 'match', id });
    }
  });
  return getMatch(actor, id);
}

export async function cancelMatch(actor: Actor, id: string, reason?: string | null, releaseBooking = false) {
  const m = await loadManageableMatch(id, actor);
  // Organizers cancel before start (or recover a CLOSED_UNCONFIRMED match). Cancelling a match
  // that is already running is an admin decision.
  const organizerStates: MatchStatus[] = ['OPEN', 'FULL', 'SCHEDULED', 'CLOSED_UNCONFIRMED'];
  const adminStates: MatchStatus[] = [...organizerStates, 'IN_PROGRESS'];
  if (!(actor.role === 'ADMIN' ? adminStates : organizerStates).includes(m.status)) {
    throw new AppError(409, 'INVALID_STATE', 'This match cannot be cancelled in its current status');
  }

  await prisma.$transaction(async (tx) => {
    const [participants, requests] = await Promise.all([
      tx.matchParticipant.findMany({ where: { matchId: id, status: 'CONFIRMED' }, select: { userId: true } }),
      tx.matchRequest.findMany({ where: { matchId: id, status: 'PENDING' }, select: { userId: true } }),
    ]);
    await markAdminActor(tx, actor);
    // DB trigger: participants -> MATCH_CANCELLED (slots freed, no penalty), pending requests/invitations expire.
    await tx.match.update({ where: { id }, data: { status: 'CANCELLED', cancelledById: actor.userId, cancelReason: reason ?? undefined } });
    await recordEvent(tx, id, actor.userId, m.status, 'CANCELLED', reason);
    if (releaseBooking && m.bookingId) await releaseLinkedBooking(tx, actor, m.bookingId);
    await notify(tx, [...participants, ...requests].map((r) => r.userId).filter((u) => u !== actor.userId), 'MATCH_CANCELLED',
      { matchId: id, title: m.title, reason: reason ?? null }, { type: 'match', id });
  });
  return getMatch(actor, id);
}

/** Cancels the organizer's own in-app booking so the venue slot is freed; EXTERNAL bookings can only be unlinked. */
async function releaseLinkedBooking(tx: Prisma.TransactionClient, actor: Actor, bookingId: string) {
  const b = await tx.booking.findUnique({ where: { id: bookingId }, include: { field: { select: { venueId: true } } } });
  if (!b || b.source !== 'IN_APP' || !['PENDING', 'CONFIRMED'].includes(b.status)) return;
  if (b.createdById !== actor.userId && actor.role !== 'ADMIN') return;
  await tx.booking.update({ where: { id: bookingId }, data: { status: 'CANCELLED', cancelledById: actor.userId, cancelReason: 'match cancelled' } });
  await tx.bookingEvent.create({ data: { bookingId, actorId: actor.userId, fromStatus: b.status, toStatus: 'CANCELLED', reason: 'match cancelled' } });
  const venue = await tx.venue.findUniqueOrThrow({
    where: { id: b.field!.venueId },
    select: { ownerId: true, staff: { where: { permissions: { has: 'MANAGE_BOOKINGS' } }, select: { userId: true } } },
  });
  const managers = [venue.ownerId, ...venue.staff.map((s) => s.userId)].filter((u) => u !== actor.userId);
  await notify(tx, managers, 'BOOKING_CANCELLED', { bookingId, byVenue: false, reason: 'match cancelled', startAt: b.startAt.toISOString() }, { type: 'booking', id: bookingId });
}

/** Only the organizer (or an admin) confirms the match really took place (D5). */
export async function completeMatch(actor: Actor, id: string) {
  const m = await loadManageableMatch(id, actor);
  if (!['IN_PROGRESS', 'CLOSED_UNCONFIRMED'].includes(m.status)) {
    throw new AppError(409, 'INVALID_STATE', 'Only a started match can be completed');
  }
  await prisma.$transaction(async (tx) => {
    await markAdminActor(tx, actor);
    // DB trigger: stamps completed_at, finalizes attendance (anyone not NO_SHOW -> ATTENDED), 7-day recovery rule.
    await tx.match.update({ where: { id }, data: { status: 'COMPLETED', completedById: actor.userId } });
    await recordEvent(tx, id, actor.userId, m.status, 'COMPLETED');
  });
  return getMatch(actor, id);
}

// ───────────────────────── discovery ─────────────────────────

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
