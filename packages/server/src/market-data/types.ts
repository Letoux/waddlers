import type { PlainDate } from '@waddlers/domain';

/**
 * Provider-facing contracts (no I/O here). The rest of the application never sees a provider:
 * everything goes through MarketDataService (CLAUDE.md section 4).
 *
 * Money conventions: prices are decimal STRINGS in the listing's RAW currency (minor units
 * included: `GBX` = pence); dates are plain `YYYY-MM-DD` strings in the exchange's local timezone.
 */

/** What an adapter needs to know about a listing. */
export interface ListingRef {
  id: string;
  symbol: string;
  /** ISO 10383 MIC. */
  mic: string;
  /** Raw listing currency (`EUR`, `USD`, `GBX`, ...). */
  currency: string;
  /** IANA timezone of the exchange (trade dates are local dates). */
  timezone: string;
  /** Provider-specific symbol (`AI.PA`) when registered in `listing_provider_ids`. */
  providerSymbol: string | null;
}

export const PROVIDER_ERROR_CODES = [
  'timeout',
  'network',
  'rate_limited',
  'upstream_error',
  'quota_exceeded',
  'unauthorized',
  'not_found',
  'bad_payload',
  'unsupported',
  'not_configured',
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/** Transient errors are retried by the wrapper; everything else fails fast. */
export const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  'timeout',
  'network',
  'rate_limited',
  'upstream_error',
]);

/**
 * Outcome of a provider call. Never thrown, never carries 0/NaN for a missing value: an
 * unavailable value is absent (or the whole call is `ok: false`). `source` names the provider,
 * `asOf` is when the PROVIDER says the data is valid (not when we fetched it).
 */
export type ProviderResult<T> =
  | { ok: true; data: T; source: string; asOf: Date }
  | { ok: false; code: ProviderErrorCode; message: string; source: string };

export interface Quote {
  listingId: string;
  /** Positive decimal string in `currency`. */
  price: string;
  currency: string;
  /** Provider timestamp of the price. */
  asOf: Date;
}

export interface QuoteBatch {
  quotes: Quote[];
  /** Listings the provider answered for with an invalid/unknown payload (never stored). */
  rejected: { listingId: string; code: ProviderErrorCode }[];
}

export interface DailyBar {
  date: PlainDate;
  /**
   * SPLIT-ADJUSTED close (D3): the only price basis used by computations. NOT dividend
   * adjusted. See docs/ai/MARKET-DATA.md for the per-provider field mapping.
   */
  close: string;
  /** Provider's fully adjusted close (may include dividends). Informational only. */
  adjClose: string | null;
}

export interface HistoryBatch {
  bars: DailyBar[];
  /** Number of provider rows dropped because a field was invalid (zero, negative, NaN, missing). */
  rejectedRows: number;
  /**
   * True when the series starts at the earliest data the provider has for the listing (the
   * requested `from` was not what truncated it). Only then may `history_complete_from` be set.
   */
  reachedStart: boolean;
}

export interface SearchHit {
  symbol: string;
  mic: string;
  name: string;
  currency: string;
  isin: string | null;
  type: 'stock' | 'etf';
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface MarketDataProvider {
  /** Lower-case identifier stored in `source` columns (`fake`, `eodhd`). */
  readonly name: string;
  getQuotes(
    listings: readonly ListingRef[],
    options?: CallOptions,
  ): Promise<ProviderResult<QuoteBatch>>;
  getDailyHistory(
    listing: ListingRef,
    from: PlainDate,
    to: PlainDate,
    options?: CallOptions,
  ): Promise<ProviderResult<HistoryBatch>>;
  /** Instrument search for the add form (D11). Optional: `unsupported` when absent. */
  search?(query: string, options?: CallOptions): Promise<ProviderResult<SearchHit[]>>;
}

export interface FxRate {
  date: PlainDate;
  /** Major currency code, never EUR. */
  currency: string;
  /** Units of `currency` per 1 EUR (positive decimal string). */
  ratePerEur: string;
}

export interface FxBatch {
  rates: FxRate[];
  rejectedRows: number;
}

export interface FxProvider {
  readonly name: string;
  /** EUR-based reference rates for the inclusive range, weekdays/publication days only. */
  getDailyRates(
    from: PlainDate,
    to: PlainDate,
    options?: CallOptions,
  ): Promise<ProviderResult<FxBatch>>;
}

/** Thrown by a stub adapter that is selected but has no implementation/credentials yet. */
export class NotConfiguredError extends Error {
  constructor(provider: string) {
    super(`${provider} adapter is not configured`);
    this.name = 'NotConfiguredError';
  }
}

export type Clock = () => Date;

export interface MarketLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: MarketLogger = {
  info: (message, fields) => console.info(JSON.stringify({ level: 'info', message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: 'warn', message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: 'error', message, ...fields })),
};

export const silentLogger: MarketLogger = { info() {}, warn() {}, error() {} };

export function ok<T>(source: string, data: T, asOf: Date): ProviderResult<T> {
  return { ok: true, data, source, asOf };
}

export function fail<T = never>(
  source: string,
  code: ProviderErrorCode,
  message: string,
): ProviderResult<T> {
  return { ok: false, code, message, source };
}
