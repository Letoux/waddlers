import type { DashboardPeriod, SortableColumnId } from '@waddlers/contracts';
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { exchanges, instruments, listingMetrics, listings, spacePositions } from '../db/schema';

/**
 * SQL side of the column registry (the metadata lives in `@waddlers/contracts`). The record is
 * typed over `SortableColumnId`: a sortable column without a mapping does not compile (and a unit
 * test checks the runtime keys), so the `sort.columnId` whitelist can never reach SQL unmapped.
 * `columnId` itself is never interpolated: only these expressions are.
 */

const m = listingMetrics;

/** Sector is not applicable to an ETF (specs 24): NULL there, in display, search and sort alike. */
export const sectorExpr: SQL = sql`case when ${instruments.type} = 'stock' then ${instruments.sector} end`;

export const nameKey: SQL = sql`lower(${instruments.name})`;

const PERF_BY_PERIOD: Record<DashboardPeriod, AnyColumn> = {
  '1w': m.perf1w,
  '1m': m.perf1m,
  '6m': m.perf6m,
  '1y': m.perf1y,
  '5y': m.perf5y,
  max: m.perfMax,
};

type SortExpr = (period: DashboardPeriod) => SQL | AnyColumn;

export const SORT_SQL: Record<SortableColumnId, SortExpr> = {
  name: () => nameKey,
  symbol: () => sql`lower(${listings.symbol})`,
  instrument_type: () => instruments.type,
  exchange: () => sql`lower(${exchanges.name})`,
  selection_reason: () => sql`lower(${spacePositions.selectionReason})`,
  currency: () => listings.currency,
  sector: () => sql`lower(${sectorExpr})`,
  price_eur: () => m.priceEur,
  price_date: () => m.asOfDate,
  perf_period: (period) => PERF_BY_PERIOD[period],
  perf_1w: () => m.perf1w,
  perf_1m: () => m.perf1m,
  perf_6m: () => m.perf6m,
  perf_1y: () => m.perf1y,
  perf_5y: () => m.perf5y,
  perf_max: () => m.perfMax,
  quantity: () => spacePositions.quantity,
  // NULL when the entry is a watchlist one or has no EUR price (exact numeric product).
  tracked_value_eur: () => sql`${spacePositions.quantity} * ${m.priceEur}`,
};

/** `ORDER BY` for the requested sort: NULLS LAST both ways, then the stable tiebreak (name, id). */
export function orderBy(
  sort: { columnId: SortableColumnId; direction: 'asc' | 'desc' } | undefined,
  period: DashboardPeriod,
): SQL[] {
  const tiebreak = [sql`${nameKey} asc`, sql`${spacePositions.id} asc`];
  if (sort === undefined) return tiebreak;
  const direction = sort.direction === 'desc' ? sql.raw('desc') : sql.raw('asc');
  const expr = SORT_SQL[sort.columnId](period);
  // `name` as primary key already is the first tiebreak: repeating it is harmless.
  return [sql`${expr} ${direction} nulls last`, ...tiebreak];
}

/** Escapes `\`, `%` and `_` so user text is a literal substring in `ILIKE ... ESCAPE '\'`. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Case-insensitive substring search over every searchable text field (specs 20): name, code,
 * ISIN, sector, currency, exchange name and MIC. One bound parameter, no string concatenation.
 */
export function searchPredicate(term: string): SQL {
  const pattern = `%${escapeLike(term)}%`;
  const like = (expr: SQL | AnyColumn) => sql`${expr} ilike ${pattern} escape '\\'`;
  return sql`(${sql.join(
    [
      like(instruments.name),
      like(listings.symbol),
      like(instruments.isin),
      like(sectorExpr),
      like(listings.currency),
      like(exchanges.name),
      like(exchanges.mic),
    ],
    sql` or `,
  )})`;
}
