import {
  DEFAULT_TABLE_DENSITY,
  DEFAULT_TABLE_PAGE_SIZE,
  TABLE_COLUMNS_BY_ID,
  type Filter,
  type TableColumnId,
  type TableConfigV1,
  type TableSort,
} from '@waddlers/contracts';

/**
 * Pure helpers over the persisted table configuration (S7, D27): config <-> table state mapping
 * and the edits of the column chooser. Nothing here touches React or the network.
 */

export type Density = NonNullable<TableConfigV1['density']>;
export type PageSize = NonNullable<TableConfigV1['pageSize']>;

/** Visible columns in config order: what `positions.list.columns` and the table columns use. */
export function visibleColumnIds(config: TableConfigV1): TableColumnId[] {
  return config.columns.filter((c) => c.visible).map((c) => c.id);
}

export const configDensity = (config: TableConfigV1): Density =>
  config.density ?? DEFAULT_TABLE_DENSITY;
export const configPageSize = (config: TableConfigV1): PageSize =>
  config.pageSize ?? DEFAULT_TABLE_PAGE_SIZE;
export const configFilters = (config: TableConfigV1): readonly Filter[] => config.filters ?? [];

/**
 * Sort precedence: a valid `?tri=` in the URL wins (shareable link, not saved by itself); else the
 * saved sort; else none. A click on a header writes BOTH (URL and config), so after any user
 * action they agree.
 */
export function effectiveSort(config: TableConfigV1, urlSort: TableSort | null): TableSort | null {
  return urlSort ?? config.sort ?? null;
}

export function withSort(config: TableConfigV1, sort: TableSort | null): TableConfigV1 {
  const next = { ...config };
  delete next.sort;
  return sort ? { ...next, sort } : next;
}

export const withDensity = (config: TableConfigV1, density: Density): TableConfigV1 => ({
  ...config,
  density,
});
export const withPageSize = (config: TableConfigV1, pageSize: PageSize): TableConfigV1 => ({
  ...config,
  pageSize,
});
export const withFilters = (config: TableConfigV1, filters: readonly Filter[]): TableConfigV1 => ({
  ...config,
  filters: [...filters],
});

/** A pending (S8) column cannot be shown: it would be a column of dashes. */
export const isSelectable = (id: TableColumnId) =>
  TABLE_COLUMNS_BY_ID.get(id)?.availability === 'available';

/**
 * Shows (at the end) or hides one column. Refused (same object returned) when it would leave no visible column
 * or when the column is pending. Hiding a column keeps its place in the order.
 */
export function toggleColumn(
  config: TableConfigV1,
  id: TableColumnId,
  visible: boolean,
): TableConfigV1 {
  const current = config.columns.find((c) => c.id === id);
  if (!current || current.visible === visible) return config;
  if (visible && !isSelectable(id)) return config;
  if (!visible && config.columns.filter((c) => c.visible).length <= 1) return config;
  // A newly shown column goes last (predictable); a hidden one keeps its slot.
  if (visible) {
    return { ...config, columns: [...config.columns.filter((c) => c.id !== id), { id, visible }] };
  }
  return {
    ...config,
    columns: config.columns.map((c) => (c.id === id ? { ...c, visible } : c)),
  };
}

/**
 * Moves a column one step among the VISIBLE columns (the order the user sees); hidden columns
 * keep their slot relative to each other. Out of range: same object.
 */
export function moveColumn(
  config: TableConfigV1,
  id: TableColumnId,
  direction: -1 | 1,
): TableConfigV1 {
  const visibleIdx = config.columns.flatMap((c, i) => (c.visible ? [i] : []));
  const at = visibleIdx.findIndex((i) => config.columns[i]?.id === id);
  const target = visibleIdx[at + direction];
  const from = visibleIdx[at];
  if (at < 0 || target === undefined || from === undefined) return config;
  const columns = [...config.columns];
  const a = columns[from];
  const b = columns[target];
  if (!a || !b) return config;
  columns[from] = b;
  columns[target] = a;
  return { ...config, columns };
}
