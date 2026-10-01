import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { listings } from './listings';

/**
 * Market-data persistence (S4). Conventions, all enforced by CHECK constraints:
 * - numeric columns are decimal strings in JS; an unavailable value is NULL, never 0/NaN;
 * - prices are strictly positive (a 0 is a provider artifact, not a market value);
 * - trade dates are exchange-local dates; rates are EUR-based (`1 EUR = rate CCY`);
 * - `source` names the provider that produced the row, `fetched_at` is when WE stored it
 *   (a failed refresh never touches it).
 * Every listing-scoped table references `listings(id)` ON DELETE CASCADE.
 */

const CURRENCY_FORMAT = `~ '^[A-Z]{3}$'`;

/** Positive finite numeric. `<> 'NaN'` matters: PostgreSQL orders NaN above every number. */
function positive(column: unknown) {
  return sql`${column} > 0 and ${column} <> 'NaN'`;
}

/** Prices: numeric(24, 8). Anything that rounds to 0 at 8 decimals violates the CHECK instead of becoming 0. */
export const PRICE_PRECISION = 24;
export const PRICE_SCALE = 8;
/** Percentages (performance): numeric(20, 8). */
export const PERF_PRECISION = 20;
export const PERF_SCALE = 8;
/** FX rates: numeric(20, 10). */
export const FX_PRECISION = 20;
export const FX_SCALE = 10;

/** Daily bars. `close` is the SPLIT-ADJUSTED close used by every computation (D3). */
export const priceDaily = pgTable(
  'price_daily',
  {
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** Exchange-local trading date. */
    tradeDate: date('trade_date', { mode: 'string' }).notNull(),
    close: numeric('close', { precision: PRICE_PRECISION, scale: PRICE_SCALE }),
    /** Provider "fully adjusted" close (may include dividends): informational only, never used. */
    adjClose: numeric('adj_close', { precision: PRICE_PRECISION, scale: PRICE_SCALE }),
    /** Raw listing currency, minor units included (`GBX`): same unit as `close`. */
    currency: text('currency').notNull(),
    source: text('source').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // The primary key also serves range scans per listing (listing_id, trade_date).
    primaryKey({ columns: [table.listingId, table.tradeDate] }),
    check('price_daily_close_positive', sql`${table.close} is null or (${positive(table.close)})`),
    check(
      'price_daily_adj_close_positive',
      sql`${table.adjClose} is null or (${positive(table.adjClose)})`,
    ),
    check(
      'price_daily_currency_format',
      sql`${table.currency} ~ '^[A-Z]{3}$' or ${table.currency} in ('GBp', 'ZAc')`,
    ),
    check('price_daily_source_format', sql`${table.source} ~ '^[a-z][a-z0-9_]{1,31}$'`),
  ],
);

/** Latest known quote per listing (one row, overwritten by each successful refresh). */
export const quoteLatest = pgTable(
  'quote_latest',
  {
    listingId: uuid('listing_id')
      .primaryKey()
      .references(() => listings.id, { onDelete: 'cascade' }),
    price: numeric('price', { precision: PRICE_PRECISION, scale: PRICE_SCALE }).notNull(),
    currency: text('currency').notNull(),
    /** Provider timestamp of the price (not when we fetched it). */
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    source: text('source').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('quote_latest_price_positive', positive(table.price)),
    check(
      'quote_latest_currency_format',
      sql`${table.currency} ~ '^[A-Z]{3}$' or ${table.currency} in ('GBp', 'ZAc')`,
    ),
    check('quote_latest_source_format', sql`${table.source} ~ '^[a-z][a-z0-9_]{1,31}$'`),
  ],
);

/** EUR-based daily FX: `rate_per_eur` = units of `currency` for 1 EUR. EUR itself is never stored. */
export const fxDaily = pgTable(
  'fx_daily',
  {
    rateDate: date('rate_date', { mode: 'string' }).notNull(),
    /** Major currency code (never a minor unit, never EUR). */
    currency: text('currency').notNull(),
    ratePerEur: numeric('rate_per_eur', { precision: FX_PRECISION, scale: FX_SCALE }).notNull(),
    source: text('source').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.rateDate, table.currency] }),
    // "latest rate on or before D for currency C".
    index('fx_daily_currency_date_idx').on(table.currency, table.rateDate),
    check('fx_daily_rate_positive', positive(table.ratePerEur)),
    check(
      'fx_daily_currency_format',
      sql`${table.currency} ${sql.raw(CURRENCY_FORMAT)} and ${table.currency} <> 'EUR'`,
    ),
    check('fx_daily_source_format', sql`${table.source} ~ '^[a-z][a-z0-9_]{1,31}$'`),
  ],
);

export const FETCH_KINDS = ['quote', 'history', 'fx'] as const;
export type FetchKind = (typeof FETCH_KINDS)[number];

/**
 * Negative cache + backoff per (listing, kind); `listing_id` is NULL for FX. Stores an error CODE
 * only (never a provider message: those can embed URLs). `history_complete_from` is the date of
 * the first stored close once the full history from the listing's first trade has been stored.
 */
export const marketDataFetchState = pgTable(
  'market_data_fetch_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id').references(() => listings.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<FetchKind>().notNull(),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    failureCount: integer('failure_count').notNull().default(0),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    historyCompleteFrom: date('history_complete_from', { mode: 'string' }),
  },
  (table) => [
    // NULLS NOT DISTINCT: a single FX row per kind despite listing_id being NULL.
    unique('market_data_fetch_state_listing_kind_unique')
      .on(table.listingId, table.kind)
      .nullsNotDistinct(),
    check('market_data_fetch_state_kind_check', sql`${table.kind} in ('quote', 'history', 'fx')`),
    check(
      'market_data_fetch_state_scope_check',
      sql`(${table.kind} = 'fx') = (${table.listingId} is null)`,
    ),
    check('market_data_fetch_state_failures_check', sql`${table.failureCount} >= 0`),
    check(
      'market_data_fetch_state_error_code_format',
      sql`${table.lastErrorCode} is null or ${table.lastErrorCode} ~ '^[a-z][a-z_]{1,39}$'`,
    ),
    check(
      'market_data_fetch_state_history_kind_check',
      sql`${table.historyCompleteFrom} is null or ${table.kind} in ('history', 'fx')`,
    ),
  ],
);

/** Calls made to a provider per UTC day (daily quota guard). */
export const providerUsage = pgTable(
  'provider_usage',
  {
    provider: text('provider').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    calls: integer('calls').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.day] }),
    check('provider_usage_calls_check', sql`${table.calls} >= 0`),
    check('provider_usage_provider_format', sql`${table.provider} ~ '^[a-z][a-z0-9_]{1,31}$'`),
  ],
);

/** Performance periods stored in `listing_metrics` (same list as `PERIODS` in @waddlers/domain). */
export const METRIC_PERIODS = ['1w', '1m', '6m', '1y', '5y', 'max'] as const;

const perfColumns = () =>
  ({
    perf1w: numeric('perf_1w', { precision: PERF_PRECISION, scale: PERF_SCALE }),
    perf1wBaseDate: date('perf_1w_base_date', { mode: 'string' }),
    perf1wReason: text('perf_1w_reason'),
    perf1m: numeric('perf_1m', { precision: PERF_PRECISION, scale: PERF_SCALE }),
    perf1mBaseDate: date('perf_1m_base_date', { mode: 'string' }),
    perf1mReason: text('perf_1m_reason'),
    perf6m: numeric('perf_6m', { precision: PERF_PRECISION, scale: PERF_SCALE }),
    perf6mBaseDate: date('perf_6m_base_date', { mode: 'string' }),
    perf6mReason: text('perf_6m_reason'),
    perf1y: numeric('perf_1y', { precision: PERF_PRECISION, scale: PERF_SCALE }),
    perf1yBaseDate: date('perf_1y_base_date', { mode: 'string' }),
    perf1yReason: text('perf_1y_reason'),
    perf5y: numeric('perf_5y', { precision: PERF_PRECISION, scale: PERF_SCALE }),
    perf5yBaseDate: date('perf_5y_base_date', { mode: 'string' }),
    perf5yReason: text('perf_5y_reason'),
    perfMax: numeric('perf_max', { precision: PERF_PRECISION, scale: PERF_SCALE }),
    perfMaxBaseDate: date('perf_max_base_date', { mode: 'string' }),
    perfMaxReason: text('perf_max_reason'),
  }) as const;

/**
 * Materialized per-listing figures for S6 SQL sort/filter, computed ONLY with the domain
 * functions (`recomputeListingMetrics`). A row always exists once computed; unavailable values are
 * NULL with a reason code. `perf_*` are percentages in the listing's local currency (D4).
 */
export const listingMetrics = pgTable(
  'listing_metrics',
  {
    listingId: uuid('listing_id')
      .primaryKey()
      .references(() => listings.id, { onDelete: 'cascade' }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
    /** Exchange-local date of the end price (the performance "as of" date). NULL when no price. */
    asOfDate: date('as_of_date', { mode: 'string' }),
    /** Price in the listing's raw currency (minor units included). NULL = no price. */
    price: numeric('price', { precision: PRICE_PRECISION, scale: PRICE_SCALE }),
    priceCurrency: text('price_currency').notNull(),
    /** 'quote' (latest quote) or 'close' (latest daily close); NULL when no price. */
    priceBasis: text('price_basis'),
    /** Provider timestamp of the quote when `price_basis` = 'quote'; NULL for a close basis. */
    priceAsOf: timestamp('price_as_of', { withTimezone: true }),
    priceEur: numeric('price_eur', { precision: PRICE_PRECISION, scale: PRICE_SCALE }),
    /** Why `price_eur` is NULL: price_missing | currency_invalid | rate_missing. */
    priceEurReason: text('price_eur_reason'),
    /** Rate used for `price_eur` (units per EUR); NULL for EUR prices or when unavailable. */
    fxRatePerEur: numeric('fx_rate_per_eur', { precision: FX_PRECISION, scale: FX_SCALE }),
    fxRateDate: date('fx_rate_date', { mode: 'string' }),
    ...perfColumns(),
  },
  (table) => {
    // No index on price_eur / perf_*: the table query (S6) is scoped by space first (the
    // space_positions unique index), then sorts the space's rows; the seven partial indexes of
    // 0004 were never chosen by the planner (EXPLAIN on 5 000 positions among 65 000 rows,
    // docs/ai/BACKEND.md "Table (S6)") and only slowed every metrics upsert. Dropped in 0005.
    return [
      check(
        'listing_metrics_price_positive',
        sql`${table.price} is null or (${positive(table.price)})`,
      ),
      check(
        'listing_metrics_price_eur_positive',
        sql`${table.priceEur} is null or (${positive(table.priceEur)})`,
      ),
      check(
        'listing_metrics_price_basis_check',
        sql`${table.priceBasis} is null or ${table.priceBasis} in ('quote', 'close')`,
      ),
      check(
        'listing_metrics_price_consistency',
        sql`(${table.price} is null) = (${table.priceBasis} is null) and (${table.price} is null) = (${table.asOfDate} is null)`,
      ),
      check(
        'listing_metrics_price_eur_reason_check',
        sql`(${table.priceEur} is null) = (${table.priceEurReason} is not null)`,
      ),
      ...METRIC_PERIODS.flatMap((p) => {
        const key = p === 'max' ? 'Max' : p;
        const perf = table[`perf${key}` as 'perf1w'];
        const reason = table[`perf${key}Reason` as 'perf1wReason'];
        const base = table[`perf${key}BaseDate` as 'perf1wBaseDate'];
        return [
          // A value always has its base date and no reason; NULL always has a reason.
          check(
            `listing_metrics_perf_${p}_consistency`,
            sql`(${perf} is null) = (${reason} is not null) and (${perf} is null or ${base} is not null)`,
          ),
          check(
            `listing_metrics_perf_${p}_reason_format`,
            sql`${reason} is null or ${reason} ~ '^[a-z][a-z_]{1,39}$'`,
          ),
          check(`listing_metrics_perf_${p}_finite`, sql`${perf} is null or ${perf} <> 'NaN'`),
        ];
      }),
    ];
  },
);

export type PriceDaily = typeof priceDaily.$inferSelect;
export type QuoteLatest = typeof quoteLatest.$inferSelect;
export type FxDaily = typeof fxDaily.$inferSelect;
export type MarketDataFetchState = typeof marketDataFetchState.$inferSelect;
export type ListingMetrics = typeof listingMetrics.$inferSelect;
