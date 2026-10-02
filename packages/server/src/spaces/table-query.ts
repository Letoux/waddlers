import {
  DESCRIPTION_PREVIEW_CHARS,
  type DashboardPeriod,
  type Filter,
  type SortableColumnId,
} from '@waddlers/contracts';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { DbExecutor } from '../db/create';
import { exchanges, instruments, listingMetrics, listings, spacePositions } from '../db/schema';
import type { AuthorizedSpace } from './access';
import {
  columnSql,
  orderBy,
  searchPredicate,
  sectorExpr,
  type ColumnSqlContext,
} from './table-columns';
import { filterPredicates } from './table-filters';
import { currentFxRates, eurRate, priceMajorCurrency } from './table-fx';
import type { TableRowData } from './table-cells';

/**
 * The table read (S6): space_positions JOIN instruments JOIN listings JOIN exchanges LEFT JOIN
 * listing_metrics, ALWAYS scoped by `space_positions.space_id = <authorized space>`. Sort, search
 * and pagination run in SQL; PostgreSQL only, no provider.
 */

export interface TableQuery {
  offset: number;
  limit: number;
  /** Trimmed, non-empty search text (already validated), or undefined. */
  search: string | undefined;
  sort: { columnId: SortableColumnId; direction: 'asc' | 'desc' } | undefined;
  /** S7 filters (already validated), AND-combined; undefined/empty = none. */
  filters?: readonly Filter[] | undefined;
  period: DashboardPeriod;
  /** Descriptions can be long: only selected when the column is requested. */
  withDescription: boolean;
}

export interface TablePositionRow {
  id: string;
  createdAt: Date;
  instrumentId: string;
  isin: string | null;
  listingId: string;
  exchangeMic: string;
  descriptionTruncated: boolean;
  data: TableRowData;
}

const m = listingMetrics;
const toDate = (v: unknown) => (v === null ? null : new Date(v as string));

function whereClause(
  space: AuthorizedSpace,
  search: string | undefined,
  filters: readonly Filter[] | undefined,
  ctx: ColumnSqlContext,
): SQL {
  const inSpace = eq(spacePositions.spaceId, space.id);
  const parts = [inSpace, ...(search === undefined ? [] : [searchPredicate(search)])];
  return and(...parts, ...filterPredicates(filters, ctx)) as SQL;
}

export async function queryTablePage(
  db: DbExecutor,
  space: AuthorizedSpace,
  q: TableQuery,
): Promise<TablePositionRow[]> {
  const fx = currentFxRates(db, space);
  const ctx = { period: q.period, fxRate: eurRate(fx) };
  const cols = columnSql(ctx);
  const rows = await db
    .select({
      id: spacePositions.id,
      createdAt: spacePositions.createdAt,
      quantity: spacePositions.quantity,
      selectionReason: spacePositions.selectionReason,
      instrumentId: instruments.id,
      instrumentName: instruments.name,
      instrumentType: instruments.type,
      isin: instruments.isin,
      sector: sql<string | null>`${sectorExpr}`,
      // Preview only (security P3): the full text is S9's. Not selected at all unless requested.
      description: q.withDescription
        ? sql<string | null>`left(${instruments.description}, ${DESCRIPTION_PREVIEW_CHARS})`
        : sql<null>`null`,
      descriptionTruncated: q.withDescription
        ? sql<boolean>`coalesce(char_length(${instruments.description}) > ${DESCRIPTION_PREVIEW_CHARS}, false)`
        : sql<boolean>`false`,
      listingId: listings.id,
      symbol: listings.symbol,
      currency: listings.currency,
      exchangeMic: exchanges.mic,
      exchangeName: exchanges.name,
      hasMetrics: sql<boolean>`${m.listingId} is not null`,
      asOfDate: m.asOfDate,
      price: m.price,
      priceCurrency: m.priceCurrency,
      // D25: the dashboard's current rule, in SQL (table-fx.ts).
      priceEur: sql<string | null>`${cols.price_eur.value}`,
      trackedValueEur: sql<string | null>`${cols.tracked_value_eur.value}`,
      fxRatePerEur: sql<string | null>`${ctx.fxRate}`,
      fxRateDate: fx.rateDate,
      p1w: m.perf1w,
      b1w: m.perf1wBaseDate,
      r1w: m.perf1wReason,
      p1m: m.perf1m,
      b1m: m.perf1mBaseDate,
      r1m: m.perf1mReason,
      p6m: m.perf6m,
      b6m: m.perf6mBaseDate,
      r6m: m.perf6mReason,
      p1y: m.perf1y,
      b1y: m.perf1yBaseDate,
      r1y: m.perf1yReason,
      p5y: m.perf5y,
      b5y: m.perf5yBaseDate,
      r5y: m.perf5yReason,
      pMax: m.perfMax,
      bMax: m.perfMaxBaseDate,
      rMax: m.perfMaxReason,
    })
    .from(spacePositions)
    .innerJoin(instruments, eq(instruments.id, spacePositions.instrumentId))
    .innerJoin(listings, eq(listings.id, spacePositions.listingId))
    .innerJoin(exchanges, eq(exchanges.mic, listings.exchangeMic))
    .leftJoin(m, eq(m.listingId, listings.id))
    .leftJoin(fx, eq(fx.currency, priceMajorCurrency))
    .where(whereClause(space, q.search, q.filters, ctx))
    .orderBy(...orderBy(q.sort, ctx))
    .limit(q.limit)
    .offset(q.offset);

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    instrumentId: r.instrumentId,
    isin: r.isin,
    listingId: r.listingId,
    exchangeMic: r.exchangeMic,
    descriptionTruncated: r.descriptionTruncated,
    data: {
      quantity: r.quantity,
      selectionReason: r.selectionReason,
      instrumentName: r.instrumentName,
      instrumentType: r.instrumentType,
      sector: r.sector,
      description: r.description,
      symbol: r.symbol,
      exchangeName: r.exchangeName,
      currency: r.currency,
      metrics:
        r.hasMetrics && r.priceCurrency !== null
          ? {
              asOfDate: r.asOfDate,
              price: r.price,
              priceCurrency: r.priceCurrency,
              priceEur: r.priceEur,
              trackedValueEur: r.trackedValueEur,
              fxRatePerEur: r.fxRatePerEur,
              fxRateDate: r.fxRateDate,
              perf: {
                '1w': { value: r.p1w, baseDate: r.b1w, reason: r.r1w },
                '1m': { value: r.p1m, baseDate: r.b1m, reason: r.r1m },
                '6m': { value: r.p6m, baseDate: r.b6m, reason: r.r6m },
                '1y': { value: r.p1y, baseDate: r.b1y, reason: r.r1y },
                '5y': { value: r.p5y, baseDate: r.b5y, reason: r.r5y },
                max: { value: r.pMax, baseDate: r.bMax, reason: r.rMax },
              },
            }
          : null,
    },
  }));
}

/** Matching positions and the newest/oldest `computed_at` among them (same filter, same snapshot). */
export async function queryTableTotals(
  db: DbExecutor,
  space: AuthorizedSpace,
  search: string | undefined,
  filters: readonly Filter[] | undefined,
  period: DashboardPeriod,
): Promise<{ total: number; computedAt: Date | null; oldestComputedAt: Date | null }> {
  // The EUR rate is needed by the `price_eur` / `tracked_value_eur` filters (same D25 rule as the page).
  const fx = currentFxRates(db, space);
  const ctx = { period, fxRate: eurRate(fx) };
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      computedAt: sql<Date | null>`max(${m.computedAt})`.mapWith(toDate),
      oldestComputedAt: sql<Date | null>`min(${m.computedAt})`.mapWith(toDate),
    })
    .from(spacePositions)
    .innerJoin(instruments, eq(instruments.id, spacePositions.instrumentId))
    .innerJoin(listings, eq(listings.id, spacePositions.listingId))
    .innerJoin(exchanges, eq(exchanges.mic, listings.exchangeMic))
    .leftJoin(m, eq(m.listingId, listings.id))
    .leftJoin(fx, eq(fx.currency, priceMajorCurrency))
    .where(whereClause(space, search, filters, ctx));
  return {
    total: row?.total ?? 0,
    computedAt: row?.computedAt ?? null,
    oldestComputedAt: row?.oldestComputedAt ?? null,
  };
}
