import { addDays, compareDates, type PlainDate } from '@waddlers/domain';
import { normalizeBars, normalizeQuote } from './bars';
import { isWeekday, previousWeekdayOnOrBefore, utcDate } from './dates';
import {
  fail,
  ok,
  type CallOptions,
  type Clock,
  type HistoryBatch,
  type ListingRef,
  type MarketDataProvider,
  type ProviderErrorCode,
  type ProviderResult,
  type QuoteBatch,
  type SearchHit,
} from './types';

/**
 * Deterministic development/E2E provider. Everything derives from the listing id and the date,
 * never from wall-clock randomness, so two runs (or two processes) agree.
 *
 * PRICE BASIS: `close` emulates a SPLIT-ADJUSTED, NOT dividend-adjusted close (the D3 basis).
 * The fake never has a split, so its raw and split-adjusted closes coincide; `adjusted_close`
 * emulates a fully (dividend) adjusted close that differs from `close` on purpose, to prove that
 * nothing downstream reads it.
 */

export type FakeFailure =
  | { mode: 'none' }
  /** Every call returns `ok: false` with this code. */
  | { mode: 'error'; code: ProviderErrorCode }
  /** Calls succeed but rows carry zero/negative/NaN/missing values (must be rejected per field). */
  | { mode: 'malformed' }
  /** Calls never settle until aborted (exercises the wrapper timeout). */
  | { mode: 'hang' };

export interface FakeProviderOptions {
  clock?: Clock;
  failure?: FakeFailure;
}

/** 32-bit string hash (xmur3 finalizer). Not cryptographic. */
function hash32(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic uniform value in [0, 1) for a key. */
export function unit(...parts: string[]): number {
  return hash32(parts.join('|')) / 4294967296;
}

const EPOCH_START = '2001-01-01';
const INCEPTION_SPAN_DAYS = 21 * 365;
const ADJUSTMENT_ANCHOR_YEAR = 2030;

/** First trading day of a fake listing: weekday within 2001-2021, by listing id. */
export function fakeInceptionDate(listingId: string): PlainDate {
  const offset = Math.floor(unit(listingId, 'inception') * INCEPTION_SPAN_DAYS);
  let date = addDays(EPOCH_START, offset);
  while (!isWeekday(date)) date = addDays(date, 1);
  return date;
}

function startPrice(listing: ListingRef): number {
  const major = 10 + unit(listing.id, 'start') * 490;
  // Pence-quoted lines (GBX/GBp/ZAc) trade in the minor unit: x100, matching the listing currency.
  return listing.currency === 'GBX' || listing.currency === 'GBp' || listing.currency === 'ZAc'
    ? major * 100
    : major;
}

function dailyReturn(listingId: string, date: PlainDate): number {
  return (unit(listingId, date) - 0.5) * 0.04 + 0.0002;
}

/** Closes of every weekday from inception through `to`, as floats (fake data only). */
function* walk(listing: ListingRef, to: PlainDate): Generator<{ date: PlainDate; close: number }> {
  let date = fakeInceptionDate(listing.id);
  let price = startPrice(listing);
  while (compareDates(date, to) <= 0) {
    if (isWeekday(date)) {
      price *= 1 + dailyReturn(listing.id, date);
      yield { date, close: price };
    }
    date = addDays(date, 1);
  }
}

function adjustmentFactor(date: PlainDate): number {
  const yearsToAnchor = Math.max(0, ADJUSTMENT_ANCHOR_YEAR - Number(date.slice(0, 4)));
  return Math.max(0.5, 1 - 0.015 * yearsToAnchor);
}

/** Last COMPLETED session date at `now`: today's bar only exists after 21:00 UTC on a weekday. */
export function lastCompletedSession(now: Date): PlainDate {
  const today = utcDate(now);
  const candidate = now.getUTCHours() >= 21 ? today : addDays(today, -1);
  return previousWeekdayOnOrBefore(candidate);
}

const SEARCH_CATALOGUE: readonly SearchHit[] = [
  {
    symbol: 'AI',
    mic: 'XPAR',
    name: 'Air Liquide',
    currency: 'EUR',
    isin: 'FR0000120073',
    type: 'stock',
  },
  { symbol: 'MC', mic: 'XPAR', name: 'LVMH', currency: 'EUR', isin: 'FR0000121014', type: 'stock' },
  {
    symbol: 'CW8',
    mic: 'XPAR',
    name: 'Amundi MSCI World UCITS ETF EUR',
    currency: 'EUR',
    isin: 'LU1681043599',
    type: 'etf',
  },
  { symbol: 'SAP', mic: 'XETR', name: 'SAP', currency: 'EUR', isin: 'DE0007164600', type: 'stock' },
  {
    symbol: 'SHEL',
    mic: 'XLON',
    name: 'Shell',
    currency: 'GBX',
    isin: 'GB00BP6MXD84',
    type: 'stock',
  },
  {
    symbol: 'MSFT',
    mic: 'XNAS',
    name: 'Microsoft',
    currency: 'USD',
    isin: 'US5949181045',
    type: 'stock',
  },
  {
    symbol: 'AAPL',
    mic: 'XNAS',
    name: 'Apple',
    currency: 'USD',
    isin: 'US0378331005',
    type: 'stock',
  },
];

export class FakeMarketDataProvider implements MarketDataProvider {
  readonly name = 'fake';
  failure: FakeFailure;
  readonly calls = { quotes: 0, history: 0, search: 0 };
  private readonly clock: Clock;

  constructor(options: FakeProviderOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.failure = options.failure ?? { mode: 'none' };
  }

  setFailure(failure: FakeFailure): void {
    this.failure = failure;
  }

  /** Non-null when the configured failure mode replaces the normal answer. */
  private async injected<T>(options?: CallOptions): Promise<ProviderResult<T> | null> {
    if (this.failure.mode === 'error')
      return fail(this.name, this.failure.code, 'injected failure');
    if (this.failure.mode === 'hang') {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        options?.signal?.addEventListener('abort', () => resolve());
      });
      return fail(this.name, 'timeout', 'injected hang aborted');
    }
    return null;
  }

  async getQuotes(
    listings: readonly ListingRef[],
    options?: CallOptions,
  ): Promise<ProviderResult<QuoteBatch>> {
    this.calls.quotes += 1;
    const injected = await this.injected<QuoteBatch>(options);
    if (injected) return injected;
    const now = this.clock();
    const session = lastCompletedSession(now);
    const weekend = !isWeekday(utcDate(now));
    // Weekend: the price is Friday's close stamped at Friday's session end. Weekday: the last
    // completed close moved by a small bucketed move, stamped at the 15-minute bucket.
    const asOf = weekend
      ? new Date(`${session}T20:00:00Z`)
      : new Date(Math.floor(now.getTime() / 900_000) * 900_000);
    const quotes: QuoteBatch['quotes'] = [];
    const rejected: QuoteBatch['rejected'] = [];
    let index = 0;
    for (const listing of listings) {
      let last = 0;
      for (const bar of walk(listing, session)) last = bar.close;
      const bucket = String(Math.floor(asOf.getTime() / 900_000));
      const move = weekend ? 0 : (unit(listing.id, 'quote', bucket) - 0.5) * 0.01;
      let price: unknown = last > 0 ? (last * (1 + move)).toFixed(4) : null;
      if (this.failure.mode === 'malformed' && index % 2 === 0)
        price = [0, -1, Number.NaN, null][index % 4];
      index += 1;
      const quote = normalizeQuote(listing, { price, currency: listing.currency, asOf });
      if (quote) quotes.push(quote);
      else rejected.push({ listingId: listing.id, code: 'bad_payload' });
    }
    return ok(this.name, { quotes, rejected }, now);
  }

  async getDailyHistory(
    listing: ListingRef,
    from: PlainDate,
    to: PlainDate,
    options?: CallOptions,
  ): Promise<ProviderResult<HistoryBatch>> {
    this.calls.history += 1;
    const injected = await this.injected<HistoryBatch>(options);
    if (injected) return injected;
    const now = this.clock();
    const last = lastCompletedSession(now);
    const effectiveTo = compareDates(to, last) > 0 ? last : to;
    const rows: { date: string; close: unknown; adjusted_close: unknown }[] = [];
    let i = 0;
    for (const bar of walk(listing, effectiveTo)) {
      if (compareDates(bar.date, from) < 0) continue;
      let close: unknown = bar.close.toFixed(4);
      if (this.failure.mode === 'malformed' && i % 5 === 3)
        close = [0, -3, Number.NaN, undefined][((i / 5) % 4) | 0];
      rows.push({
        date: bar.date,
        close,
        adjusted_close: (bar.close * adjustmentFactor(bar.date)).toFixed(4),
      });
      i += 1;
    }
    const normalized = normalizeBars(rows, { from, to: effectiveTo });
    if ('error' in normalized)
      return fail(this.name, normalized.error, 'malformed history payload');
    return ok(
      this.name,
      {
        ...normalized,
        // Truncated by the request only when `from` is after the inception.
        reachedStart: compareDates(from, fakeInceptionDate(listing.id)) <= 0,
      },
      now,
    );
  }

  async search(query: string, options?: CallOptions): Promise<ProviderResult<SearchHit[]>> {
    this.calls.search += 1;
    const injected = await this.injected<SearchHit[]>(options);
    if (injected) return injected;
    const q = query.trim().toLowerCase();
    const hits =
      q.length === 0
        ? []
        : SEARCH_CATALOGUE.filter(
            (h) =>
              h.symbol.toLowerCase().includes(q) ||
              h.name.toLowerCase().includes(q) ||
              h.isin?.toLowerCase() === q,
          );
    return ok(this.name, [...hits], this.clock());
  }
}
