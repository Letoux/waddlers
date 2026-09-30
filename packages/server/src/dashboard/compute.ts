import {
  DASHBOARD_FX_CURRENT_LABEL,
  type AppliedFxRate,
  type DashboardHeadline,
  type DashboardHistoryOutput,
  type DashboardMoversOutput,
  type DashboardSummaryOutput,
  type FxMode,
} from '@waddlers/contracts';
import {
  DEFAULT_TOLERANCE_DAYS,
  Decimal,
  buildValueSeries,
  compareDates,
  computeMovers,
  computeSpaceValue,
  decimalToString,
  diffDays,
  eurPerUnit,
  normalizeCurrency,
  parseDecimal,
  targetBaseDate,
  type FxHistory,
  type FxPoint,
  type Headline,
  type Period,
  type PlainDate,
  type ValueSeries,
} from '@waddlers/domain';
import type { CloseRow, FxRow, SpacePositionData } from './repository';

/**
 * Pure dashboard computations: selects inputs and maps results to wire shapes. All arithmetic is
 * the domain module's (`computeSpaceValue`, `buildValueSeries`, `computeMovers`, `convert`).
 */

/** Reference currency of every space (D7). */
export const REFERENCE_CURRENCY = 'EUR';
/** Wire rounding (half-even, once, from the domain's full-precision result): same scale as storage. */
export const WIRE_SCALE = 8;
/** History forward-fill tolerance (closes AND FX), calendar days: the domain default, passed explicitly. */
export const HISTORY_TOLERANCE_DAYS = DEFAULT_TOLERANCE_DAYS;
/**
 * A price older than this many calendar days (vs the current UTC date) is flagged stale. 5 covers
 * a weekend plus a market holiday (Thursday close seen on Tuesday); beyond it the worker is late
 * or the listing is not trading.
 */
export const STALE_AFTER_DAYS = 5;

export function wire(value: Decimal | null): string | null {
  return value === null ? null : decimalToString(value.toDecimalPlaces(WIRE_SCALE));
}

const eur = (value: Decimal | null) => ({ amount: wire(value), currency: REFERENCE_CURRENCY });

export function utcToday(now: Date): PlainDate {
  return now.toISOString().slice(0, 10);
}

type Names = ReadonlyMap<string, string>;
const named = (names: Names, ids: readonly string[]) =>
  ids.map((positionId) => ({ positionId, name: names.get(positionId) ?? '' }));

export function positionNames(positions: readonly SpacePositionData[]): Names {
  return new Map(positions.map((p) => [p.id, p.name]));
}

const held = (p: SpacePositionData) => p.quantity !== null;

function majorOf(currency: string): string | null {
  return normalizeCurrency(currency)?.currency ?? null;
}

/** Major non-EUR currencies the HELD positions are priced in (the FX rows to read; watchlist entries need none). */
export function foreignCurrencies(positions: readonly SpacePositionData[]): string[] {
  const set = new Set<string>();
  for (const p of positions) {
    if (!held(p)) continue;
    // The price currency feeds the current value, the listing currency feeds the history.
    for (const cur of [p.metrics?.priceCurrency ?? p.currency, p.currency]) {
      const major = majorOf(cur);
      if (major && major !== REFERENCE_CURRENCY) set.add(major);
    }
  }
  return [...set].sort();
}

/** Newest end-price date over the held positions: "today" of the space. */
export function spaceAsOf(positions: readonly SpacePositionData[]): PlainDate | null {
  let best: PlainDate | null = null;
  for (const p of positions) {
    const d = p.quantity === null ? null : (p.metrics?.asOfDate ?? null);
    if (d !== null && (best === null || compareDates(d, best) > 0)) best = d;
  }
  return best;
}

/** Newest stored rate per currency dated in `[asOf - toleranceDays, asOf]`; older or later rows are ignored. */
export function latestFxRows(
  fxRows: readonly FxRow[],
  asOf: PlainDate,
  toleranceDays: number,
): Map<string, FxRow> {
  const latest = new Map<string, FxRow>();
  for (const r of fxRows) {
    if (compareDates(r.date, asOf) > 0 || diffDays(r.date, asOf) > toleranceDays) continue;
    const cur = latest.get(r.currency);
    if (!cur || compareDates(r.date, cur.date) > 0) latest.set(r.currency, r);
  }
  return latest;
}

export interface CurrentValue {
  total: DashboardSummaryOutput['total'];
  isComplete: boolean;
  missing: DashboardSummaryOutput['missing'];
  heldCount: number;
  valuedCount: number;
  watchlistCount: number;
  freshness: DashboardSummaryOutput['freshness'];
  fxRates: DashboardSummaryOutput['fxRates'];
}

/**
 * Current value: the D21 end price stored in `listing_metrics` (`price`, raw listing currency)
 * x the latest stored FX rate per currency in `[asOf - fxToleranceDays, asOf]`. Missing price or
 * rate -> the position is in `missing` (never 0), the total is partial (D5).
 */
export function computeCurrentValue(
  positions: readonly SpacePositionData[],
  fxRows: readonly FxRow[],
  now: Date,
  fxToleranceDays: number,
): CurrentValue {
  const asOfRef = spaceAsOf(positions);
  const latestFx =
    asOfRef === null ? new Map<string, FxRow>() : latestFxRows(fxRows, asOfRef, fxToleranceDays);
  const rates = new Map<string, Decimal>();
  for (const [currency, row] of latestFx) {
    const rate = parseDecimal(row.ratePerEur);
    if (rate) rates.set(currency, rate);
  }

  const value = computeSpaceValue(
    positions.map((p) => ({
      id: p.id,
      quantity: p.quantity === null ? null : (parseDecimal(p.quantity) ?? new Decimal(NaN)),
      price: p.metrics
        ? { amount: parseDecimal(p.metrics.price), currency: p.metrics.priceCurrency }
        : null,
    })),
    rates,
    REFERENCE_CURRENCY,
  );

  const names = positionNames(positions);
  const byId = new Map(positions.map((p) => [p.id, p]));
  const today = utcToday(now);
  const isOld = (date: PlainDate, days: number) => diffDays(date, today) > days;

  const valued = value.rows.filter((r) => r.value !== null);
  const valuedPositions = valued.flatMap((r) => byId.get(r.positionId) ?? []);
  const priceDates = valuedPositions.flatMap((p) =>
    p.metrics?.asOfDate ? [p.metrics.asOfDate] : [],
  );
  const stalePositions = valuedPositions.flatMap((p) => {
    const asOf = p.metrics?.asOfDate ?? null;
    return asOf !== null && isOld(asOf, STALE_AFTER_DAYS)
      ? [{ positionId: p.id, name: p.name, asOf }]
      : [];
  });
  // FX dates that actually fed a valued position.
  const usedFx = new Set(
    valuedPositions.flatMap((p) => {
      const major = majorOf(p.metrics?.priceCurrency ?? p.currency);
      return major && major !== REFERENCE_CURRENCY ? [major] : [];
    }),
  );
  const fxUsed = [...usedFx].sort().flatMap((c) => latestFx.get(c) ?? []);
  const oldest = (dates: PlainDate[]) =>
    dates.length === 0 ? null : dates.reduce((a, b) => (compareDates(a, b) <= 0 ? a : b));
  const staleFx = fxUsed
    .filter((r) => isOld(r.date, fxToleranceDays))
    .map((r) => ({ currency: r.currency, date: r.date }));

  return {
    total: eur(value.total),
    isComplete: value.isComplete,
    missing: value.missing.map((x) => ({
      positionId: x.positionId,
      name: names.get(x.positionId) ?? '',
      reason: x.reason,
    })),
    heldCount: positions.filter(held).length,
    valuedCount: valued.length,
    watchlistCount: positions.filter((p) => !held(p)).length,
    freshness: {
      asOf: oldest(priceDates),
      fxAsOf: oldest(fxUsed.map((r) => r.date)),
      isStale: stalePositions.length > 0 || staleFx.length > 0,
      stalePositions,
      staleFx,
    },
    // Only the rates that fed a valued position (a watchlist currency is not part of the total).
    fxRates: fxUsed
      .filter((r) => rates.has(r.currency))
      .map((r) => ({
        currency: r.currency,
        ratePerEur: decimalToString(rates.get(r.currency) as Decimal) as string,
        date: r.date,
      })),
  };
}

export interface HistoryFxOptions {
  mode: FxMode;
  /** Range end of the series (the "current" rate is the latest one on or before it). */
  to: PlainDate;
  /** Every date the series may be valued on (closes plus the period start), for `current` mode. */
  dates: readonly PlainDate[];
  fxToleranceDays: number;
}

/**
 * THE seam for FX on the history path (with `readHistoryFx` in service.ts): the only place that
 * decides which rate values a past close (D22).
 * - `historical`: the stored same-day rates as they are; the domain forward-fills them within its
 *   tolerance and reports the rate actually applied to each point.
 * - `current`: the latest stored rate per currency (on or before `to`, at most `fxToleranceDays`
 *   older) is repeated on every date the series can be valued on; no such rate for a currency means
 *   no rate at all for it (its positions are missing every day), never a fallback to 1.
 * `current` returns the rows it used so the response can state their real dates (the repeated
 * points carry the series date, not the rate's).
 */
export function historyFx(
  fxRows: readonly FxRow[],
  options: HistoryFxOptions,
): { fx: FxHistory; current: FxRow[] | null } {
  const fx = new Map<string, FxPoint[]>();
  const push = (currency: string, date: PlainDate, ratePerEur: string) => {
    const rate = parseDecimal(ratePerEur);
    if (rate) fx.set(currency, [...(fx.get(currency) ?? []), { date, rate }]);
  };
  if (options.mode === 'historical') {
    for (const r of fxRows) push(r.currency, r.date, r.ratePerEur);
    return { fx, current: null };
  }
  const latest = latestFxRows(fxRows, options.to, options.fxToleranceDays);
  const dates = [...new Set(options.dates)].sort(compareDates);
  for (const row of latest.values())
    for (const date of dates) push(row.currency, date, row.ratePerEur);
  return { fx, current: [...latest.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1)) };
}

export interface HistoryResult {
  series: ValueSeries;
  from: PlainDate;
  /** `current` FX mode: the rows used for every point; `null` in `historical` mode. */
  currentFx: FxRow[] | null;
}

/** Value series over `[from, to]` from the stored closes/FX (D6, D20). `from` for `max` = first close. */
export function computeHistory(
  positions: readonly SpacePositionData[],
  closes: readonly CloseRow[],
  fxRows: readonly FxRow[],
  period: Period,
  to: PlainDate,
  fxOptions: { mode: FxMode; fxToleranceDays: number },
): HistoryResult {
  const closesByListing = new Map<string, { date: PlainDate; close: Decimal | null }[]>();
  let earliest: PlainDate | null = null;
  for (const c of closes) {
    const list = closesByListing.get(c.listingId) ?? [];
    list.push({ date: c.date, close: parseDecimal(c.close) });
    closesByListing.set(c.listingId, list);
    if (earliest === null || compareDates(c.date, earliest) < 0) earliest = c.date;
  }
  const from = period === 'max' ? (earliest ?? to) : (targetBaseDate(period, to) as PlainDate);
  const { fx, current } = historyFx(fxRows, {
    ...fxOptions,
    to,
    dates: [from, ...closes.map((c) => c.date)],
  });
  const series = buildValueSeries({
    positions: positions.map((p) => ({
      id: p.id,
      quantity: p.quantity === null ? null : (parseDecimal(p.quantity) ?? new Decimal(NaN)),
      currency: p.currency,
      closes: closesByListing.get(p.listingId) ?? [],
    })),
    fx,
    from,
    to,
    referenceCurrency: REFERENCE_CURRENCY,
    toleranceDays: HISTORY_TOLERANCE_DAYS,
  });
  return { series, from, currentFx: current };
}

export function headlineToWire(h: Headline | null): DashboardHeadline | null {
  return h === null
    ? null
    : {
        fromDate: h.fromDate,
        baseDate: h.baseDate,
        toDate: h.toDate,
        startValue: eur(h.startValue),
        endValue: eur(h.endValue),
        change: eur(h.change),
        changePct: wire(h.changePct),
      };
}

function appliedRate(currency: string, rate: Decimal, rateDate: PlainDate): AppliedFxRate {
  return {
    currency,
    ratePerEur: decimalToString(rate) as string,
    eurPerUnit: wire(eurPerUnit(currency, new Map([[currency, rate]]))) as string,
    rateDate,
  };
}

export function historyToWire(
  positions: readonly SpacePositionData[],
  result: HistoryResult | null,
  period: Period,
  asOf: PlainDate | null,
  fxMode: FxMode,
): Omit<DashboardHistoryOutput, 'basis' | 'label'> {
  const names = positionNames(positions);
  const series = result?.series;
  // `current` mode repeats one rate on every date: report that rate's REAL date, not the series date.
  const currentDates = new Map((result?.currentFx ?? []).map((r) => [r.currency, r.date]));
  const currentFxRates =
    fxMode === 'current'
      ? (result?.currentFx ?? []).flatMap((r) => {
          const rate = parseDecimal(r.ratePerEur);
          return rate ? [appliedRate(r.currency, rate, r.date)] : [];
        })
      : null;
  return {
    period,
    currency: REFERENCE_CURRENCY,
    fxMode,
    fxLabel: fxMode === 'current' ? DASHBOARD_FX_CURRENT_LABEL : null,
    currentFxRates,
    points: (series?.points ?? []).map((p) => ({
      date: p.date,
      value: wire(p.value),
      evolutionPct: wire(p.evolutionPct),
      dataDate: p.dataDate,
      fxRates: p.fx.map((f) =>
        appliedRate(f.currency, f.rate, currentDates.get(f.currency) ?? f.date),
      ),
    })),
    totalPoints: series?.totalPoints ?? 0,
    headline: headlineToWire(series?.headline ?? null),
    leadingMissing: named(names, series?.leadingMissing ?? []),
    invalidPositions: (series?.invalidPositions ?? []).map((x) => ({
      positionId: x.positionId,
      name: names.get(x.positionId) ?? '',
      reason: x.reason,
    })),
    asOf,
  };
}

/** Top movers of the period from the materialized performance of each position's listing (D4, D9). */
export function computeMoverLists(
  positions: readonly SpacePositionData[],
  period: Period,
): Omit<DashboardMoversOutput, 'period'> {
  const items = positions.map((p) => {
    const cell = p.metrics?.perf[period];
    return {
      id: p.id,
      name: p.name,
      symbol: p.symbol,
      performance: cell?.baseDate ? parseDecimal(cell.value) : null,
      data: p,
      baseDate: cell?.baseDate ?? null,
    };
  });
  const { gainers, losers } = computeMovers(items);
  const toRow = (i: (typeof items)[number]) => ({
    positionId: i.data.id,
    instrumentId: i.data.instrumentId,
    name: i.data.name,
    symbol: i.data.symbol,
    exchange: { mic: i.data.exchangeMic, name: i.data.exchangeName },
    performancePct: wire(i.performance) as string,
    baseDate: i.baseDate as PlainDate,
    asOf: i.data.metrics?.asOfDate ?? null,
    currency: i.data.metrics?.priceCurrency ?? i.data.currency,
  });
  return { gainers: gainers.map(toRow), losers: losers.map(toRow) };
}
