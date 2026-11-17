import { z } from 'zod';

const instant = z.iso.datetime({ offset: true });
const status = z.enum(['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'COMPLETED']);

export const createBookingSchema = z
  .object({
    venueFieldId: z.uuid(),
    startAt: instant,
    endAt: instant.optional(),
    durationMinutes: z.number().int().min(15).max(360).optional(),
    notes: z.string().trim().max(300).nullish(),
  })
  .refine((v) => v.endAt !== undefined || v.durationMinutes !== undefined, { path: ['endAt'], message: 'Send endAt or durationMinutes' })
  .refine((v) => !v.endAt || new Date(v.endAt) > new Date(v.startAt), { path: ['endAt'], message: 'endAt must be after startAt' });

/** A booking made outside the app (phone / in person / another app). Self-reported snapshot, never reserves a registered field. */
export const externalBookingSchema = z
  .object({
    extVenueName: z.string().trim().min(2).max(120),
    extVenueAddress: z.string().trim().max(250).nullish(),
    extVenuePhone: z.string().trim().max(30).nullish(),
    extFieldInfo: z.string().trim().max(120).nullish(),
    startAt: instant,
    endAt: instant,
    totalPrice: z.number().min(0).max(100_000),
    currency: z.string().length(3).toUpperCase().default('ILS'),
    notes: z.string().trim().max(300).nullish(),
  })
  .refine((v) => new Date(v.endAt) > new Date(v.startAt), { path: ['endAt'], message: 'endAt must be after startAt' });

const paging = { page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) };

export const myBookingsSchema = z.object({
  status: status.optional(),
  scope: z.enum(['upcoming', 'past', 'all']).default('all'),
  ...paging,
});

export const venueBookingsSchema = z.object({ status: status.optional(), from: instant.optional(), to: instant.optional(), ...paging });

export const reasonSchema = z.object({ reason: z.string().trim().max(300).nullish() });
export const bookingIdParams = z.object({ bookingId: z.uuid() });
export const venueIdParams = z.object({ venueId: z.uuid() });
