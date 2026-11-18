import { Prisma, type BookingStatus } from '@prisma/client';
import type { z } from 'zod';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { notify, type NotificationType } from '../notifications/notify';
import { assertBookableWindow } from '../venues/fields.service';
import type { Actor } from '../../types/actor';
import { bookingManagerIds, requireVenuePermission, venueRights } from '../venues/venues.access';
import type { createBookingSchema, externalBookingSchema, myBookingsSchema, venueBookingsSchema } from './bookings.schemas';

/*
 * Booking rules (D1, D11):
 *  - ONLY players/organizers create bookings; venue staff approve/reject (and block time separately).
 *  - IN_APP bookings start PENDING and hold the slot for 2h. The DATABASE sets the hold, expires stale
 *    holds before a new request, forbids overlaps (PENDING + CONFIRMED) and blocked slots, and refuses a
 *    confirm after expiry. This service adds what depends on the weekly schedule / time zone.
 *  - EXTERNAL bookings are self-reported snapshots (CONFIRMED immediately, no registered field).
 */

const include = {
  field: { include: { venue: { select: { id: true, name: true, address: true, latitude: true, longitude: true, contactPhone: true, timezone: true } } } },
  createdBy: { select: { id: true, fullName: true, avatarUrl: true } },
} satisfies Prisma.BookingInclude;
type BookingRow = Prisma.BookingGetPayload<{ include: typeof include }>;

function dto(b: BookingRow) {
  return {
    id: b.id,
    source: b.source,
    status: b.status,
    startAt: b.startAt,
    endAt: b.endAt,
    totalPrice: Number(b.totalPrice),
    currency: b.currency,
    paymentStatus: b.paymentStatus,
    notes: b.notes,
    holdExpiresAt: b.status === 'PENDING' ? b.holdExpiresAt : null,
    decidedAt: b.decidedAt,
    cancelReason: b.cancelReason,
    createdAt: b.createdAt,
    requester: b.createdBy,
    venue: b.field ? { id: b.field.venue.id, name: b.field.venue.name, address: b.field.venue.address, contactPhone: b.field.venue.contactPhone } : null,
    field: b.field ? { id: b.field.id, name: b.field.name, format: b.field.format } : null,
    external:
      b.source === 'EXTERNAL'
        ? { venueName: b.extVenueName, venueAddress: b.extVenueAddress, venuePhone: b.extVenuePhone, fieldInfo: b.extFieldInfo, verified: false }
        : null,
  };
}

async function load(id: string): Promise<BookingRow> {
  const b = await prisma.booking.findUnique({ where: { id }, include });
  if (!b) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
  return b;
}

async function event(tx: Prisma.TransactionClient, bookingId: string, actorId: string | null, from: BookingStatus | null, to: BookingStatus, reason?: string | null) {
  await tx.bookingEvent.create({ data: { bookingId, actorId, fromStatus: from, toStatus: to, reason: reason ?? undefined } });
}

/**
 * When a booking stops being confirmed, active matches that rely on it stay open but are flagged `venueConfirmed: false`
 * (see matches DTO); the organizer and confirmed players are told. Runs inside the caller's transaction.
 */
async function notifyLinkedMatches(tx: Prisma.TransactionClient, bookingId: string, bookingStatus: BookingStatus) {
  const matches = await tx.match.findMany({
    where: { bookingId, status: { in: ['OPEN', 'FULL', 'SCHEDULED', 'IN_PROGRESS'] } },
    select: { id: true, title: true, organizerId: true, participants: { where: { status: 'CONFIRMED' }, select: { userId: true } } },
  });
  for (const m of matches) {
    await notify(tx, [m.organizerId, ...m.participants.map((p) => p.userId)], 'MATCH_VENUE_UNCONFIRMED', { matchId: m.id, title: m.title, bookingId, bookingStatus }, { type: 'match', id: m.id });
  }
}

/**
 * Used when a match is cancelled with `releaseBooking: true`: cancels the organizer's own IN_APP booking so the venue
 * slot is freed, and tells the venue managers. Runs inside the match-cancel transaction, so the match and its booking
 * change together or not at all. EXTERNAL bookings are never cancelled here (nothing to free), and a booking that is
 * not the caller's (or already finished) is silently left alone. Returns true only when a booking was actually cancelled (the
 * admin audit record of a match cancellation names it).
 */
export async function releaseBookingForMatch(tx: Prisma.TransactionClient, actor: Actor, bookingId: string): Promise<boolean> {
  const b = await tx.booking.findUnique({ where: { id: bookingId }, include: { field: { select: { venueId: true } } } });
  if (!b || b.source !== 'IN_APP' || !['PENDING', 'CONFIRMED'].includes(b.status)) return false;
  if (b.createdById !== actor.userId && actor.role !== 'ADMIN') return false;
  await tx.booking.update({ where: { id: bookingId }, data: { status: 'CANCELLED', cancelledById: actor.userId, cancelReason: 'match cancelled' } });
  await event(tx, bookingId, actor.userId, b.status, 'CANCELLED', 'match cancelled');
  const managers = (await bookingManagerIds(b.field!.venueId, tx)).filter((u) => u !== actor.userId);
  await notify(tx, managers, 'BOOKING_CANCELLED', { bookingId, byVenue: false, reason: 'match cancelled', startAt: b.startAt.toISOString() }, { type: 'booking', id: bookingId });
  return true;
}

// ───────────────────────── requester side ─────────────────────────

/**
 * A player / organizer asks for a slot. Creates a PENDING booking that holds the slot for 2 hours.
 * Checked here (needs the weekly schedule and the venue time zone): the field is bookable, the start is in the future,
 * and the window sits inside opening hours on a slot boundary. Checked by the DATABASE (race-proof): overlaps with
 * PENDING / CONFIRMED bookings, blocked time, the 2h hold, and the 3-pending-requests-per-user cap.
 * The price is snapshotted from the hourly rate, so later price changes never touch an existing booking.
 */
export async function createBooking(actor: Actor, input: z.infer<typeof createBookingSchema>) {
  const field = await prisma.venueField.findUnique({ where: { id: input.venueFieldId }, include: { venue: true, openingHours: true } });
  if (!field || !field.isActive || field.venue.status !== 'ACTIVE') throw new AppError(404, 'FIELD_NOT_FOUND', 'Field not found');

  const startAt = new Date(input.startAt);
  const endAt = input.endAt ? new Date(input.endAt) : new Date(startAt.getTime() + input.durationMinutes! * 60_000);
  if (startAt <= new Date()) throw new AppError(400, 'DATE_IN_PAST', 'The booking must start in the future');
  assertBookableWindow(field, field.venue.timezone, startAt, endAt);

  const minutes = (endAt.getTime() - startAt.getTime()) / 60_000;
  const totalPrice = field.pricePerHour.mul(minutes).div(60).toDecimalPlaces(2); // snapshot: later price changes never touch it

  const booking = await prisma.$transaction(async (tx) => {
    // DB trigger: sets the 2h hold, expires stale overlapping holds, rejects blocked/overlapping slots and
    // a 4th simultaneous pending request; the exclusion constraint is the final guard against races.
    const b = await tx.booking.create({
      data: { source: 'IN_APP', status: 'PENDING', createdById: actor.userId, venueFieldId: field.id, startAt, endAt, totalPrice, currency: field.currency, notes: input.notes },
      include,
    });
    await event(tx, b.id, actor.userId, null, 'PENDING');
    const managers = (await bookingManagerIds(field.venueId)).filter((u) => u !== actor.userId);
    await notify(tx, managers, 'BOOKING_REQUEST_RECEIVED', { bookingId: b.id, venueId: field.venueId, fieldName: field.name, startAt: startAt.toISOString() }, { type: 'booking', id: b.id });
    return b;
  });
  return { booking: dto(booking) };
}

/**
 * Records a booking made outside the app (phone, in person, another app). It is a self-reported snapshot:
 * CONFIRMED immediately, never reserves a registered field, and is shown as "reported by the organizer".
 */
export async function createExternalBooking(actor: Actor, input: z.infer<typeof externalBookingSchema>) {
  const b = await prisma.$transaction(async (tx) => {
    const created = await tx.booking.create({
      data: {
        source: 'EXTERNAL',
        status: 'CONFIRMED', // self-reported: nobody approves it, and the UI must show it as "reported by organizer"
        createdById: actor.userId,
        startAt: new Date(input.startAt),
        endAt: new Date(input.endAt),
        totalPrice: input.totalPrice,
        currency: input.currency,
        notes: input.notes,
        extVenueName: input.extVenueName,
        extVenueAddress: input.extVenueAddress,
        extVenuePhone: input.extVenuePhone,
        extFieldInfo: input.extFieldInfo,
      },
      include,
    });
    await event(tx, created.id, actor.userId, null, 'CONFIRMED', 'external booking recorded');
    return created;
  });
  return { booking: dto(b) };
}

/** The caller's own bookings, optionally filtered by status and upcoming / past; pages with `hasMore` (no total count). */
export async function myBookings(actor: Actor, q: z.infer<typeof myBookingsSchema>) {
  const now = new Date();
  const where: Prisma.BookingWhereInput = {
    createdById: actor.userId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.scope === 'upcoming' ? { endAt: { gte: now } } : q.scope === 'past' ? { endAt: { lt: now } } : {}),
  };
  const rows = await prisma.booking.findMany({ where, include, orderBy: [{ startAt: q.scope === 'past' ? 'desc' : 'asc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize + 1 });
  return { bookings: rows.slice(0, q.pageSize).map(dto), page: q.page, pageSize: q.pageSize, hasMore: rows.length > q.pageSize };
}

/**
 * One booking, visible to its requester and to venue staff who manage bookings.
 * Anyone else gets 404 (not 403), so booking ids reveal nothing.
 */
export async function getBooking(actor: Actor, id: string) {
  const b = await load(id);
  const notFound = new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
  if (b.createdById !== actor.userId) {
    if (!b.field) throw notFound;
    const rights = await venueRights(actor, b.field.venue.id);
    if (!rights.can('MANAGE_BOOKINGS')) throw notFound;
  }
  return { booking: dto(b) };
}

/**
 * Cancels a PENDING or CONFIRMED booking. The requester may cancel their own (not after a CONFIRMED booking started).
 * Venue staff may cancel only CONFIRMED bookings (a pending request must be rejected instead, so the requester gets
 * a proper answer). Frees the slot, notifies the other side, and flags matches that relied on it.
 */
export async function cancelBooking(actor: Actor, id: string, reason?: string | null) {
  const b = await load(id);
  const isRequester = b.createdById === actor.userId;

  let byVenue = false;
  if (!isRequester) {
    if (!b.field) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    const rights = await venueRights(actor, b.field.venue.id);
    if (!rights.can('MANAGE_BOOKINGS')) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    if (b.status === 'PENDING') throw new AppError(409, 'USE_REJECT', 'Reject a pending request instead of cancelling it');
    byVenue = true;
  }
  if (!['PENDING', 'CONFIRMED'].includes(b.status)) throw new AppError(409, 'INVALID_STATE', 'This booking can no longer be cancelled');
  if (b.status === 'CONFIRMED' && b.startAt <= new Date() && !byVenue) throw new AppError(409, 'BOOKING_STARTED', 'The booking has already started');

  await prisma.$transaction(async (tx) => {
    await tx.booking.update({ where: { id }, data: { status: 'CANCELLED', cancelledById: actor.userId, cancelReason: reason ?? undefined } });
    await event(tx, id, actor.userId, b.status, 'CANCELLED', reason);
    if (b.field) {
      const targets = byVenue ? [b.createdById] : (await bookingManagerIds(b.field.venue.id)).filter((u) => u !== actor.userId);
      await notify(tx, targets, 'BOOKING_CANCELLED', { bookingId: id, byVenue, reason: reason ?? null, startAt: b.startAt.toISOString() }, { type: 'booking', id });
    }
    await notifyLinkedMatches(tx, id, 'CANCELLED');
  });
  return { booking: dto(await load(id)) };
}

// ───────────────────────── venue side ─────────────────────────

/** The venue's booking inbox (requires MANAGE_BOOKINGS on that venue), filterable by status and start time. */
export async function venueBookings(actor: Actor, venueId: string, q: z.infer<typeof venueBookingsSchema>) {
  await requireVenuePermission(actor, venueId, 'MANAGE_BOOKINGS');
  const where: Prisma.BookingWhereInput = {
    field: { venueId },
    ...(q.status ? { status: q.status } : {}),
    ...(q.from || q.to ? { startAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
  };
  const rows = await prisma.booking.findMany({ where, include, orderBy: [{ startAt: 'asc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize + 1 });
  return { bookings: rows.slice(0, q.pageSize).map(dto), page: q.page, pageSize: q.pageSize, hasMore: rows.length > q.pageSize };
}

/**
 * Staff answer to a PENDING in-app request. Rules: caller needs MANAGE_BOOKINGS (else 404), and cannot answer
 * their own request (another staff member must). The DB trigger refuses a confirmation after the 2h hold expired
 * (using the database clock) and lets a request leave PENDING exactly once, so double answers cannot happen.
 */
async function decide(actor: Actor, id: string, decision: 'CONFIRMED' | 'REJECTED', reason?: string | null) {
  const b = await load(id);
  if (!b.field || b.source !== 'IN_APP') throw new AppError(400, 'NOT_DECIDABLE', 'Only in-app booking requests need a decision');
  const rights = await venueRights(actor, b.field.venue.id);
  if (!rights.can('MANAGE_BOOKINGS')) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
  if (b.createdById === actor.userId) throw new AppError(403, 'CANNOT_DECIDE_OWN_BOOKING', 'Another staff member must answer your own request');
  if (b.status !== 'PENDING') throw new AppError(409, 'INVALID_STATE', 'This request was already answered or expired');

  await prisma.$transaction(async (tx) => {
    // DB trigger: CONFIRMED only while the hold is alive (database clock), PENDING -> terminal exactly once.
    await tx.booking.update({ where: { id }, data: { status: decision, decidedById: actor.userId, ...(decision === 'REJECTED' ? { cancelReason: reason ?? undefined } : {}) } });
    await event(tx, id, actor.userId, 'PENDING', decision, reason);
    const type: NotificationType = decision === 'CONFIRMED' ? 'BOOKING_CONFIRMED' : 'BOOKING_REJECTED';
    await notify(tx, [b.createdById], type, { bookingId: id, venueName: b.field!.venue.name, startAt: b.startAt.toISOString(), reason: reason ?? null }, { type: 'booking', id });
  });
  return { booking: dto(await load(id)) };
}

/** Staff confirm a pending in-app request (see `decide` for the rules). */
export const confirmBooking = (actor: Actor, id: string) => decide(actor, id, 'CONFIRMED');
/** Staff reject a pending in-app request, with an optional reason shown to the requester. The slot is freed at once. */
export const rejectBooking = (actor: Actor, id: string, reason?: string | null) => decide(actor, id, 'REJECTED', reason);
