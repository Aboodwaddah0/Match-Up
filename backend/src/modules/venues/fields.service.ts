import type { VenueField, VenueOpeningHours } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { localParts, minutesToTimeColumn, parseHm, timeColumnToMinutes, weekdayOf, zonedToUtc } from '../../lib/time';
import type { Actor } from '../../types/actor';
import { requireVenuePermission } from './venues.access';
import type { createBlockSchema, createFieldSchema, openingHoursSchema, updateFieldSchema } from './venues.schemas';

const FORMAT_SIZE = { F5: 5, F7: 7, F11: 11 } as const;
const MAX_BOOKING_MINUTES = 6 * 60;

/** A field with its venue and weekly hours; 404 if missing. Callers then check permissions on `field.venueId`. */
async function loadField(fieldId: string) {
  const field = await prisma.venueField.findUnique({ where: { id: fieldId }, include: { venue: true, openingHours: true } });
  if (!field) throw new AppError(404, 'FIELD_NOT_FOUND', 'Field not found');
  return field;
}

// ───────────────────────── fields ─────────────────────────

/** Adds a field to a venue (requires MANAGE_FIELDS). Capacity defaults to both teams of the format (2 x players per side). */
export async function createField(actor: Actor, venueId: string, input: z.infer<typeof createFieldSchema>) {
  await requireVenuePermission(actor, venueId, 'MANAGE_FIELDS');
  const f = await prisma.venueField.create({
    data: { ...input, venueId, capacity: input.capacity ?? 2 * FORMAT_SIZE[input.format] },
  });
  return { field: toField(f) };
}

/** Changes a field's name, price or active flag (requires MANAGE_FIELDS on its venue). */
export async function updateField(actor: Actor, fieldId: string, input: z.infer<typeof updateFieldSchema>) {
  const field = await loadField(fieldId);
  await requireVenuePermission(actor, field.venueId, 'MANAGE_FIELDS');
  // Existing PENDING/CONFIRMED bookings are never touched by a price change or deactivation;
  // bookings snapshot their price and the DB refuses NEW requests on an inactive field.
  const f = await prisma.venueField.update({ where: { id: fieldId }, data: input });
  return { field: toField(f) };
}

function toField(f: VenueField) {
  return { id: f.id, venueId: f.venueId, name: f.name, format: f.format, capacity: f.capacity, pricePerHour: Number(f.pricePerHour), currency: f.currency, slotMinutes: f.slotMinutes, isActive: f.isActive };
}

/** Replaces the whole weekly schedule of the field (local wall-clock times in the venue's time zone). */
export async function setOpeningHours(actor: Actor, fieldId: string, input: z.infer<typeof openingHoursSchema>) {
  const field = await loadField(fieldId);
  await requireVenuePermission(actor, field.venueId, 'MANAGE_AVAILABILITY');
  await prisma.$transaction([
    prisma.venueOpeningHours.deleteMany({ where: { fieldId } }),
    prisma.venueOpeningHours.createMany({
      data: input.hours.map((h) => ({ fieldId, weekday: h.weekday, openTime: minutesToTimeColumn(parseHm(h.open)), closeTime: minutesToTimeColumn(parseHm(h.close)) })),
    }),
  ]);
  return { hours: input.hours };
}

// ───────────────────────── blocks (D11: NOT bookings) ─────────────────────────

/**
 * Blocks time on one field, or on every active field of the venue (`allFields`), for maintenance or offline customers.
 * A block is NOT a booking (D11). It never cancels anyone silently: if live bookings overlap, nothing is created and the
 * clashing bookings are returned so the owner can reject / cancel them first. The pre-check is only for a friendly
 * message; the database re-checks atomically (per-field lock + exclusion constraints), so a booking request that
 * sneaks in between the check and the insert still cannot overlap the block.
 */
export async function createBlock(actor: Actor, fieldId: string, input: z.infer<typeof createBlockSchema>) {
  const field = await loadField(fieldId);
  await requireVenuePermission(actor, field.venueId, 'MANAGE_AVAILABILITY');
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);

  const targets = input.allFields
    ? await prisma.venueField.findMany({ where: { venueId: field.venueId, isActive: true }, select: { id: true } })
    : [{ id: fieldId }];

  // Friendly pre-check: never silently cancel a player's booking; tell the owner which ones are in the way.
  const clashing = await prisma.booking.findMany({
    where: {
      venueFieldId: { in: targets.map((t) => t.id) },
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      OR: [{ status: 'CONFIRMED' }, { status: 'PENDING', holdExpiresAt: { gt: new Date() } }],
    },
    select: { id: true, venueFieldId: true, status: true, startAt: true, endAt: true },
  });
  if (clashing.length > 0) {
    throw new AppError(409, 'BLOCK_CONFLICTS_BOOKING', 'There are bookings in this period; reject or cancel them first', clashing);
  }

  const groupId = targets.length > 1 ? randomUUID() : null;
  // DB: per-field lock + exclusion constraints re-check this atomically against concurrent booking requests.
  const blocks = await prisma.$transaction(
    targets.map((t) =>
      prisma.venueBlock.create({
        data: { venueFieldId: t.id, startAt, endAt, reason: input.reason, note: input.note, groupId, createdById: actor.userId },
      }),
    ),
  );
  return { blocks: blocks.map(toBlock) };
}

function toBlock(b: { id: string; venueFieldId: string; startAt: Date; endAt: Date; reason: string; note: string | null; groupId: string | null }) {
  return { id: b.id, fieldId: b.venueFieldId, startAt: b.startAt, endAt: b.endAt, reason: b.reason, note: b.note, groupId: b.groupId };
}

/** Upcoming blocks of a field (from now, or from `from`); requires MANAGE_AVAILABILITY. */
export async function listBlocks(actor: Actor, fieldId: string, from?: string) {
  const field = await loadField(fieldId);
  await requireVenuePermission(actor, field.venueId, 'MANAGE_AVAILABILITY');
  const rows = await prisma.venueBlock.findMany({
    where: { venueFieldId: fieldId, endAt: { gt: from ? new Date(from) : new Date() } },
    orderBy: { startAt: 'asc' },
  });
  return { blocks: rows.map(toBlock) };
}

/** Removes a block, freeing the time again (requires MANAGE_AVAILABILITY on the block's venue). */
export async function deleteBlock(actor: Actor, blockId: string): Promise<void> {
  const block = await prisma.venueBlock.findUnique({ where: { id: blockId }, include: { field: true } });
  if (!block) throw new AppError(404, 'BLOCK_NOT_FOUND', 'Block not found');
  await requireVenuePermission(actor, block.field.venueId, 'MANAGE_AVAILABILITY');
  await prisma.venueBlock.delete({ where: { id: blockId } });
}

// ───────────────────────── availability ─────────────────────────

type FieldWithHours = VenueField & { openingHours: VenueOpeningHours[] };

/** Opening windows (as local minutes-of-day) for a local calendar date. */
function windowsOn(field: FieldWithHours, weekday: number): [number, number][] {
  return field.openingHours
    .filter((h) => h.weekday === weekday)
    .map((h): [number, number] => [timeColumnToMinutes(h.openTime), timeColumnToMinutes(h.closeTime)])
    .sort((a, b) => a[0] - b[0]);
}

/**
 * Service-level booking rules the DB cannot know (they depend on the weekly schedule and time zone):
 * a whole number of slots, starting on a slot boundary, inside ONE opening window of ONE local day.
 */
export function assertBookableWindow(field: FieldWithHours, timeZone: string, startAt: Date, endAt: Date): void {
  const minutes = (endAt.getTime() - startAt.getTime()) / 60_000;
  if (minutes < field.slotMinutes || minutes % field.slotMinutes !== 0 || minutes > MAX_BOOKING_MINUTES) {
    throw new AppError(400, 'INVALID_DURATION', `Duration must be a multiple of ${field.slotMinutes} minutes (max ${MAX_BOOKING_MINUTES / 60} hours)`);
  }
  const s = localParts(startAt, timeZone);
  const e = localParts(endAt, timeZone);
  const startMin = s.hour * 60 + s.minute;
  const endMin = e.hour * 60 + e.minute;
  const sameDay = s.year === e.year && s.month === e.month && s.day === e.day;
  if (startMin % field.slotMinutes !== 0 || s.second !== 0) {
    throw new AppError(400, 'INVALID_START', `Bookings start on ${field.slotMinutes}-minute boundaries`);
  }
  const fits = sameDay && windowsOn(field, s.weekday).some(([open, close]) => startMin >= open && endMin <= close);
  if (!fits) throw new AppError(409, 'OUTSIDE_OPENING_HOURS', 'The field is closed at that time');
}

/**
 * Bookable slots of a field for one LOCAL calendar date in the venue's time zone. A slot is unavailable when it is in the
 * past, or overlaps a CONFIRMED booking, a live PENDING hold (hold not expired), or a block. Public: needs no permission.
 */
export async function getAvailability(fieldId: string, date: string) {
  const field = await loadField(fieldId);
  if (!field.isActive || field.venue.status !== 'ACTIVE') throw new AppError(404, 'FIELD_NOT_FOUND', 'Field not found');
  const tz = field.venue.timezone;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dayStart = zonedToUtc(y, m, d, 0, 0, tz);
  const dayEnd = new Date(zonedToUtc(y, m, d, 23, 59, tz).getTime() + 60_000);
  const now = new Date();

  const [bookings, blocks] = await Promise.all([
    prisma.booking.findMany({
      where: {
        venueFieldId: fieldId,
        startAt: { lt: dayEnd },
        endAt: { gt: dayStart },
        OR: [{ status: 'CONFIRMED' }, { status: 'PENDING', holdExpiresAt: { gt: now } }],
      },
      select: { startAt: true, endAt: true },
    }),
    prisma.venueBlock.findMany({ where: { venueFieldId: fieldId, startAt: { lt: dayEnd }, endAt: { gt: dayStart } }, select: { startAt: true, endAt: true } }),
  ]);
  const taken = [...bookings, ...blocks];
  const overlaps = (s: Date, e: Date) => taken.some((t) => t.startAt < e && t.endAt > s);

  const slots: { startAt: Date; endAt: Date; available: boolean; price: number }[] = [];
  const pricePerSlot = Number(field.pricePerHour) * (field.slotMinutes / 60);
  for (const [open, close] of windowsOn(field, weekdayOf(y, m, d))) {
    for (let t = open; t + field.slotMinutes <= close; t += field.slotMinutes) {
      const startAt = zonedToUtc(y, m, d, Math.floor(t / 60), t % 60, tz);
      const endAt = new Date(startAt.getTime() + field.slotMinutes * 60_000);
      slots.push({ startAt, endAt, available: startAt > now && !overlaps(startAt, endAt), price: Math.round(pricePerSlot * 100) / 100 });
    }
  }
  return { fieldId, date, timezone: tz, slotMinutes: field.slotMinutes, currency: field.currency, slots };
}

