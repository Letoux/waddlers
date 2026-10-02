import {
  DEFAULT_TABLE_COLUMNS,
  TABLE_COLUMNS_BY_ID,
  type TableColumnDef,
  type TableColumnId,
} from '@waddlers/contracts';

/**
 * Columns to display, in order. S6 only has the default set (D24); S7 plugs the user's saved
 * configuration (visibility and order, validated against the registry) in here: pass it as
 * `configured` and everything downstream (query `columns`, table columns) follows.
 */
export function resolveVisibleColumns(
  configured?: readonly TableColumnId[] | null,
): readonly TableColumnDef[] {
  const ids = configured && configured.length > 0 ? configured : DEFAULT_TABLE_COLUMNS;
  const seen = new Set<TableColumnId>();
  const defs: TableColumnDef[] = [];
  for (const id of ids) {
    const def = TABLE_COLUMNS_BY_ID.get(id);
    if (def && !seen.has(id)) {
      seen.add(id);
      defs.push(def);
    }
  }
  return defs;
}

/** A column can be sorted only when the registry says so (pending columns never are). */
export const isSortable = (def: TableColumnDef) => def.sortable && def.availability === 'available';
