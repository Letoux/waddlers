import type { Period, PlainDate } from '@waddlers/domain';
import { and, asc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { DbExecutor } from '../db/create';
import {
  exchanges,
  fxDaily,
  instruments,
  listingMetrics,
  listings,
  priceDaily,
  spacePositions,
} from '../db/schema';
import type { AuthorizedSpace } from '../spaces/access';

/**
 * Dashboard reads (S5). PostgreSQL only, no provider, no MarketDataService: the worker keeps
 * `price_daily`, `fx_daily`, `quote_latest` and `listing_metrics` fresh, a request only reads
 * them (CLAUDE.md section 7). Per-space reads are keyed by the branded `AuthorizedSpace` and
 * reach listings THROUGH `space_positions`, so a caller can never ask for another space's data.
 * Every read is one batched statement (no per-listing round trip).
 */

export interface PerfCell {
  value: string | null;
  baseDate: PlainDate | null;
}

export interface SpacePositionData {
  id: string;
  /** Decimal string; null = watchlist entry (D9). */
  quantity: string | null;
  instrumentId: string;
  name: string;
  listingId: string;
  symbol: string;
  exchangeMic: string;
  exchangeName: string;
  /** Raw listing currency (minor units included). */
  currency: string;
  /** `null` when `listing_metrics` has no row for the listing yet. */
  metrics: {
    price: string | null;
    priceCurrency: string;
    asOfDate: PlainDate | null;
    perf: Record<Period, PerfCell>;
  } | null;
}

const m = listingMetrics;

/** Positions of the space with the metrics of their chosen listing (LEFT JOIN: one row each). */
export async function readSpacePositions(
  db: DbExecutor,
  space: AuthorizedSpace,
): Promise<SpacePositionData[]> {
  const rows = await db
    .select({
      id: spacePositions.id,
      quantity: spacePositions.quantity,
      instrumentId: instruments.id,
      name: instruments.name,
      listingId: listings.id,
      symbol: listings.symbol,
      exchangeMic: exchanges.mic,
      exchangeName: exchanges.name,
      currency: listings.currency,
      hasMetrics: sql<boolean>`${m.listingId} is not null`,
      price: m.price,
      priceCurrency: m.priceCurrency,
      asOfDate: m.asOfDate,
      p1w: m.perf1w,
      b1w: m.perf1wBaseDate,
      p1m: m.perf1m,
      b1m: m.perf1mBaseDate,
      p6m: m.perf6m,
      b6m: m.perf6mBaseDate,
      p1y: m.perf1y,
      b1y: m.perf1yBaseDate,
      p5y: m.perf5y,
      b5y: m.perf5yBaseDate,
      pMax: m.perfMax,
      bMax: m.perfMaxBaseDate,
    })
    .from(spacePositions)
    .innerJoin(instruments, eq(instruments.id, spacePositions.instrumentId))
    .innerJoin(listings, eq(listings.id, spacePositions.listingId))
    .innerJoin(exchanges, eq(exchanges.mic, listings.exchangeMic))
    .leftJoin(m, eq(m.listingId, listings.id))
    .where(eq(spacePositions.spaceId, space.id))
    .orderBy(asc(sql`lower(${instruments.name})`), asc(spacePositions.id));
  return rows.map((r) => ({
    id: r.id,
    quantity: r.quantity,
    instrumentId: r.instrumentId,
    name: r.name,
    listingId: r.listingId,
    symbol: r.symbol,
    exchangeMic: r.exchangeMic,
    exchangeName: r.exchangeName,
    currency: r.currency,
    metrics:
      r.hasMetrics && r.priceCurrency !== null
        ? {
            price: r.price,
            priceCurrency: r.priceCurrency,
            asOfDate: r.asOfDate,
            perf: {
              '1w': { value: r.p1w, baseDate: r.b1w },
              '1m': { value: r.p1m, baseDate: r.b1m },
              '6m': { value: r.p6m, baseDate: r.b6m },
              '1y': { value: r.p1y, baseDate: r.b1y },
              '5y': { value: r.p5y, baseDate: r.b5y },
              max: { value: r.pMax, baseDate: r.bMax },
            },
          }
        : null,
  }));
}

export interface CloseRow {
  listingId: string;
  date: PlainDate;
  close: string;
}

/**
 * Usable closes of the space's HELD positions (quantity not null; watchlist entries never enter
 * the value series) in `[from, to]` (`from` null = whole history, for `max`). Only closes in the
 * listing's CURRENT currency (a currency change would otherwise mix units). Served by the
 * `(listing_id, trade_date)` primary key: one range probe per held listing.
 */
export async function readHeldCloses(
  db: DbExecutor,
  space: AuthorizedSpace,
  range: { from: PlainDate | null; to: PlainDate },
): Promise<CloseRow[]> {
  const rows = await db
    .select({
      listingId: priceDaily.listingId,
      date: priceDaily.tradeDate,
      close: priceDaily.close,
    })
    .from(spacePositions)
    .innerJoin(listings, eq(listings.id, spacePositions.listingId))
    .innerJoin(
      priceDaily,
      and(eq(priceDaily.listingId, listings.id), eq(priceDaily.currency, listings.currency)),
    )
    .where(
      and(
        eq(spacePositions.spaceId, space.id),
        isNotNull(spacePositions.quantity),
        isNotNull(priceDaily.close),
        range.from ? gte(priceDaily.tradeDate, range.from) : undefined,
        lte(priceDaily.tradeDate, range.to),
      ),
    )
    .orderBy(asc(priceDaily.listingId), asc(priceDaily.tradeDate));
  return rows.flatMap((r) => (r.close === null ? [] : [{ ...r, close: r.close }]));
}

export interface FxRow {
  currency: string;
  date: PlainDate;
  ratePerEur: string;
}

/** Stored EUR-based rates of the given MAJOR currencies dated within `[from, to]` (global table). */
export async function readFxRange(
  db: DbExecutor,
  currencies: readonly string[],
  from: PlainDate,
  to: PlainDate,
): Promise<FxRow[]> {
  if (currencies.length === 0) return [];
  return db
    .select({ currency: fxDaily.currency, date: fxDaily.rateDate, ratePerEur: fxDaily.ratePerEur })
    .from(fxDaily)
    .where(
      and(
        inArray(fxDaily.currency, [...currencies]),
        gte(fxDaily.rateDate, from),
        lte(fxDaily.rateDate, to),
      ),
    )
    .orderBy(asc(fxDaily.currency), asc(fxDaily.rateDate));
}
