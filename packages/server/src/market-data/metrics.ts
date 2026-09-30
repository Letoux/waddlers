import {
  Decimal,
  PERIODS,
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
import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/create';
import { PERF_SCALE, PRICE_SCALE, exchanges, listingMetrics, listings } from '../db/schema';
import type { MarketDataConfig } from './config';
import { localDate } from './dates';
import {
  fxRateOnOrBefore,
  heldListingIds,
  readBars,
  readFetchStates,
  readQuotes,
} from './repository';

/**
 * `listing_metrics` materialization. All arithmetic is the domain module's (computePerformance,
 * convert): this file only selects inputs and rounds for storage. It never calls a provider.
 *
 * END PRICE RULE. Let `quoteDate` be the exchange-local date of the latest quote's provider
 * timestamp and `closeDate` the date of the latest stored daily close (in the listing's
 * currency). The end price is the QUOTE when `quoteDate >= closeDate` (the quote is at least as
 * recent as the last close; ties go to the fresher timestamp), otherwise the latest CLOSE. The
 * as-of date used for every performance period is the date of the chosen price. With no close
 * the quote is used, with no quote the close; with neither, the price is NULL and every period
 * is unavailable (`end_missing`).
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
    if (!latestClose || compareDates(date, latestClose.date) >= 0) {
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
    });
    const stored = store(result.value, PERF_SCALE);
    values[key] = stored;
    values[`${key}BaseDate`] = stored === null ? null : result.baseDate;
    values[`${key}Reason`] =
      stored === null ? ('reason' in result ? result.reason : 'rounds_to_zero') : null;
  }
  return values as MetricsValues;
}

/**
 * Recomputes `listing_metrics` for the given listings (default: every held listing). Idempotent:
 * same inputs, same rows (only `computed_at` moves). Reads Postgres only.
 */
export async function recomputeListingMetrics(
  db: Database,
  options: {
    listingIds?: readonly string[];
    now: Date;
    config: Pick<MarketDataConfig, 'fxToleranceDays'>;
  },
): Promise<{ computed: number }> {
  const ids = options.listingIds ? [...new Set(options.listingIds)] : await heldListingIds(db);
  if (ids.length === 0) return { computed: 0 };

  const meta = await db
    .select({ id: listings.id, currency: listings.currency, timezone: exchanges.timezone })
    .from(listings)
    .innerJoin(exchanges, eq(exchanges.mic, listings.exchangeMic))
    .where(inArray(listings.id, ids));
  const quotes = await readQuotes(db, ids);
  const historyStates = await readFetchStates(db, ids, 'history');
  const rateCache = new Map<string, { date: PlainDate; ratePerEur: string } | null>();

  let computed = 0;
  for (const listing of meta) {
    // Closes stored in another currency than the listing's current one are never mixed in.
    const closes = (await readBars(db, listing.id)).filter((b) => b.currency === listing.currency);
    const q = quotes.get(listing.id);
    const base: EndPriceInput = {
      currency: listing.currency,
      timezone: listing.timezone,
      closes,
      quote: q && q.currency === listing.currency ? { price: q.price, asOf: q.asOf } : null,
    };
    const major = normalizeCurrency(listing.currency)?.currency;
    const end = selectEndPrice(base);
    if (end && major && major !== 'EUR') {
      const key = `${major}|${end.asOfDate}`;
      if (!rateCache.has(key)) {
        const found = await fxRateOnOrBefore(db, major, end.asOfDate);
        const usable =
          found && diffDays(found.date, end.asOfDate) <= options.config.fxToleranceDays;
        rateCache.set(key, usable ? found : null);
      }
    }
    const values = computeMetricsValues({
      ...base,
      historyCompleteFrom: historyStates.get(listing.id)?.historyCompleteFrom ?? null,
      fxRate: (currency, date) => rateCache.get(`${currency}|${date}`) ?? null,
    });
    const row = { listingId: listing.id, computedAt: options.now, ...values };
    await db
      .insert(listingMetrics)
      .values(row)
      .onConflictDoUpdate({ target: listingMetrics.listingId, set: row });
    computed += 1;
  }
  return { computed };
}
