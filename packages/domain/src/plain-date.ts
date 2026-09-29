/**
 * Calendar date without time or timezone: `YYYY-MM-DD`, in the *exchange-local*
 * calendar. Never derive it from a UTC instant. All arithmetic here is on
 * integer day numbers, so it is independent of the process timezone and DST.
 */
export type PlainDate = string;

interface DateParts {
  y: number;
  m: number;
  d: number;
}

const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parse(date: string): DateParts | null {
  const match = PLAIN_DATE.exec(date);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

function mustParse(date: string): DateParts {
  const p = parse(date);
  if (p === null) throw new RangeError(`Invalid plain date: ${JSON.stringify(date)}`);
  return p;
}

export function isPlainDate(value: string): boolean {
  return parse(value) !== null;
}

export function assertPlainDate(value: string): PlainDate {
  mustParse(value);
  return value;
}

function format(y: number, m: number, d: number): PlainDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Days since 1970-01-01 (proleptic Gregorian). */
function toDayNumber({ y, m, d }: DateParts): number {
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function fromDayNumber(n: number): PlainDate {
  const dt = new Date(n * 86_400_000);
  return format(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(date: PlainDate, days: number): PlainDate {
  return fromDayNumber(toDayNumber(mustParse(date)) + days);
}

/** Calendar months with end-of-month clamping (31 Mar − 1 month = 28/29 Feb). */
export function addMonths(date: PlainDate, months: number): PlainDate {
  const p = mustParse(date);
  const index = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = (((index % 12) + 12) % 12) + 1;
  return format(y, m, Math.min(p.d, daysInMonth(y, m)));
}

/** Whole calendar days from `from` to `to` (positive when `to` is later). */
export function diffDays(from: PlainDate, to: PlainDate): number {
  return toDayNumber(mustParse(to)) - toDayNumber(mustParse(from));
}

/** ISO dates compare correctly as strings. */
export function compareDates(a: PlainDate, b: PlainDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
