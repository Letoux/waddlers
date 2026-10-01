import { assertReferenceCurrency, type CurrencyCode } from './currency';
import { Decimal, asDecimal } from './decimal';
import { normalizeCurrency } from './currency';
import { convertAmount } from './fx';
import { cleanSeries, resolveTolerance, type PricePoint } from './performance';
import { assertPlainDate, compareDates, dayNumber, type PlainDate } from './plain-date';
import { computeSpaceValue } from './valuation';

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

/** An FX rate that was applied to a point: `1 EUR = rate <currency>` (major currency), and its date. */
export interface AppliedRate {
  currency: CurrencyCode;
  rate: Decimal;
  /** Date of the stored rate actually used (forward-filled within the tolerance), not the point date. */
  date: PlainDate;
}

export interface SeriesPoint {
  date: PlainDate;
  /**
   * Rates applied to this point: one entry per non-reference major currency held by a counted
   * position (GBX is reported as GBP) for which a rate was found, sorted by currency. A
   * currency without a usable rate is absent (and its positions are in `missing`).
   */
  fx: AppliedRate[];
  /** Reference-currency value; `null` when any counted position is missing that day. */
  value: Decimal | null;
  /** Ids of counted positions that could not be valued that day (close or FX missing, invalid quantity). Empty when `value` is set. */
  missing: string[];
  /**
   * Actual date of the closes behind `value`: the most recent close date among the counted
   * positions used that day (a trading day, unlike `date` when it is a weekend target).
   * `null` when `value` is null.
   */
  dataDate: PlainDate | null;
  /** % change vs the headline start value; `null` when the value, the headline or its start (<= 0) is unavailable. */
  evolutionPct: Decimal | null;
}

export interface Headline {
  fromDate: PlainDate;
  /** = the first point's `dataDate`: the actual close date to label "depuis le 5 juin". */
  baseDate: PlainDate;
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
  /** Number of points (after trimming, before downsampling). */
  totalPoints: number;
  /** Counted positions whose quantity is invalid (negative/NaN/Infinity): every day is null. */
  invalidPositions: { positionId: string; reason: 'quantity_invalid' }[];
  /**
   * Ids of counted positions with no usable data at the first point of the period (`from`),
   * set when leading points were trimmed (empty otherwise). Lets the UI say "pas de donnée
   * avant la création de X", including when the trimmed series is empty or has a single point.
   */
  leadingMissing: string[];
}

/**
 * D23: the end of the series, built from exactly the inputs of the current total (the D21 end
 * price of each counted position x the current-rule FX). Same function as the total
 * (`computeSpaceValue`), so `value` equals the space total bit for bit whenever it is complete.
 */
export interface TerminalInput {
  /** The "as of" date of the total; must lie in `[from, to]`, else the terminal is ignored. */
  date: PlainDate;
  /** Per counted position id: the end price in its price currency and its date. Absent / null price = unavailable. */
  prices: ReadonlyMap<
    string,
    { price: Decimal | null; currency: CurrencyCode; date: PlainDate | null }
  >;
  /** Latest rate per major currency (`1 EUR = rate`) with its date, already filtered by the current rule (<= 7 days). */
  rates: ReadonlyMap<CurrencyCode, { rate: Decimal; date: PlainDate }>;
}

export interface ValueSeriesInput {
  positions: readonly HistoryPosition[];
  fx: FxHistory;
  /** Inclusive exchange-local range. */
  from: PlainDate;
  to: PlainDate;
  referenceCurrency?: CurrencyCode;
  /** Forward-fill limit (calendar days) for closes (and for FX unless `fxToleranceDays` is set). */
  toleranceDays?: number;
  /** Forward-fill limit (calendar days) for FX rates; defaults to `toleranceDays`. */
  fxToleranceDays?: number;
  maxPoints?: number;
  /**
   * When given AND complete (every counted position has an end price and a rate), the series ends
   * with a terminal point at `terminal.date` equal to the current total (it replaces a closes-based
   * point of the same date). Incomplete: ignored, the series keeps its real last date.
   */
  terminal?: TerminalInput;
}

interface Dated<T> {
  date: PlainDate;
  /** Day number of `date`, computed once (the lookups below run millions of times on `max`). */
  n: number;
  v: T;
}

/** Latest entry on/before day `n` within `tolerance` days; `sorted` ascending. Binary search. */
function latest<T>(sorted: readonly Dated<T>[], n: number, tolerance: number): Dated<T> | null {
  let lo = 0;
  let hi = sorted.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as Dated<T>).n <= n) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return null;
  const found = sorted[idx] as Dated<T>;
  return n - found.n <= tolerance ? found : null;
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
 * Historical value of the CURRENT positions (D6, D20): Σ current quantity × close(d) × fx(d).
 * This is NOT a real return history (no buys/sells); the UI must label it
 * "valeur des positions actuelles depuis le <headline.fromDate>".
 *
 * - Timeline: `from` itself (valued by carrying closes forward, exactly like the base price
 *   of `computePerformance`: close on or before the target within tolerance, never looking
 *   forward) plus every later date in (from, to] with a real close for a counted position.
 *   Points after `to` are ignored. `from > to` throws RangeError.
 * - Closes are forward-filled within `toleranceDays`, FX within `fxToleranceDays` (default: the same). A close <= 0 is treated as
 *   missing (it can be carried over from an earlier valid close, never becomes a 0 value).
 * - A day where any counted position is missing (no close/FX, invalid quantity) has
 *   `value: null` and lists the ids: never a partial sum, never 0 (D20: no data is shown
 *   before a recent listing exists).
 * - Leading and trailing null points are trimmed: the series starts and ends on a complete
 *   point, so the chart endpoints equal the headline endpoints. Nulls in the middle stay (gaps).
 * - D23: a complete `terminal` point (end prices x current rates, valued like the space total) ends
 *   the series at its date; incomplete or out of range, it is ignored.
 * - Headline = first vs last point of the trimmed series (`fromDate` may be later than `from`).
 *   Downsampling happens after and keeps first and last.
 */
export function buildValueSeries(input: ValueSeriesInput): ValueSeries {
  const { positions, fx, from, to } = input;
  assertPlainDate(from);
  assertPlainDate(to);
  if (compareDates(from, to) > 0) throw new RangeError('from must not be after to');
  const reference = assertReferenceCurrency(input.referenceCurrency ?? 'EUR');
  const tolerance = resolveTolerance(input.toleranceDays);
  const fxTolerance = resolveTolerance(input.fxToleranceDays ?? input.toleranceDays);
  const maxPoints = input.maxPoints ?? MAX_SERIES_POINTS;

  const invalidPositions: ValueSeries['invalidPositions'] = [];
  const counted = positions
    .filter((p) => p.quantity !== null)
    .map((p) => {
      const quantity = asDecimal(p.quantity as Decimal);
      const valid = quantity.isFinite() && !quantity.isNegative();
      if (!valid) invalidPositions.push({ positionId: p.id, reason: 'quantity_invalid' });
      return {
        id: p.id,
        quantity,
        valid,
        currency: p.currency,
        closes: cleanSeries(p.closes).map((c) => ({
          date: c.date,
          n: dayNumber(c.date),
          v: c.close,
        })),
      };
    });

  // FX: same duplicate rule as closes (last occurrence wins; an invalid last value drops the date).
  const fxSeries = new Map<CurrencyCode, Dated<Decimal>[]>();
  for (const [currency, points] of fx) {
    const byDate = new Map<PlainDate, Decimal>();
    for (const pt of points) {
      assertPlainDate(pt.date);
      const rate = asDecimal(pt.rate);
      if (!rate.isFinite() || !rate.gt(0)) byDate.delete(pt.date);
      else byDate.set(pt.date, rate);
    }
    fxSeries.set(
      currency,
      [...byDate.entries()]
        .map(([date, v]) => ({ date, n: dayNumber(date), v }))
        .sort((a, b) => a.n - b.n),
    );
  }

  if (counted.length === 0) {
    return { points: [], headline: null, totalPoints: 0, invalidPositions, leadingMissing: [] };
  }

  const dates = new Set<PlainDate>([from]);
  for (const p of counted) {
    for (const c of p.closes) {
      if (compareDates(c.date, from) >= 0 && compareDates(c.date, to) <= 0) dates.add(c.date);
    }
  }
  const timeline = [...dates].sort(compareDates);

  // Per-position facts that do not depend on the day.
  const majors = counted.map((p) => normalizeCurrency(p.currency)?.currency ?? null);
  const heldCurrencies = [
    ...new Set(majors.filter((m): m is CurrencyCode => m !== null && m !== reference)),
  ].sort();

  const ratesAt = (n: number) => {
    const rates = new Map<CurrencyCode, Decimal>();
    const rateDates = new Map<CurrencyCode, PlainDate>();
    for (const [currency, series] of fxSeries) {
      const rate = latest(series, n, fxTolerance);
      if (rate !== null) {
        rates.set(currency, rate.v);
        rateDates.set(currency, rate.date);
      }
    }
    return { rates, rateDates };
  };

  /**
   * Can `from` be converted to the reference with these rates? Exactly the failure cases of
   * `convertAmount` (invalid currency, missing rate; EUR is implicit), so completeness is decided
   * WITHOUT decimal arithmetic and the sums below are only computed for the points that are kept.
   */
  const convertible = (from: CurrencyCode | null, rates: Map<CurrencyCode, Decimal>): boolean =>
    from !== null &&
    (from === reference ||
      ((from === 'EUR' || rates.has(from)) && (reference === 'EUR' || rates.has(reference))));

  interface Day {
    date: PlainDate;
    n: number;
    fx: AppliedRate[];
    missing: string[];
    dataDate: PlainDate | null;
    /** Terminal day only: the precomputed total (no closes behind it). */
    preset?: Decimal;
  }

  // D23 terminal day: valued by the SAME function as the space total, no tolerance on prices.
  const terminalDay = (): Day | null => {
    const t = input.terminal;
    if (t === undefined || compareDates(t.date, from) < 0 || compareDates(t.date, to) > 0)
      return null;
    const rates = new Map([...t.rates].map(([currency, r]) => [currency, r.rate]));
    const value = computeSpaceValue(
      counted.map((p) => {
        const end = t.prices.get(p.id);
        return {
          id: p.id,
          quantity: p.quantity,
          price:
            end === undefined || end.price === null
              ? null
              : { amount: end.price, currency: end.currency },
        };
      }),
      rates,
      reference,
    );
    if (!value.isComplete || value.total === null) return null;
    const dates = counted.flatMap((p) => {
      const d = t.prices.get(p.id)?.date ?? null;
      return d === null ? [] : [d];
    });
    return {
      date: t.date,
      n: dayNumber(t.date),
      fx: heldCurrencies.flatMap((currency) => {
        const r = t.rates.get(currency);
        return r === undefined ? [] : [{ currency, rate: r.rate, date: r.date }];
      }),
      missing: [],
      dataDate: dates.length === 0 ? null : dates.reduce((a, b) => (a >= b ? a : b)),
      preset: value.total,
    };
  };

  // Phase 1 (every date, lookups only): which positions are missing, which close date is behind
  // the point, which rates were applied. No Decimal sum yet.
  const terminal = terminalDay();
  let days: Day[] = timeline.map((date) => {
    const n = dayNumber(date);
    const { rates, rateDates } = ratesAt(n);
    const missing: string[] = [];
    let dataDate: PlainDate | null = null;
    counted.forEach((p, i) => {
      const close = p.valid ? latest(p.closes, n, tolerance) : null;
      if (close === null || !convertible(majors[i] ?? null, rates)) {
        missing.push(p.id);
        return;
      }
      if (dataDate === null || compareDates(close.date, dataDate) > 0) dataDate = close.date;
    });
    const fx: AppliedRate[] = heldCurrencies.flatMap((currency) => {
      const rate = rates.get(currency);
      const rateDate = rateDates.get(currency);
      return rate !== undefined && rateDate !== undefined
        ? [{ currency, rate, date: rateDate }]
        : [];
    });
    return { date, n, fx, missing, dataDate: missing.length === 0 ? dataDate : null };
  });
  if (terminal !== null) {
    // The terminal point replaces the closes-based day of the same date, or ends the series.
    days = [...days.filter((d) => d.date !== terminal.date), terminal].sort((a, b) => a.n - b.n);
  }

  const complete = (d: Day) => d.missing.length === 0;
  const firstIdx = days.findIndex(complete);
  const leadingMissing = firstIdx === 0 ? [] : [...(days[0] as Day).missing];
  if (firstIdx < 0) {
    return {
      points: [],
      headline: null,
      totalPoints: 0,
      invalidPositions,
      leadingMissing: [...(days[0] as Day).missing],
    };
  }
  let lastIdx = days.length - 1;
  while (!complete(days[lastIdx] as Day)) lastIdx -= 1;
  const trimmed = days.slice(firstIdx, lastIdx + 1);

  // Phase 2: the sum, for the points that survive downsampling only (first and last always do).
  const valueAt = (day: Day): Decimal => {
    if (day.preset !== undefined) return day.preset;
    const { rates } = ratesAt(day.n);
    let value = new Decimal(0);
    for (const p of counted) {
      const close = latest(p.closes, day.n, tolerance);
      const converted =
        close === null ? null : convertAmount(close.v, p.currency, reference, rates);
      if (converted === null || !converted.ok)
        throw new Error('history: completeness invariant broken');
      value = value.plus(p.quantity.times(converted.amount));
    }
    return value;
  };
  const kept = downsample(trimmed, maxPoints).map((d) => ({
    ...d,
    value: complete(d) ? valueAt(d) : null,
  }));

  const first = kept[0] as (typeof kept)[number] & { value: Decimal };
  const last = kept[kept.length - 1] as (typeof kept)[number] & { value: Decimal };
  const headline: Headline | null =
    first.date === last.date
      ? null
      : {
          fromDate: first.date,
          baseDate: first.dataDate as PlainDate,
          toDate: last.date,
          startValue: first.value,
          endValue: last.value,
          change: last.value.minus(first.value),
          changePct: first.value.gt(0) ? last.value.div(first.value).minus(1).times(100) : null,
        };

  const start = headline !== null && headline.startValue.gt(0) ? headline.startValue : null;
  const points: SeriesPoint[] = kept.map((p) => ({
    date: p.date,
    fx: p.fx,
    value: p.value,
    missing: p.missing,
    dataDate: p.dataDate,
    evolutionPct:
      p.value !== null && start !== null ? p.value.div(start).minus(1).times(100) : null,
  }));

  return { points, headline, totalPoints: trimmed.length, invalidPositions, leadingMissing };
}
