import { localParts, zonedToUtc } from '../../src/lib/time';
import type { startApp } from './client';
import type { TestUser } from './users';

type Api = Awaited<ReturnType<typeof startApp>>;
export const TZ = 'Asia/Hebron';

/** The UTC instant of `hour:minute` (venue-local, Asia/Hebron) `daysAhead` days from now. */
export function localSlot(daysAhead: number, hour: number, minute = 0): Date {
  const p = localParts(new Date(Date.now() + daysAhead * 86_400_000), TZ);
  return zonedToUtc(p.year, p.month, p.day, hour, minute, TZ);
}

export const plusMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

export const allWeek = (open = '08:00', close = '23:00') =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open, close }));

/** A venue with one F7 field (100/hour, 60-minute slots) open 08:00-23:00 every day. */
export async function setupVenue(api: Api, owner: TestUser, cityId: string, opts: { price?: number; slotMinutes?: number } = {}) {
  const venue = await api.call(
    'POST',
    '/api/v1/venues',
    { name: 'Hebron Arena', cityId, address: 'Ein Sara St', latitude: 31.53, longitude: 35.1, contactPhone: '+970591234567' },
    owner.token,
  );
  if (venue.status !== 201) throw new Error(`venue setup failed: ${JSON.stringify(venue.body)}`);
  const venueId = venue.body.venue.id as string;

  const field = await api.call(
    'POST',
    `/api/v1/venues/${venueId}/fields`,
    { name: 'Field 1', format: 'F7', pricePerHour: opts.price ?? 100, slotMinutes: opts.slotMinutes ?? 60 },
    owner.token,
  );
  const fieldId = field.body.field.id as string;
  const hours = await api.call('PUT', `/api/v1/fields/${fieldId}/opening-hours`, { hours: allWeek() }, owner.token);
  if (hours.status !== 200) throw new Error(`hours setup failed: ${JSON.stringify(hours.body)}`);
  return { venueId, fieldId };
}
