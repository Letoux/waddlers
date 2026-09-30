import { addDays, type PlainDate } from '@waddlers/domain';

/** Exchange-local calendar date of an instant (`YYYY-MM-DD`). Throws RangeError on a bad timezone. */
export function localDate(instant: Date, timeZone: string): PlainDate {
  // en-CA formats as YYYY-MM-DD; formatToParts avoids relying on that locale detail.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 0 = Sunday ... 6 = Saturday, for a plain date. */
export function dayOfWeek(date: PlainDate): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isWeekday(date: PlainDate): boolean {
  const d = dayOfWeek(date);
  return d !== 0 && d !== 6;
}

/** Most recent weekday on or before `date`. */
export function previousWeekdayOnOrBefore(date: PlainDate): PlainDate {
  let d = date;
  while (!isWeekday(d)) d = addDays(d, -1);
  return d;
}

export function utcDate(instant: Date): PlainDate {
  return instant.toISOString().slice(0, 10);
}
