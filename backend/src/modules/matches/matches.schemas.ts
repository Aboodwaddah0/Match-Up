import { z } from 'zod';

const format = z.enum(['F5', 'F7', 'F11']);
const skill = z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'PROFESSIONAL']);
const position = z.enum(['GOALKEEPER', 'DEFENDER', 'MIDFIELDER', 'WINGER', 'STRIKER']);
const instant = z.iso.datetime({ offset: true });
const FORMAT_SIZE = { F5: 5, F7: 7, F11: 11 } as const;

export const requiredPositions = z
  .array(z.object({ position, count: z.number().int().min(1).max(11).default(1) }))
  .max(5)
  .refine((a) => new Set(a.map((p) => p.position)).size === a.length, 'Positions must be unique');

/** Fields shared by create and edit. Capacity = players wanted THROUGH THE APP (D13). */
const editable = {
  title: z.string().trim().min(3).max(100),
  description: z.string().trim().max(1000).nullish(),
  notes: z.string().trim().max(500).nullish(),
  startAt: instant,
  endAt: instant,
  durationMinutes: z.number().int().min(30).max(300),
  capacity: z.number().int().min(1),
  requiredSkillLevel: skill.nullish(),
  requiredPositions,
  pricePerPlayer: z.number().min(0).max(10_000).nullish(),
  cityId: z.uuid().nullish(),
  locationName: z.string().trim().max(200).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  // A CONFIRMED booking made by the organizer; null on edit unlinks it.
  bookingId: z.uuid().nullish(),
};

const coordsTogether = (v: { latitude?: number | null; longitude?: number | null }) =>
  (v.latitude == null) === (v.longitude == null);

export const createMatchSchema = z
  .object({
    ...editable,
    endAt: editable.endAt.optional(),
    durationMinutes: editable.durationMinutes.optional(),
    requiredPositions: editable.requiredPositions.default([]),
    format,
    visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PUBLIC'),
  })
  .refine((v) => v.capacity <= 2 * FORMAT_SIZE[v.format], {
    path: ['capacity'],
    message: 'Capacity cannot exceed the total players of the format',
  })
  .refine((v) => !v.endAt || new Date(v.endAt) > new Date(v.startAt), { path: ['endAt'], message: 'endAt must be after startAt' })
  .refine(coordsTogether, { path: ['latitude'], message: 'Send latitude and longitude together' });

/** Edit: any subset. The format, type and visibility are fixed once created. */
export const updateMatchSchema = z
  .object(Object.fromEntries(Object.entries(editable).map(([k, v]) => [k, v.optional()])) as {
    [K in keyof typeof editable]: z.ZodOptional<(typeof editable)[K]>;
  })
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field')
  .refine((v) => !(v.endAt && v.startAt) || new Date(v.endAt) > new Date(v.startAt), { path: ['endAt'], message: 'endAt must be after startAt' })
  .refine((v) => !('latitude' in v || 'longitude' in v) || coordsTogether(v), { path: ['latitude'], message: 'Send latitude and longitude together' });

export const matchIdParams = z.object({ matchId: z.uuid() });
export const requestParams = z.object({ matchId: z.uuid(), requestId: z.uuid() });
export const participantParams = z.object({ matchId: z.uuid(), userId: z.uuid() });

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const searchSchema = z.object({
  cityId: z.uuid().optional(),
  from: instant.optional(),
  to: instant.optional(),
  format: format.optional(),
  skillLevel: skill.optional(),
  position: position.optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  minSpots: z.coerce.number().int().min(1).max(22).default(1),
  includeFull: bool.default(false),
  suitableForMe: bool.default(false),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(0.5).max(200).default(10),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).refine((v) => (v.lat === undefined) === (v.lng === undefined), { path: ['lat'], message: 'Send lat and lng together' });

export const mineSchema = z.object({
  role: z.enum(['organized', 'playing', 'requested']).default('playing'),
  scope: z.enum(['upcoming', 'past']).default('upcoming'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const createRequestSchema = z.object({ message: z.string().trim().max(300).nullish() });
export const cancelSchema = z.object({
  reason: z.string().trim().max(300).nullish(),
  // also cancel the organizer's own in-app booking (frees the venue slot) when nobody else uses it
  releaseBooking: z.boolean().default(false),
});
export const attendanceSchema = z.object({ status: z.enum(['ATTENDED', 'NO_SHOW']) });
export const inviteSchema = z.object({ userId: z.uuid() });
