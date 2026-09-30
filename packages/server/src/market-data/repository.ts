import type { PlainDate } from '@waddlers/domain';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/create';

/** A database or a transaction of it. */
type Db = Pick<
  Database,
  'select' | 'selectDistinct' | 'selectDistinctOn' | 'insert' | 'update' | 'delete'
>;
import {
  exchanges,
  fxDaily,
  listingProviderIds,
  listings,
  marketDataFetchState,
  priceDaily,
  providerUsage,
  quoteLatest,
  spacePositions,
  type FetchKind,
} from '../db/schema';
import type { MarketDataConfig } from './config';
import type { UsageStore } from './guard';
import type { DailyBar, FxRate, ListingRef, Quote } from './types';

const CHUNK = 1500;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---- listings -------------------------------------------------------------------------

/** Distinct listings present in any space position: the only ones the worker keeps warm. */
export async function heldListingIds(db: Database): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: spacePositions.listingId })
    .from(spacePositions)
    .orderBy(asc(spacePositions.listingId));
  return rows.map((r) => r.id);
}

/** Listing references (with exchange timezone and the provider symbol when registered). */
export async function loadListingRefs(
  db: Db,
  options: { provider: string; ids?: readonly string[] },
): Promise<ListingRef[]> {
  if (options.ids && options.ids.length === 0) return [];
  const rows = await db
    .select({
      id: listings.id,
      symbol: listings.symbol,
      mic: listings.exchangeMic,
      currency: listings.currency,
      timezone: exchanges.timezone,
      providerSymbol: listingProviderIds.providerSymbol,
    })
    .from(listings)
    .innerJoin(exchanges, eq(exchanges.mic, listings.exchangeMic))
    .leftJoin(
      listingProviderIds,
      and(
        eq(listingProviderIds.listingId, listings.id),
        eq(listingProviderIds.provider, options.provider),
      ),
    )
    .where(options.ids ? inArray(listings.id, [...options.ids]) : undefined)
    .orderBy(asc(listings.exchangeMic), asc(listings.symbol));
  return rows;
}

export async function findListingRef(
  db: Db,
  provider: string,
  symbol: string,
  mic: string,
): Promise<ListingRef | null> {
  const [row] = await db
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.symbol, symbol), eq(listings.exchangeMic, mic)))
    .limit(1);
  if (!row) return null;
  return (await loadListingRefs(db, { provider, ids: [row.id] }))[0] ?? null;
}

// ---- quotes ---------------------------------------------------------------------------

export interface StoredQuote {
  listingId: string;
  price: string;
  currency: string;
  asOf: Date;
  source: string;
  fetchedAt: Date;
}

export async function readQuotes(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, StoredQuote>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(quoteLatest)
    .where(inArray(quoteLatest.listingId, [...ids]));
  return new Map(rows.map((r) => [r.listingId, r]));
}

/** Idempotent (upsert by listing). `fetchedAt` is the time WE stored it. */
export async function upsertQuotes(
  db: Db,
  quotes: readonly Quote[],
  meta: { source: string; fetchedAt: Date },
): Promise<void> {
  for (const part of chunks(quotes)) {
    await db
      .insert(quoteLatest)
      .values(
        part.map((q) => ({
          listingId: q.listingId,
          price: q.price,
          currency: q.currency,
          asOf: q.asOf,
          source: meta.source,
          fetchedAt: meta.fetchedAt,
        })),
      )
      .onConflictDoUpdate({
        target: quoteLatest.listingId,
        set: {
          // Price, currency, provider timestamp and source only ever move FORWARD in provider time:
          // a late or out-of-order response (older `as_of`) must not regress the stored quote.
          // `fetched_at` still records that a fetch happened, so freshness stays honest.
          price: sql`case when excluded.as_of >= ${quoteLatest.asOf} then excluded.price else ${quoteLatest.price} end`,
          currency: sql`case when excluded.as_of >= ${quoteLatest.asOf} then excluded.currency else ${quoteLatest.currency} end`,
          source: sql`case when excluded.as_of >= ${quoteLatest.asOf} then excluded.source else ${quoteLatest.source} end`,
          asOf: sql`greatest(excluded.as_of, ${quoteLatest.asOf})`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
  }
}

// ---- daily bars -----------------------------------------------------------------------

export interface StoredBar {
  date: PlainDate;
  close: string | null;
  adjClose: string | null;
  currency: string;
  source: string;
  fetchedAt: Date;
}

export async function readBars(
  db: Db,
  listingId: string,
  range: { from?: PlainDate; to?: PlainDate } = {},
): Promise<StoredBar[]> {
  const rows = await db
    .select({
      date: priceDaily.tradeDate,
      close: priceDaily.close,
      adjClose: priceDaily.adjClose,
      currency: priceDaily.currency,
      source: priceDaily.source,
      fetchedAt: priceDaily.fetchedAt,
    })
    .from(priceDaily)
    .where(
      and(
        eq(priceDaily.listingId, listingId),
        range.from ? gte(priceDaily.tradeDate, range.from) : undefined,
        range.to ? lte(priceDaily.tradeDate, range.to) : undefined,
      ),
    )
    .orderBy(asc(priceDaily.tradeDate));
  return rows;
}

/** Earliest stored close date over several listings (drives how far back FX must reach). */
export async function earliestBarDate(db: Db, ids: readonly string[]): Promise<PlainDate | null> {
  if (ids.length === 0) return null;
  const [row] = await db
    .select({ first: sql<string | null>`min(${priceDaily.tradeDate})` })
    .from(priceDaily)
    .where(inArray(priceDaily.listingId, [...ids]));
  return row?.first ?? null;
}

export async function barDateBounds(
  db: Db,
  listingId: string,
): Promise<{ first: PlainDate | null; last: PlainDate | null }> {
  const [row] = await db
    .select({
      first: sql<string | null>`min(${priceDaily.tradeDate})`,
      last: sql<string | null>`max(${priceDaily.tradeDate})`,
    })
    .from(priceDaily)
    .where(eq(priceDaily.listingId, listingId));
  return { first: row?.first ?? null, last: row?.last ?? null };
}

/** Idempotent (upsert by listing + date): re-pulling an overlap rewrites the same rows. */
export async function upsertBars(
  db: Db,
  listing: { id: string; currency: string },
  bars: readonly DailyBar[],
  meta: { source: string; fetchedAt: Date },
): Promise<void> {
  for (const part of chunks(bars)) {
    await db
      .insert(priceDaily)
      .values(
        part.map((b) => ({
          listingId: listing.id,
          tradeDate: b.date,
          close: b.close,
          adjClose: b.adjClose,
          currency: listing.currency,
          source: meta.source,
          fetchedAt: meta.fetchedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [priceDaily.listingId, priceDaily.tradeDate],
        set: {
          close: sql`excluded.close`,
          adjClose: sql`excluded.adj_close`,
          currency: sql`excluded.currency`,
          source: sql`excluded.source`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
  }
}

// ---- FX -------------------------------------------------------------------------------

export async function upsertFxRates(
  db: Db,
  rates: readonly FxRate[],
  meta: { source: string; fetchedAt: Date },
): Promise<void> {
  for (const part of chunks(rates, 2000)) {
    await db
      .insert(fxDaily)
      .values(
        part.map((r) => ({
          rateDate: r.date,
          currency: r.currency,
          ratePerEur: r.ratePerEur,
          source: meta.source,
          fetchedAt: meta.fetchedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [fxDaily.rateDate, fxDaily.currency],
        set: {
          ratePerEur: sql`excluded.rate_per_eur`,
          source: sql`excluded.source`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
  }
}

/** Latest rate of every stored currency (for freshness/asOf and quick lookups). */
export async function fxLatestPerCurrency(
  db: Database,
): Promise<
  { currency: string; date: PlainDate; ratePerEur: string; source: string; fetchedAt: Date }[]
> {
  return db
    .selectDistinctOn([fxDaily.currency], {
      currency: fxDaily.currency,
      date: fxDaily.rateDate,
      ratePerEur: fxDaily.ratePerEur,
      source: fxDaily.source,
      fetchedAt: fxDaily.fetchedAt,
    })
    .from(fxDaily)
    .orderBy(asc(fxDaily.currency), desc(fxDaily.rateDate));
}

/** Latest stored rate for `currency` dated on or before `date` (no tolerance applied here). */
export async function fxRateOnOrBefore(
  db: Db,
  currency: string,
  date: PlainDate,
): Promise<{ date: PlainDate; ratePerEur: string } | null> {
  const [row] = await db
    .select({ date: fxDaily.rateDate, ratePerEur: fxDaily.ratePerEur })
    .from(fxDaily)
    .where(and(eq(fxDaily.currency, currency), lte(fxDaily.rateDate, date)))
    .orderBy(desc(fxDaily.rateDate))
    .limit(1);
  return row ?? null;
}

// ---- fetch state (negative cache / backoff) -------------------------------------------

export type StoredFetchState = typeof marketDataFetchState.$inferSelect;

const scope = (listingId: string | null, kind: FetchKind) =>
  and(
    eq(marketDataFetchState.kind, kind),
    listingId === null
      ? isNull(marketDataFetchState.listingId)
      : eq(marketDataFetchState.listingId, listingId),
  );

export async function readFetchState(
  db: Db,
  listingId: string | null,
  kind: FetchKind,
): Promise<StoredFetchState | null> {
  const [row] = await db.select().from(marketDataFetchState).where(scope(listingId, kind)).limit(1);
  return row ?? null;
}

export async function readFetchStates(
  db: Db,
  ids: readonly string[],
  kind: FetchKind,
): Promise<Map<string, StoredFetchState>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(marketDataFetchState)
    .where(
      and(eq(marketDataFetchState.kind, kind), inArray(marketDataFetchState.listingId, [...ids])),
    );
  return new Map(rows.flatMap((r) => (r.listingId ? [[r.listingId, r] as const] : [])));
}

/** Resets the failure streak; `historyCompleteFrom` only ever moves earlier (least). Idempotent. */
export async function recordSuccess(
  db: Db,
  listingId: string | null,
  kind: FetchKind,
  now: Date,
  options: { historyCompleteFrom?: PlainDate | null } = {},
): Promise<void> {
  const from = options.historyCompleteFrom ?? null;
  await db
    .insert(marketDataFetchState)
    .values({
      listingId,
      kind,
      lastSuccessAt: now,
      lastAttemptAt: now,
      failureCount: 0,
      nextRetryAt: null,
      lastErrorCode: null,
      historyCompleteFrom: from,
    })
    .onConflictDoUpdate({
      target: [marketDataFetchState.listingId, marketDataFetchState.kind],
      set: {
        lastSuccessAt: now,
        lastAttemptAt: now,
        failureCount: 0,
        nextRetryAt: null,
        lastErrorCode: null,
        historyCompleteFrom: sql`case
          when excluded.history_complete_from is null then ${marketDataFetchState.historyCompleteFrom}
          when ${marketDataFetchState.historyCompleteFrom} is null then excluded.history_complete_from
          else least(${marketDataFetchState.historyCompleteFrom}, excluded.history_complete_from) end`,
      },
    });
}

/**
 * Counts failures and schedules the next retry: now + min(cap, base * 2^(previous failures)).
 * Never touches `last_success_at` nor any data table (a failure must not bump `fetched_at`).
 * Atomic in SQL so the count cannot be lost; one statement for the whole batch.
 */
export async function recordFailures(
  db: Db,
  kind: FetchKind,
  now: Date,
  entries: readonly { listingId: string | null; errorCode: string }[],
  config: Pick<MarketDataConfig, 'backoffBaseMs' | 'backoffMaxMs'>,
): Promise<void> {
  // One row per key: a statement cannot update the same row twice (last code wins).
  const byKey = new Map(entries.map((e) => [e.listingId, e.errorCode]));
  for (const part of chunks([...byKey])) {
    await db
      .insert(marketDataFetchState)
      .values(
        part.map(([listingId, errorCode]) => ({
          listingId,
          kind,
          lastAttemptAt: now,
          failureCount: 1,
          nextRetryAt: new Date(now.getTime() + config.backoffBaseMs),
          lastErrorCode: errorCode,
        })),
      )
      .onConflictDoUpdate({
        target: [marketDataFetchState.listingId, marketDataFetchState.kind],
        set: {
          lastAttemptAt: now,
          failureCount: sql`${marketDataFetchState.failureCount} + 1`,
          lastErrorCode: sql`excluded.last_error_code`,
          nextRetryAt: sql`${now.toISOString()}::timestamptz + (least(${config.backoffMaxMs}::float8, ${config.backoffBaseMs}::float8 * power(2, least(${marketDataFetchState.failureCount}, 30))) * interval '1 millisecond')`,
        },
      });
  }
}

export function recordFailure(
  db: Db,
  listingId: string | null,
  kind: FetchKind,
  now: Date,
  errorCode: string,
  config: Pick<MarketDataConfig, 'backoffBaseMs' | 'backoffMaxMs'>,
): Promise<void> {
  return recordFailures(db, kind, now, [{ listingId, errorCode }], config);
}

/** Resets the failure streak of several listings in one statement (quotes: no completeness). */
export async function recordSuccesses(
  db: Db,
  listingIds: readonly string[],
  kind: FetchKind,
  now: Date,
): Promise<void> {
  for (const part of chunks([...new Set(listingIds)])) {
    await db
      .insert(marketDataFetchState)
      .values(
        part.map((listingId) => ({
          listingId,
          kind,
          lastSuccessAt: now,
          lastAttemptAt: now,
          failureCount: 0,
          nextRetryAt: null,
          lastErrorCode: null,
        })),
      )
      .onConflictDoUpdate({
        target: [marketDataFetchState.listingId, marketDataFetchState.kind],
        set: {
          lastSuccessAt: now,
          lastAttemptAt: now,
          failureCount: 0,
          nextRetryAt: null,
          lastErrorCode: null,
        },
      });
  }
}

// ---- provider usage -------------------------------------------------------------------

export class DbUsageStore implements UsageStore {
  constructor(private readonly db: Database) {}

  async reserve(provider: string, day: PlainDate, budget: number): Promise<boolean> {
    // The first insert below has no conflict, hence no budget check: refuse a zero budget here.
    if (budget < 1) return false;
    const rows = await this.db
      .insert(providerUsage)
      .values({ provider, day, calls: 1 })
      .onConflictDoUpdate({
        target: [providerUsage.provider, providerUsage.day],
        set: { calls: sql`${providerUsage.calls} + 1` },
        setWhere: sql`${providerUsage.calls} < ${budget}`,
      })
      .returning({ calls: providerUsage.calls });
    return rows.length > 0;
  }
}
