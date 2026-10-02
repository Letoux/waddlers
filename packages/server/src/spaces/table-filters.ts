import { TABLE_COLUMNS_BY_ID, type Filter } from '@waddlers/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { columnSql, type ColumnSqlContext } from './table-columns';
import { wire8Sql } from './table-fx';

/**
 * SQL of the S7 filters (specs 21). Built ONLY from the whitelist (the registry's `filterable`
 * flag) and the shared per-column expressions of `columnSql` (the same ones display and sort use):
 * the column id is never interpolated, user values are bound parameters (`$n`, with an explicit
 * `::numeric` cast for bounds), there is no `sql.raw` here. Filters combine with AND.
 *
 * `between` compares the WIRE value (`wire8Sql`), see its comment.
 *
 * A NULL value never satisfies a comparison (`NULL >= x` is NULL) nor `IN`: rows whose value is
 * unavailable are excluded while the filter is active, exactly as documented.
 */

function predicate(filter: Filter, cols: ReturnType<typeof columnSql>): SQL {
  const def = TABLE_COLUMNS_BY_ID.get(filter.columnId);
  const mapping = (cols as Record<string, (typeof cols)[keyof typeof cols] | undefined>)[
    filter.columnId
  ];
  if (def === undefined || def.filterable !== filter.kind || mapping === undefined) {
    throw new Error(`column "${String(filter.columnId)}" is not filterable (${filter.kind})`);
  }
  if (filter.kind === 'in') {
    const expr = mapping.filter ?? mapping.value;
    return sql`${expr} in (${sql.join(
      filter.values.map((v) => sql`${v}::text`),
      sql`, `,
    )})`;
  }
  // Compare the WIRE value (8 decimals half-even), i.e. the number the cell shows. A EUR price that
  // rounds to 0 is "too small to show" (`rounds_to_zero` cell): unavailable, so NULL here too.
  const wired = wire8Sql(mapping.value);
  const value = filter.columnId === 'price_eur' ? sql`nullif(${wired}, 0)` : wired;
  const bounds: SQL[] = [];
  if (filter.min !== undefined) bounds.push(sql`${value} >= ${filter.min}::numeric`);
  if (filter.max !== undefined) bounds.push(sql`${value} <= ${filter.max}::numeric`);
  if (bounds.length === 0) throw new Error('between filter without a bound');
  return sql.join(bounds, sql` and `);
}

/** One parenthesised predicate per filter (AND-combined by the caller); empty without filters. */
export function filterPredicates(
  filters: readonly Filter[] | undefined,
  ctx: ColumnSqlContext,
): SQL[] {
  if (filters === undefined || filters.length === 0) return [];
  const cols = columnSql(ctx);
  return filters.map((f) => sql`(${predicate(f, cols)})`);
}

/** Filterable columns whose SQL reads the EUR rate (a unit test checks this list against the real SQL). */
export const FX_FILTER_COLUMNS: ReadonlySet<string> = new Set(['price_eur', 'tracked_value_eur']);

/** `true` when a filter reads the FX rates: only then does the totals query join them. */
export const filtersNeedFx = (filters: readonly Filter[] | undefined): boolean =>
  filters?.some((f) => FX_FILTER_COLUMNS.has(f.columnId)) ?? false;
