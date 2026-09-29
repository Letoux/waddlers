import { addDays, addMonths, type PlainDate } from './plain-date';

/**
 * Global period selector (specs §11, §31): 1 semaine, 1 mois, 6 mois, 12 mois, 60 mois, Max.
 * Ids are stable API/URL values; `max` has no fixed target date.
 */
export const PERIODS = ['1w', '1m', '6m', '1y', '5y', 'max'] as const;
export type Period = (typeof PERIODS)[number];

export function isPeriod(value: string): value is Period {
  return (PERIODS as readonly string[]).includes(value);
}

/**
 * Target base date for a period, from an exchange-local as-of date.
 * - `1w`: as-of − 7 days.
 * - `1m|6m|1y|5y`: as-of − 1|6|12|60 calendar months, clamped to end of month
 *   (2026-03-31 − 1m = 2026-02-28). Always computed from the as-of date directly
 *   (never by chaining) so clamping cannot drift.
 * - `max`: `null` — the base is the first complete datapoint, see `computePerformance`.
 */
export function targetBaseDate(period: Period, asOf: PlainDate): PlainDate | null {
  switch (period) {
    case '1w':
      return addDays(asOf, -7);
    case '1m':
      return addMonths(asOf, -1);
    case '6m':
      return addMonths(asOf, -6);
    case '1y':
      return addMonths(asOf, -12);
    case '5y':
      return addMonths(asOf, -60);
    case 'max':
      return null;
  }
}
