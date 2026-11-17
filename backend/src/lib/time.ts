/*
 * Venue opening hours are LOCAL wall-clock times in the venue's IANA time zone; everything else is UTC.
 * These helpers convert between the two using the runtime's time-zone database (no extra dependency),
 * so daylight-saving rule changes only need a Node / tzdata update.
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday ... 6 = Saturday (same as VenueOpeningHours.weekday)
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return {
    year,
    month,
    day,
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** Offset of `timeZone` from UTC at the given instant, in ms (positive east of Greenwich). */
function offsetMs(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - (date.getTime() - date.getUTCMilliseconds());
}

/** The UTC instant at which the wall clock in `timeZone` shows y-m-d hh:mm. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let t = naive - offsetMs(new Date(naive), timeZone);
  const corrected = naive - offsetMs(new Date(t), timeZone); // handles instants right at a DST change
  if (corrected !== t) t = corrected;
  return new Date(t);
}

export function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Prisma `@db.Time` columns come back as a Date on 1970-01-01 (UTC fields hold the time). */
export function timeColumnToMinutes(value: Date): number {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

export function minutesToTimeColumn(minutes: number): Date {
  return new Date(Date.UTC(1970, 0, 1, Math.floor(minutes / 60), minutes % 60));
}

/** "HH:mm" -> minutes since midnight */
export function parseHm(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h! * 60 + m!;
}

export function formatHm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
