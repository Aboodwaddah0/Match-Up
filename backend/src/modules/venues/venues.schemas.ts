import { z } from 'zod';
import { parseHm } from '../../lib/time';

const format = z.enum(['F5', 'F7', 'F11']);
const permission = z.enum(['MANAGE_BOOKINGS', 'MANAGE_FIELDS', 'MANAGE_AVAILABILITY', 'EDIT_VENUE', 'MANAGE_STAFF', 'VIEW_REPORTS']);
const instant = z.iso.datetime({ offset: true });
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm (24h)');
const ianaZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown IANA time zone');

const venueShape = {
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).nullish(),
  cityId: z.uuid(),
  address: z.string().trim().min(3).max(250),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  contactPhone: z.string().trim().min(5).max(30).nullish(),
  timezone: ianaZone,
};

export const createVenueSchema = z.object({ ...venueShape, timezone: venueShape.timezone.default('Asia/Hebron') });
export const updateVenueSchema = z
  .object({ ...venueShape, status: z.enum(['ACTIVE', 'INACTIVE']) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field');

export const venueSearchSchema = z
  .object({
    q: z.string().trim().min(1).max(60).optional(),
    cityId: z.uuid().optional(),
    format: format.optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusKm: z.coerce.number().min(0.5).max(200).default(10),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { path: ['lat'], message: 'Send lat and lng together' });

export const staffSchema = z.object({
  userId: z.uuid(),
  role: z.enum(['MANAGER', 'STAFF']).default('STAFF'),
  permissions: z.array(permission).max(6).optional(), // omitted -> sensible defaults for the role
});

export const imageSchema = z.object({ url: z.url().refine((u) => u.startsWith('https://'), 'Image must be an https URL') });

export const createFieldSchema = z.object({
  name: z.string().trim().min(1).max(80),
  format,
  capacity: z.number().int().min(1).max(30).optional(), // default: both teams
  pricePerHour: z.number().min(0).max(100_000),
  currency: z.string().length(3).toUpperCase().default('ILS'),
  slotMinutes: z.number().int().min(15).max(240).default(60),
});
export const updateFieldSchema = createFieldSchema
  .omit({ format: true })
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field');

/** Weekly working hours for one field. close must be after open; no overnight ranges (split them). */
export const openingHoursSchema = z.object({
  hours: z
    .array(z.object({ weekday: z.number().int().min(0).max(6), open: hm, close: hm }))
    .max(28)
    .refine((rows) => rows.every((r) => parseHm(r.close) > parseHm(r.open)), 'close must be after open')
    .refine((rows) => {
      for (const day of new Set(rows.map((r) => r.weekday))) {
        const spans = rows.filter((r) => r.weekday === day).map((r) => [parseHm(r.open), parseHm(r.close)] as const).sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < spans.length; i++) if (spans[i]![0] < spans[i - 1]![1]) return false;
      }
      return true;
    }, 'Ranges on the same day must not overlap'),
});

export const availabilitySchema = z.object({ date: z.iso.date() });

export const createBlockSchema = z
  .object({
    startAt: instant,
    endAt: instant,
    reason: z.enum(['MAINTENANCE', 'PRIVATE_EVENT', 'OFFLINE_BOOKING', 'OTHER']).default('OTHER'),
    note: z.string().trim().max(300).nullish(),
    allFields: z.boolean().default(false), // block every active field of the venue at once
  })
  .refine((v) => new Date(v.endAt) > new Date(v.startAt), { path: ['endAt'], message: 'endAt must be after startAt' });

export const listBlocksSchema = z.object({ from: instant.optional() });

export const venueIdParams = z.object({ venueId: z.uuid() });
export const fieldIdParams = z.object({ fieldId: z.uuid() });
export const blockIdParams = z.object({ blockId: z.uuid() });
export const staffParams = z.object({ venueId: z.uuid(), userId: z.uuid() });
export const imageParams = z.object({ venueId: z.uuid(), imageId: z.uuid() });
