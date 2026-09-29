import type { CurrencyCode } from './currency';
import { Decimal } from './decimal';
import { convertAmount, type FxRates } from './fx';
import { DEFAULT_TOLERANCE_DAYS, cleanSeries, type PricePoint } from './performance';
import { assertPlainDate, compareDates, diffDays, type PlainDate } from './plain-date';

export const MAX_SERIES_POINTS = 400;

export interface HistoryPosition {
  id: string;
  /** Current quantity (D6). `null` = watchlist entry, excluded from the series. */
  quantity: Decimal | null;
  /** Local currency of the listing (may be a minor unit such as GBX). */
  currency: CurrencyCode;
  /** Daily closes, local currency, SPLIT-ADJUSTED (D3). */
  closes: readonly PricePoint[];
}

export interface FxPoint {
  date: PlainDate;
  /** `1 EUR = rate <currency>` (ECB convention). */
  rate: Decimal;
}

/** Per major currency, daily EUR-based rates. EUR itself is implicit. */
export type FxHistory = ReadonlyMap<CurrencyCode, readonly FxPoint[]>;

export interface SeriesPoint {
  date: PlainDate;
  /** Reference-currency value; `null` when any counted position is missing that day. */
  value: Decimal | null;
  /** Ids of counted positions that could not be valued that day. Empty when `value` is set. */
  missing: string[];
  /** % change vs the headline start value; `null` when value or start is unavailable. */
  evolutionPct: Decimal | null;
}

export interface Headline {
  fromDate: PlainDate;
  toDate: PlainDate;
  startValue: Decimal;
  endValue: Decimal;
  change: Decimal;
  /** `null` when the start value is <= 0. */
  changePct: Decimal | null;
}

export interface ValueSeries {
  points: SeriesPoint[];
  /** Derived from the same (full-resolution) series as `points`. `null` if < 2 complete points. */
  headline: Headline | null;
  /** Number of points before downsampling. */
  totalPoints: number;
}

export interface ValueSeriesInput {
  positions: readonly HistoryPosition[];
  fx: FxHistory;
  /** Inclusive exchange-local range. */
  from: PlainDate;
  to: PlainDate;
  referenceCurrency?: CurrencyCode;
  /** Forward-fill limit (calendar days) for both closes and FX. */
  toleranceDays?: number;
  maxPoints?: number;
}

interface Dated<T> {
  date: PlainDate;
  v: T;
}

/** Latest entry on/before `date` within `tolerance` days; `sorted` ascending. Binary search. */
function latest<T>(sorted: readonly Dated<T>[], date: PlainDate, tolerance: number): T | null {
  let lo = 0;
  let hi = sorted.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = sorted[mid] as Dated<T>;
    if (compareDates(entry.date, date) <= 0) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return null;
  const found = sorted[idx] as Dated<T>;
  return diffDays(found.date, date) <= tolerance ? found.v : null;
}

/**
 * Deterministic downsampling to at most `max` points, always keeping first and last.
 * Picks indices floor(i·(n−1)/(max−1)); strictly increasing when n > max.
 */
export function downsample<T>(points: readonly T[], max: number = MAX_SERIES_POINTS): T[] {
  if (!Number.isInteger(max) || max < 2) throw new RangeError('max must be an integer >= 2');
  const n = points.length;
  if (n <= max) return [...points];
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) {
    out.push(points[Math.floor((i * (n - 1)) / (max - 1))] as T);
  }
  return out;
}

/**
 * Historical value of the CURRENT positions (D6): Σ current quantity × close(d) × fx(d).
 * This is NOT a real return history (no buys/sells); the UI must label it
 * "valeur des positions actuelles".
 *
 * - Timeline: every date in [from, to] on which at least one counted position has a real close.
 * - Closes and FX are forward-filled within `toleranceDays`; beyond that the position is missing.
 * - A day where any counted position is missing gets `value: null` (never a partial sum
 *   that would look like a drop, never 0).
 * - Headline = first vs last complete point of the full series; downsampling happens after.
 */
export function buildValueSeries(input: ValueSeriesInput): ValueSeries {
  const { positions, fx, from, to } = input;
  assertPlainDate(from);
  assertPlainDate(to);
  const reference = input.referenceCurrency ?? 'EUR';
  const tolerance = input.toleranceDays ?? DEFAULT_TOLERANCE_DAYS;
  const maxPoints = input.maxPoints ?? MAX_SERIES_POINTS;

  const counted = positions
    .filter((p): p is HistoryPosition & { quantity: Decimal } => p.quantity !== null)
    .map((p) => ({
      id: p.id,
      quantity: p.quantity,
      currency: p.currency,
      closes: cleanSeries(p.closes).map((c) => ({ date: c.date, v: c.close })),
    }));

  const fxSeries = new Map<CurrencyCode, Dated<Decimal>[]>();
  for (const [currency, points] of fx) {
    const cleaned = new Map<PlainDate, Decimal>();
    for (const pt of points) if (pt.rate.gt(0)) cleaned.set(pt.date, pt.rate);
    fxSeries.set(
      currency,
      [...cleaned.entries()]
        .map(([date, v]) => ({ date, v }))
        .sort((a, b) => compareDates(a.date, b.date)),
    );
  }

  const dates = new Set<PlainDate>();
  for (const p of counted) {
    for (const c of p.closes) {
      if (compareDates(c.date, from) >= 0 && compareDates(c.date, to) <= 0) dates.add(c.date);
    }
  }
  const timeline = [...dates].sort(compareDates);

  const full: SeriesPoint[] = timeline.map((date) => {
    const rates = new Map<CurrencyCode, Decimal>();
    for (const [currency, series] of fxSeries) {
      const rate = latest(series, date, tolerance);
      if (rate !== null) rates.set(currency, rate);
    }
    const missing: string[] = [];
    let value = new Decimal(0);
    for (const p of counted) {
      const close = latest(p.closes, date, tolerance);
      const converted =
        close === null ? null : convertAmount(close, p.currency, reference, rates as FxRates);
      if (converted === null || !converted.ok) {
        missing.push(p.id);
        continue;
      }
      value = value.plus(p.quantity.times(converted.amount));
    }
    return {
      date,
      value: missing.length === 0 ? value : null,
      missing,
      evolutionPct: null,
    };
  });

  const complete = full.filter((p): p is SeriesPoint & { value: Decimal } => p.value !== null);
  const first = complete[0];
  const last = complete[complete.length - 1];
  let headline: Headline | null = null;
  if (first !== undefined && last !== undefined && first.date !== last.date) {
    headline = {
      fromDate: first.date,
      toDate: last.date,
      startValue: first.value,
      endValue: last.value,
      change: last.value.minus(first.value),
      changePct: first.value.gt(0) ? last.value.div(first.value).minus(1).times(100) : null,
    };
  }

  const start = first !== undefined && first.value.gt(0) ? first.value : null;
  const points = downsample(full, maxPoints).map((p) => ({
    ...p,
    evolutionPct:
      p.value !== null && start !== null ? p.value.div(start).minus(1).times(100) : null,
  }));

  return { points, headline, totalPoints: full.length };
}
