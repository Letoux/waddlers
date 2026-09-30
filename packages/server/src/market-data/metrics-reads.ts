import type { PlainDate } from '@waddlers/domain';
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/create';
import { fxDaily, listings, marketDataFetchState, priceDaily } from '../db/schema';

/**
 * Batched, bounded reads for the `listing_metrics` materialization. Every query is scoped to a
 * set of listings (`inArray`) and, for the long series, to a date window: the full history of a
 * listing is never loaded just to compute six periods.
 *
 * Closes are only returned in the listing's CURRENT currency (joined on `listings.currency`) and
 * only when usable (`close is not null`; the CHECK constraint guarantees > 0).
 */

export interface CloseRow {
  listingId: string;
  date: PlainDate;
  close: string;
}

const columns = {
  listingId: priceDaily.listingId,
  date: priceDaily.tradeDate,
  close: priceDaily.close,
};

type Selected = { listingId: string; date: PlainDate; close: string | null };
const usable = (rows: Selected[]): CloseRow[] =>
  rows.flatMap((r) => (r.close === null ? [] : [{ ...r, close: r.close }]));

const sameCurrency = and(
  eq(listings.id, priceDaily.listingId),
  eq(listings.currency, priceDaily.currency),
);

/**
 * Latest / first close per listing use `JOIN LATERAL ... ORDER BY ... LIMIT 1` on the
 * `(listing_id, trade_date)` primary key: one index probe per listing, independent of how many
 * rows the listing has (REVIEW-S4 R1; the former `DISTINCT ON` scanned every matching row).
 */

/** Latest usable close per listing. */
export async function latestClosePerListing(
  db: Database,
  ids: readonly string[],
): Promise<Map<string, CloseRow>> {
  if (ids.length === 0) return new Map();
  const pick = db
    .select({ date: priceDaily.tradeDate, close: priceDaily.close })
    .from(priceDaily)
    .where(and(sameCurrency, isNotNull(priceDaily.close)))
    .orderBy(desc(priceDaily.tradeDate))
    .limit(1)
    .as('pick');
  const rows = await db
    .select({ listingId: listings.id, date: pick.date, close: pick.close })
    .from(listings)
    .innerJoinLateral(pick, sql`true`)
    .where(inArray(listings.id, [...ids]));
  return new Map(usable(rows).map((r) => [r.listingId, r]));
}

/** Every usable close dated on or after `from`, ordered by (listing, date). */
export async function closesFrom(
  db: Database,
  ids: readonly string[],
  from: PlainDate,
): Promise<CloseRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(columns)
    .from(priceDaily)
    .innerJoin(listings, sameCurrency)
    .where(
      and(
        inArray(priceDaily.listingId, [...ids]),
        isNotNull(priceDaily.close),
        gte(priceDaily.tradeDate, from),
      ),
    )
    .orderBy(asc(priceDaily.listingId), asc(priceDaily.tradeDate));
  return usable(rows);
}

/** Latest usable close strictly before `before` per listing (the base anchor below a window). */
export async function latestCloseBefore(
  db: Database,
  ids: readonly string[],
  before: PlainDate,
): Promise<Map<string, CloseRow>> {
  if (ids.length === 0) return new Map();
  const pick = db
    .select({ date: priceDaily.tradeDate, close: priceDaily.close })
    .from(priceDaily)
    .where(and(sameCurrency, isNotNull(priceDaily.close), lt(priceDaily.tradeDate, before)))
    .orderBy(desc(priceDaily.tradeDate))
    .limit(1)
    .as('pick');
  const rows = await db
    .select({ listingId: listings.id, date: pick.date, close: pick.close })
    .from(listings)
    .innerJoinLateral(pick, sql`true`)
    .where(inArray(listings.id, [...ids]));
  return new Map(usable(rows).map((r) => [r.listingId, r]));
}

/** First usable close on or after each listing's `history_complete_from` (the `max` base). */
export async function firstCloseAfterCompleteFrom(
  db: Database,
  ids: readonly string[],
): Promise<Map<string, CloseRow>> {
  if (ids.length === 0) return new Map();
  const pick = db
    .select({ date: priceDaily.tradeDate, close: priceDaily.close })
    .from(priceDaily)
    .where(
      and(
        sameCurrency,
        isNotNull(priceDaily.close),
        sql`${priceDaily.tradeDate} >= ${marketDataFetchState.historyCompleteFrom}`,
      ),
    )
    .orderBy(asc(priceDaily.tradeDate))
    .limit(1)
    .as('pick');
  const rows = await db
    .select({ listingId: listings.id, date: pick.date, close: pick.close })
    .from(listings)
    .innerJoin(
      marketDataFetchState,
      and(
        eq(marketDataFetchState.listingId, listings.id),
        eq(marketDataFetchState.kind, 'history'),
      ),
    )
    .innerJoinLateral(pick, sql`true`)
    .where(inArray(listings.id, [...ids]));
  return new Map(usable(rows).map((r) => [r.listingId, r]));
}

/** Stored rates of one currency dated within [from, to], ascending (one query per currency). */
export async function fxRatesBetween(
  db: Database,
  currency: string,
  from: PlainDate,
  to: PlainDate,
): Promise<{ date: PlainDate; ratePerEur: string }[]> {
  return db
    .select({ date: fxDaily.rateDate, ratePerEur: fxDaily.ratePerEur })
    .from(fxDaily)
    .where(
      and(
        eq(fxDaily.currency, currency),
        gte(fxDaily.rateDate, from),
        sql`${fxDaily.rateDate} <= ${to}`,
      ),
    )
    .orderBy(asc(fxDaily.rateDate));
}
