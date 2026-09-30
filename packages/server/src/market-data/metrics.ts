import {
  DEFAULT_TOLERANCE_DAYS,
  Decimal,
  PERIODS,
  addDays,
  addMonths,
  compareDates,
  computePerformance,
  convert,
  decimalToString,
  diffDays,
  normalizeCurrency,
  parseDecimal,
  type FxRates,
  type Period,
  type PlainDate,
  type PricePoint,
} from '@waddlers/domain';
import { eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/create';
import { PERF_SCALE, PRICE_SCALE, exchanges, listingMetrics, listings } from '../db/schema';
import { describeError } from '../errors';
import type { MarketDataConfig } from './config';
import { localDate } from './dates';
import {
  closesFrom,
  firstCloseAfterCompleteFrom,
  fxRatesBetween,
  latestCloseBefore,
  latestClosePerListing,
} from './metrics-reads';
import { heldListingIds, readFetchStates, readQuotes } from './repository';
import { silentLogger, type MarketLogger } from './types';

/**
 * `listing_metrics` materialization. All arithmetic is the domain module's (computePerformance,
 * convert): this file only selects inputs and rounds for storage. It never calls a provider.
 *
 * END PRICE RULE (D21, following D20 "on ne ment pas sur la donnee"). The official daily close
 * for a date ALWAYS wins. Let `quoteDate` be the exchange-local date of the latest quote's
 * provider timestamp and `closeDate` the date of the latest stored daily close (in the listing's
 * currency). The end price is the latest CLOSE unless no close exists for a date on or after
 * `quoteDate` (`closeDate < quoteDate`, or no close at all): only then is the QUOTE used, until
 * that day's close arrives. The as-of date used for every performance period is the date of the
 * chosen price. With no quote the close is used; with neither, the price is NULL and every
 * period is unavailable (`end_missing`).
 *
 * FX RULE. price_eur = domain `convert` of the end price with the latest stored EUR-based rate
 * dated on or before the as-of date and at most `fxToleranceDays` older. Otherwise price_eur is
 * NULL (`rate_missing`): a missing rate is never replaced by 1.
 *
 * STORAGE ROUNDING. Values are rounded half-even to the column scale (8 decimals) exactly once,
 * from the domain's full-precision result.
 */

type MetricsValues = Omit<typeof listingMetrics.$inferInsert, 'listingId' | 'computedAt'>;

function store(value: Decimal | null, scale: number): string | null {
  return value === null ? null : decimalToString(value.toDecimalPlaces(scale));
}

const PERIOD_KEY = {
  '1w': 'perf1w',
  '1m': 'perf1m',
  '6m': 'perf6m',
  '1y': 'perf1y',
  '5y': 'perf5y',
  max: 'perfMax',
} as const satisfies Record<Period, string>;

export interface EndPriceInput {
  currency: string;
  timezone: string;
  closes: readonly { date: PlainDate; close: string | null }[];
  quote: { price: string; asOf: Date } | null;
}

export interface EndPrice {
  price: Decimal;
  asOfDate: PlainDate;
  basis: 'quote' | 'close';
  /** Provider timestamp for a quote basis, null for a close basis. */
  priceAsOf: Date | null;
}

/** Applies the END PRICE RULE. Null = no usable price at all. */
export function selectEndPrice(input: EndPriceInput): EndPrice | null {
  let latestClose: { date: PlainDate; close: Decimal } | null = null;
  for (const c of input.closes) {
    const close = parseDecimal(c.close);
    if (close && close.gt(0) && (!latestClose || compareDates(c.date, latestClose.date) > 0)) {
      latestClose = { date: c.date, close };
    }
  }
  const quotePrice = input.quote ? parseDecimal(input.quote.price) : null;
  if (input.quote && quotePrice && quotePrice.gt(0)) {
    const date = localDate(input.quote.asOf, input.timezone);
    // D21: a close dated on/after the quote's day wins (ties go to the official close).
    if (!latestClose || compareDates(date, latestClose.date) > 0) {
      return { price: quotePrice, asOfDate: date, basis: 'quote', priceAsOf: input.quote.asOf };
    }
  }
  return latestClose
    ? { price: latestClose.close, asOfDate: latestClose.date, basis: 'close', priceAsOf: null }
    : null;
}

export interface MetricsInput extends EndPriceInput {
  historyCompleteFrom: PlainDate | null;
  /** Latest tolerance-filtered rate for a MAJOR currency on or before a date. */
  fxRate: (currency: string, date: PlainDate) => { date: PlainDate; ratePerEur: string } | null;
}

/** Pure computation of one listing's metrics (without listing_id / computed_at). */
export function computeMetricsValues(input: MetricsInput): MetricsValues {
  const series: PricePoint[] = input.closes.map((c) => ({
    date: c.date,
    close: parseDecimal(c.close),
  }));
  const end = selectEndPrice(input);

  // price_eur through the domain converter; the rate is looked up separately only to record it.
  let priceEur: Decimal | null = null;
  let reason: string | null = 'price_missing';
  let rateUsed: { date: PlainDate; ratePerEur: string } | null = null;
  if (end) {
    const currency = normalizeCurrency(input.currency);
    if (currency === null) reason = 'currency_invalid';
    else if (currency.currency === 'EUR') {
      priceEur = convert(end.price, input.currency, 'EUR', new Map());
      reason = null;
    } else {
      const found = input.fxRate(currency.currency, end.asOfDate);
      const rate = found ? parseDecimal(found.ratePerEur) : null;
      if (found && rate) {
        const rates: FxRates = new Map([[currency.currency, rate]]);
        priceEur = convert(end.price, input.currency, 'EUR', rates);
        rateUsed = found;
        reason = priceEur === null ? 'rate_missing' : null;
      } else reason = 'rate_missing';
    }
  }
  let priceEurStored = store(priceEur, PRICE_SCALE);
  if (priceEurStored !== null && !new Decimal(priceEurStored).gt(0)) {
    // Never store a 0 as a price.
    priceEurStored = null;
    reason = 'rounds_to_zero';
  }

  const values: Record<string, unknown> = {
    asOfDate: end?.asOfDate ?? null,
    price: store(end?.price ?? null, PRICE_SCALE),
    priceCurrency: input.currency,
    priceBasis: end?.basis ?? null,
    priceAsOf: end?.priceAsOf ?? null,
    priceEur: priceEurStored,
    priceEurReason: priceEurStored === null ? reason : null,
    fxRatePerEur: priceEurStored === null ? null : (rateUsed?.ratePerEur ?? null),
    fxRateDate: priceEurStored === null ? null : (rateUsed?.date ?? null),
  };

  for (const period of PERIODS) {
    const key = PERIOD_KEY[period];
    if (!end) {
      values[key] = null;
      values[`${key}BaseDate`] = null;
      values[`${key}Reason`] = 'end_missing';
      continue;
    }
    const result = computePerformance({
      series,
      period,
      asOf: end.asOfDate,
      end: end.price,
      historyCompleteFrom: input.historyCompleteFrom,
      toleranceDays: METRICS_TOLERANCE_DAYS,
    });
    const stored = store(result.value, PERF_SCALE);
    values[key] = stored;
    values[`${key}BaseDate`] = stored === null ? null : result.baseDate;
    // A non-null domain value always stores as a (possibly 0.00000000) string, never null.
    values[`${key}Reason`] = result.value === null ? result.reason : null;
  }
  return values as MetricsValues;
}

const RECOMPUTE_CHUNK = 500;

type CloseRow = { date: PlainDate; close: string };

/**
 * Base-price tolerance of the metrics (calendar days). ONE constant feeds both the window read
 * (`windowStart`) and `computePerformance` (`toleranceDays`), so the bounded read can never be
 * narrower than what the computation may look back (REVIEW-S4 R3).
 */
export const METRICS_TOLERANCE_DAYS = DEFAULT_TOLERANCE_DAYS;

/** Lower bound of the rows a listing needs: 60 months (the longest fixed period) + base tolerance. */
export function windowStart(asOf: PlainDate): PlainDate {
  return addDays(addMonths(asOf, -60), -METRICS_TOLERANCE_DAYS);
}

interface Prepared {
  listing: { id: string; currency: string; timezone: string };
  base: EndPriceInput;
  end: EndPrice | null;
}

/**
 * Recomputes `listing_metrics` for the given listings (default: every held listing). Idempotent:
 * same inputs, same rows (only `computed_at` moves). Reads Postgres only.
 *
 * Reads are batched over the listings and bounded: per listing only the rows from
 * `asOf - 60 months - tolerance` on, the latest close before that window (so a base lookup
 * fails for the same reason as with the full series) and the first close on/after
 * `history_complete_from` (the `max` base). The result equals the unbounded computation.
 *
 * Failures are isolated per listing: one that cannot be computed (bad timezone, bad data) is
 * logged and counted in `failed`, the others are still stored.
 */
export async function recomputeListingMetrics(
  db: Database,
  options: {
    listingIds?: readonly string[];
    now: Date;
    config: Pick<MarketDataConfig, 'fxToleranceDays'>;
    logger?: MarketLogger;
  },
): Promise<{ computed: number; failed: number }> {
  const ids = options.listingIds ? [...new Set(options.listingIds)] : await heldListingIds(db);
  const total = { computed: 0, failed: 0 };
  const log = options.logger ?? silentLogger;
  for (let i = 0; i < ids.length; i += RECOMPUTE_CHUNK) {
    const part = await recomputeChunk(db, ids.slice(i, i + RECOMPUTE_CHUNK), options, log);
    total.computed += part.computed;
    total.failed += part.failed;
  }
  return total;
}

async function recomputeChunk(
  db: Database,
  ids: string[],
  options: { now: Date; config: Pick<MarketDataConfig, 'fxToleranceDays'> },
  log: MarketLogger,
): Promise<{ computed: number; failed: number }> {
  const meta = await db
    .select({ id: listings.id, currency: listings.currency, timezone: exchanges.timezone })
    .from(listings)
    .innerJoin(exchanges, eq(exchanges.mic, listings.exchangeMic))
    .where(inArray(listings.id, ids));
  const [quotes, historyStates, latest, firsts] = await Promise.all([
    readQuotes(db, ids),
    readFetchStates(db, ids, 'history'),
    latestClosePerListing(db, ids),
    firstCloseAfterCompleteFrom(db, ids),
  ]);

  let failed = 0;
  const fail = (id: string, error: unknown) => {
    failed += 1;
    log.error('listing metrics failed', { listingId: id, error: describeError(error) });
  };

  // Phase 1: the end price decides each listing's as-of date, hence its window.
  const prepared: Prepared[] = [];
  for (const listing of meta) {
    try {
      const q = quotes.get(listing.id);
      const lastClose = latest.get(listing.id);
      const base: EndPriceInput = {
        currency: listing.currency,
        timezone: listing.timezone,
        closes: lastClose ? [lastClose] : [],
        quote: q && q.currency === listing.currency ? { price: q.price, asOf: q.asOf } : null,
      };
      prepared.push({ listing, base, end: selectEndPrice(base) });
    } catch (error) {
      fail(listing.id, error);
    }
  }

  // Phase 2: one bounded window read (shared lower bound, trimmed per listing below).
  const bounds = prepared.flatMap((p) => (p.end ? [windowStart(p.end.asOfDate)] : []));
  const minStart = bounds.reduce<PlainDate | null>(
    (min, d) => (min === null || compareDates(d, min) < 0 ? d : min),
    null,
  );
  const windowRows = new Map<string, CloseRow[]>();
  let anchors = new Map<string, CloseRow>();
  if (minStart !== null) {
    const priced = prepared.filter((p) => p.end).map((p) => p.listing.id);
    for (const r of await closesFrom(db, priced, minStart)) {
      const list = windowRows.get(r.listingId) ?? [];
      list.push(r);
      windowRows.set(r.listingId, list);
    }
    anchors = await latestCloseBefore(db, priced, minStart);
  }

  const fxLookup = await loadFxRates(db, prepared, options.config.fxToleranceDays);

  const rows: (typeof listingMetrics.$inferInsert)[] = [];
  for (const { listing, base, end } of prepared) {
    try {
      const closes = end
        ? boundedSeries(
            windowStart(end.asOfDate),
            windowRows.get(listing.id) ?? [],
            anchors.get(listing.id),
            firsts.get(listing.id),
          )
        : [];
      const values = computeMetricsValues({
        ...base,
        closes,
        historyCompleteFrom: historyStates.get(listing.id)?.historyCompleteFrom ?? null,
        fxRate: fxLookup,
      });
      rows.push({ listingId: listing.id, computedAt: options.now, ...values });
    } catch (error) {
      fail(listing.id, error);
    }
  }
  const stored = await upsertMetricsRows(db, rows, (id, error) => fail(id, error));
  return { computed: stored, failed };
}

/** Rows a listing needs: window bars, the anchor just below the window, the `max` base bar. */
function boundedSeries(
  start: PlainDate,
  window: readonly CloseRow[],
  anchor: CloseRow | undefined,
  first: CloseRow | undefined,
): CloseRow[] {
  const inWindow = window.filter((r) => compareDates(r.date, start) >= 0);
  const below = window.filter((r) => compareDates(r.date, start) < 0);
  const lowest = below.length > 0 ? below[below.length - 1] : anchor;
  const series = [...(lowest ? [lowest] : []), ...inWindow];
  if (first && !series.some((r) => r.date === first.date)) series.unshift(first);
  return series.sort((a, b) => compareDates(a.date, b.date));
}

/**
 * Rate lookup over the batch: one query per currency for the dates involved, then the latest
 * stored rate on or before the price date within `fxToleranceDays` (never carried further).
 */
async function loadFxRates(
  db: Database,
  prepared: readonly Prepared[],
  toleranceDays: number,
): Promise<MetricsInput['fxRate']> {
  const dates = new Map<string, PlainDate[]>();
  for (const { listing, end } of prepared) {
    const major = normalizeCurrency(listing.currency)?.currency;
    if (!end || !major || major === 'EUR') continue;
    dates.set(major, [...(dates.get(major) ?? []), end.asOfDate]);
  }
  const found = new Map<string, { date: PlainDate; ratePerEur: string } | null>();
  for (const [currency, list] of dates) {
    const sorted = [...list].sort(compareDates);
    const rates = await fxRatesBetween(
      db,
      currency,
      addDays(sorted[0]!, -toleranceDays),
      sorted[sorted.length - 1]!,
    );
    for (const date of sorted) {
      let best: { date: PlainDate; ratePerEur: string } | null = null;
      for (const r of rates) if (compareDates(r.date, date) <= 0) best = r;
      const usableRate = best && diffDays(best.date, date) <= toleranceDays ? best : null;
      found.set(`${currency}|${date}`, usableRate);
    }
  }
  return (currency, date) => found.get(`${currency}|${date}`) ?? null;
}

/** Batched upsert; if a batch fails, falls back to row by row so one bad row cannot sink the rest. */
async function upsertMetricsRows(
  db: Database,
  rows: readonly (typeof listingMetrics.$inferInsert)[],
  onRowError: (listingId: string, error: unknown) => void,
): Promise<number> {
  if (rows.length === 0) return 0;
  const cols = getTableColumns(listingMetrics);
  const set = Object.fromEntries(
    Object.entries(cols)
      .filter(([key]) => key !== 'listingId')
      .map(([key, col]) => [key, sql.raw(`excluded."${col.name}"`)]),
  );
  const upsert = (part: readonly (typeof listingMetrics.$inferInsert)[]) =>
    db
      .insert(listingMetrics)
      .values([...part])
      .onConflictDoUpdate({ target: listingMetrics.listingId, set });
  try {
    await upsert(rows);
    return rows.length;
  } catch {
    let stored = 0;
    for (const row of rows) {
      try {
        await upsert([row]);
        stored += 1;
      } catch (error) {
        onRowError(row.listingId, error);
      }
    }
    return stored;
  }
}
