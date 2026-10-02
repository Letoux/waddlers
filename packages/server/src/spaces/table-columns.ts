import {
  INSTRUMENT_TYPE_LABELS,
  SORTABLE_COLUMN_IDS,
  type AvailableColumnId,
  type DashboardPeriod,
  type SortableColumnId,
} from '@waddlers/contracts';
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { exchanges, instruments, listingMetrics, listings, spacePositions } from '../db/schema';
import { majorCurrencyOf, priceEurSql } from './table-fx';

/**
 * SQL side of the column registry (the metadata lives in `@waddlers/contracts`): see `columnSql`.
 */

const m = listingMetrics;

/** Sector is not applicable to an ETF (specs 24): NULL there, in display, search and sort alike. */
export const sectorExpr: SQL = sql`case when ${instruments.type} = 'stock' then ${instruments.sector} end`;

/** Text sort key: case- and accent-insensitive, so `Électricité` sorts with `E` whatever the database collation. */
const textKey = (expr: SQL | AnyColumn): SQL => sql`unaccent(lower(${expr}))`;

export const nameKey: SQL = textKey(instruments.name);

const PERF_BY_PERIOD: Record<DashboardPeriod, AnyColumn> = {
  '1w': m.perf1w,
  '1m': m.perf1m,
  '6m': m.perf6m,
  '1y': m.perf1y,
  '5y': m.perf5y,
  max: m.perfMax,
};

type Sql = SQL | AnyColumn;

/** What the per-request SQL needs besides the static tables: the period and the EUR rate (D25). */
export interface ColumnSqlContext {
  period: DashboardPeriod;
  /** Units of the price currency per 1 EUR (see `eurRate`). */
  fxRate: SQL;
}

/**
 * `value` = the column's comparable value (display and, in S7, filters); `sort` = the key `ORDER BY`
 * uses when it differs (text is lowercased, the instrument type sorts by its French label).
 */
export interface ColumnSql {
  value: Sql;
  sort?: Sql;
}

/** French labels of the instrument types: the sort key of `instrument_type` (Action before ETF). */
const typeLabelKey: SQL = sql`case ${instruments.type} when 'stock' then ${INSTRUMENT_TYPE_LABELS.stock} when 'etf' then ${INSTRUMENT_TYPE_LABELS.etf} end`;

const lowered = (expr: Sql): SQL => textKey(expr);

/**
 * THE per-column SQL mapping, shared by `ORDER BY` and the S7 filter builder. Keyed by the
 * AVAILABLE columns: a column that becomes available without a mapping does not compile, and a
 * unit test checks the runtime keys. `columnId` itself is never interpolated: only these
 * expressions are.
 */
export function columnSql(ctx: ColumnSqlContext): Record<AvailableColumnId, ColumnSql> {
  const priceEur = priceEurSql(ctx.fxRate);
  return {
    name: { value: instruments.name, sort: nameKey },
    symbol: { value: listings.symbol, sort: lowered(listings.symbol) },
    instrument_type: { value: instruments.type, sort: typeLabelKey },
    exchange: { value: exchanges.name, sort: lowered(exchanges.name) },
    selection_reason: {
      value: spacePositions.selectionReason,
      sort: lowered(spacePositions.selectionReason),
    },
    currency: { value: listings.currency },
    sector: { value: sectorExpr, sort: lowered(sectorExpr) },
    description: { value: instruments.description },
    price: { value: m.price },
    fx_rate: { value: ctx.fxRate },
    price_eur: { value: priceEur },
    price_date: { value: m.asOfDate },
    perf_period: { value: PERF_BY_PERIOD[ctx.period] },
    perf_1w: { value: m.perf1w },
    perf_1m: { value: m.perf1m },
    perf_6m: { value: m.perf6m },
    perf_1y: { value: m.perf1y },
    perf_5y: { value: m.perf5y },
    perf_max: { value: m.perfMax },
    quantity: { value: spacePositions.quantity },
    // NULL for a watchlist entry or without a EUR price (exact numeric product, D25).
    tracked_value_eur: { value: sql`${spacePositions.quantity} * ${priceEur}` },
  };
}

// Every sortable column must be mapped (compile-time; the registry test checks the runtime keys).
type SortableIsAvailable = SortableColumnId extends AvailableColumnId ? true : never;
export const sortableIsAvailable: SortableIsAvailable = true;

/** `ORDER BY` keys of the sortable columns, derived from `columnSql`. */
export function SORT_SQL(ctx: ColumnSqlContext): Record<SortableColumnId, Sql> {
  const cols = columnSql(ctx);
  return Object.fromEntries(
    SORTABLE_COLUMN_IDS.map((id) => [id, cols[id].sort ?? cols[id].value]),
  ) as Record<SortableColumnId, Sql>;
}

/** `ORDER BY` for the requested sort: NULLS LAST both ways, then the stable tiebreak (name, id). */
export function orderBy(
  sort: { columnId: SortableColumnId; direction: 'asc' | 'desc' } | undefined,
  ctx: ColumnSqlContext,
): SQL[] {
  const tiebreak = [sql`${nameKey} asc`, sql`${spacePositions.id} asc`];
  if (sort === undefined) return tiebreak;
  const direction = sort.direction === 'desc' ? sql.raw('desc') : sql.raw('asc');
  const expr = SORT_SQL(ctx)[sort.columnId];
  // `name` as primary key already is the first tiebreak: repeating it is harmless.
  return [sql`${expr} ${direction} nulls last`, ...tiebreak];
}

/** Folds case, accents and typographic apostrophes (`’`, `‘` -> `'`): `Hermès`, `l’Oréal` match `hermes`, `l'oreal`. */
const fold = (expr: SQL | AnyColumn): SQL =>
  sql`unaccent(translate(lower(${expr}), ${'’‘'}, ${"''"}))`;

/**
 * LIKE pattern of a search term: FOLD first, ESCAPE after (security P3-A). `unaccent` maps
 * full-width look-alikes to ASCII (`％` -> `%`, `＿` -> `_`, `＼` -> `\`), so escaping before
 * folding would let them become wildcards. Escapes `\`, `%` and `_` of the folded text (`E''`
 * literals: a backslash whatever `standard_conforming_strings` says), then wraps it in `%...%`.
 */
function likePattern(term: string): SQL {
  const folded = fold(sql`${term}::text`);
  const escaped = sql`replace(replace(replace(${folded}, E'\\\\', E'\\\\\\\\'), '%', E'\\\\%'), '_', E'\\\\_')`;
  return sql`('%' || ${escaped} || '%')`;
}

/**
 * Case-, accent- and apostrophe-insensitive substring search over every searchable text field
 * (specs 20): name, code, ISIN, sector, currency (raw AND major, so `GBP` finds GBX listings),
 * exchange name and MIC. One bound parameter (folded and escaped in SQL, same fold as the
 * columns), no string concatenation. The escape character is a single backslash, written `E'\\'` in SQL.
 */
export function searchPredicate(term: string): SQL {
  const pattern = likePattern(term);
  const like = (expr: SQL | AnyColumn) => sql`${fold(expr)} like ${pattern} escape E'\\\\'`;
  return sql`(${sql.join(
    [
      like(instruments.name),
      like(listings.symbol),
      like(instruments.isin),
      like(sectorExpr),
      like(listings.currency),
      like(majorCurrencyOf(listings.currency)),
      like(exchanges.name),
      like(exchanges.mic),
    ],
    sql` or `,
  )})`;
}
