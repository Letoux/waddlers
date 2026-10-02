import {
  DEFAULT_TABLE_DENSITY,
  DEFAULT_TABLE_PAGE_SIZE,
  FILTERS_MAX,
  TABLE_COLUMN_IDS,
  TABLE_DENSITIES,
  TABLE_PAGE_SIZES,
  defaultTableConfig,
  filterSchema,
  tableConfigV1Schema,
  tableSortSchema,
  type Filter,
  type TableConfigColumn,
  type TableConfigV1,
  type TableColumnId,
} from '@waddlers/contracts';

/**
 * Migrate on read (S7, REVIEW-S6 F9): turns whatever is stored (an older version, a column that
 * was removed from the registry, a column that stopped being filterable, hand-edited JSON) into a
 * VALID `TableConfigV1`. It never throws and never invents data: it drops what is no longer valid
 * and fills the missing from the D24 defaults.
 *
 * - columns: unknown or duplicate ids dropped (order of the rest kept), registry columns the
 *   stored config does not know appended HIDDEN, in registry order; no visible column left (or an
 *   empty/garbage list) = the D24 default columns;
 * - sort: kept only if it is still a valid sortable column + direction;
 * - filters: each one kept only if it still validates (so a now-non-filterable column or a broken
 *   bound is dropped), one per column (first wins), at most `FILTERS_MAX`;
 * - density / pageSize: kept only if valid, else the default.
 */

const KNOWN = new Set<string>(TABLE_COLUMN_IDS);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function migrateColumns(raw: unknown): TableConfigColumn[] {
  const out: TableConfigColumn[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item) || typeof item.id !== 'string') continue;
      if (!KNOWN.has(item.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push({ id: item.id as TableColumnId, visible: item.visible === true });
    }
  }
  if (!out.some((c) => c.visible)) return defaultTableConfig().columns;
  for (const id of TABLE_COLUMN_IDS) if (!seen.has(id)) out.push({ id, visible: false });
  return out;
}

function migrateFilters(raw: unknown): Filter[] {
  const out: Filter[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw.slice(0, FILTERS_MAX * 2)) {
    const parsed = filterSchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.columnId)) continue;
    seen.add(parsed.data.columnId);
    out.push(parsed.data);
    if (out.length === FILTERS_MAX) break;
  }
  return out;
}

export function migrateTableConfig(raw: unknown): TableConfigV1 {
  const doc = isRecord(raw) ? raw : {};
  const sort = tableSortSchema.safeParse(doc.sort);
  const density = (TABLE_DENSITIES as readonly unknown[]).includes(doc.density)
    ? (doc.density as TableConfigV1['density'])
    : DEFAULT_TABLE_DENSITY;
  const pageSize = (TABLE_PAGE_SIZES as readonly unknown[]).includes(doc.pageSize)
    ? (doc.pageSize as TableConfigV1['pageSize'])
    : DEFAULT_TABLE_PAGE_SIZE;
  // The final parse is the guarantee (and a test): a migrated config is always a valid V1.
  return tableConfigV1Schema.parse({
    columns: migrateColumns(doc.columns),
    ...(sort.success ? { sort: sort.data } : {}),
    filters: migrateFilters(doc.filters),
    density,
    pageSize,
  });
}
