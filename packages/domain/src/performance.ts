import { Decimal } from './decimal';
import { targetBaseDate, type Period } from './period';
import { assertPlainDate, compareDates, diffDays, type PlainDate } from './plain-date';

/**
 * One daily close in the listing's local currency. `close: null` = no usable value
 * (such points are ignored, never treated as 0).
 *
 * CALLERS MUST PASS SPLIT-ADJUSTED CLOSES (D3, split-adjusted price return): mixing
 * raw and adjusted closes silently corrupts every performance figure. This module
 * takes the series as given and cannot detect it.
 */
export interface PricePoint {
  date: PlainDate;
  close: Decimal | null;
}

export const DEFAULT_TOLERANCE_DAYS = 10;

export interface BaseLookupOptions {
  /** Max calendar days between the target date and the base trading day. Inclusive. */
  toleranceDays?: number;
}

export type UnavailableReason =
  | 'empty_series'
  | 'history_starts_after_target'
  | 'gap_exceeds_tolerance'
  | 'non_positive_base'
  | 'end_missing'
  | 'end_invalid'
  | 'history_completeness_unknown'
  | 'insufficient_history';

export type BaseLookup =
  | { ok: true; date: PlainDate; close: Decimal }
  | { ok: false; reason: UnavailableReason; date: PlainDate | null };

/** Valid points only, ascending by date; duplicate dates: the last occurrence in input wins. */
export function cleanSeries(series: readonly PricePoint[]): { date: PlainDate; close: Decimal }[] {
  const byDate = new Map<PlainDate, Decimal>();
  for (const p of series) {
    assertPlainDate(p.date);
    if (p.close === null || !p.close.isFinite()) {
      byDate.delete(p.date); // a later null overrides an earlier value for the same date
      continue;
    }
    byDate.set(p.date, p.close);
  }
  return [...byDate.entries()]
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => compareDates(a.date, b.date));
}

/** Latest close on or before `date` within the tolerance, or null. */
export function closeOnOrBefore(
  series: readonly PricePoint[],
  date: PlainDate,
  options: BaseLookupOptions = {},
): { date: PlainDate; close: Decimal } | null {
  const tolerance = options.toleranceDays ?? DEFAULT_TOLERANCE_DAYS;
  let found: { date: PlainDate; close: Decimal } | null = null;
  for (const p of cleanSeries(series)) {
    if (compareDates(p.date, date) > 0) break;
    found = p;
  }
  if (found === null || diffDays(found.date, date) > tolerance) return null;
  return found;
}

/**
 * Base price for a target date: close of the nearest trading day on or before it.
 * Fails (never guesses) when history starts after the target, the nearest earlier
 * point is more than `toleranceDays` away, or the base is <= 0.
 */
export function findBasePrice(
  series: readonly PricePoint[],
  target: PlainDate,
  options: BaseLookupOptions = {},
): BaseLookup {
  assertPlainDate(target);
  const tolerance = options.toleranceDays ?? DEFAULT_TOLERANCE_DAYS;
  const cleaned = cleanSeries(series);
  const first = cleaned[0];
  if (first === undefined) return { ok: false, reason: 'empty_series', date: null };
  if (compareDates(first.date, target) > 0) {
    return { ok: false, reason: 'history_starts_after_target', date: null };
  }
  let base = first;
  for (const p of cleaned) {
    if (compareDates(p.date, target) > 0) break;
    base = p;
  }
  if (diffDays(base.date, target) > tolerance) {
    return { ok: false, reason: 'gap_exceeds_tolerance', date: base.date };
  }
  if (!base.close.gt(0)) return { ok: false, reason: 'non_positive_base', date: base.date };
  return { ok: true, date: base.date, close: base.close };
}

export type PerformanceResult =
  | { value: Decimal; baseDate: PlainDate }
  | { value: null; baseDate: PlainDate | null; reason: UnavailableReason };

export interface PerformanceInput {
  /** Daily closes in the listing's local currency (D4), split-adjusted (D3). */
  series: readonly PricePoint[];
  period: Period;
  /** Exchange-local as-of date the period is measured back from. */
  asOf: PlainDate;
  /** Final price (same currency/adjustment basis as the series). `null` = missing. */
  end: Decimal | null;
  /**
   * D14: earliest date from which the stored history is known to be complete
   * (back to the listing's first trade). Required for `max`, ignored otherwise.
   */
  historyCompleteFrom?: PlainDate | null;
  toleranceDays?: number;
}

/** Performance % = (end / base − 1) × 100, exact Decimal. Unavailable => `value: null` + reason. */
export function computePerformance(input: PerformanceInput): PerformanceResult {
  const { series, period, asOf, end } = input;
  assertPlainDate(asOf);
  if (end === null || !end.isFinite())
    return { value: null, baseDate: null, reason: 'end_missing' };
  // A zero/negative last price is a data artifact, not a market value.
  if (!end.gt(0)) return { value: null, baseDate: null, reason: 'end_invalid' };

  let base: BaseLookup;
  if (period === 'max') {
    const completeFrom = input.historyCompleteFrom ?? null;
    if (completeFrom === null) {
      return { value: null, baseDate: null, reason: 'history_completeness_unknown' };
    }
    assertPlainDate(completeFrom);
    // Base = first datapoint on/after the completeness boundary and not after as-of.
    const first = cleanSeries(series).find(
      (p) => compareDates(p.date, completeFrom) >= 0 && compareDates(p.date, asOf) <= 0,
    );
    if (first === undefined) return { value: null, baseDate: null, reason: 'empty_series' };
    if (compareDates(first.date, asOf) >= 0) {
      // Single datapoint at as-of: no elapsed time, a 0 % "performance" would be fabricated.
      return { value: null, baseDate: first.date, reason: 'insufficient_history' };
    }
    base = first.close.gt(0)
      ? { ok: true, date: first.date, close: first.close }
      : { ok: false, reason: 'non_positive_base', date: first.date };
  } else {
    const target = targetBaseDate(period, asOf) as PlainDate;
    base = findBasePrice(
      series,
      target,
      input.toleranceDays === undefined ? {} : { toleranceDays: input.toleranceDays },
    );
  }

  if (!base.ok) return { value: null, baseDate: base.date, reason: base.reason };
  return {
    value: end.div(base.close).minus(1).times(100),
    baseDate: base.date,
  };
}
