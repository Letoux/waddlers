import {
  DEFAULT_TABLE_DENSITY,
  DEFAULT_TABLE_PAGE_SIZE,
  FILTERS_MAX,
  TABLE_CONFIG_VERSION,
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
import { MINOR_UNITS } from '@waddlers/domain';

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
 * - a `currency` filter value that is a minor-unit spelling becomes its major currency (D28);
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

/** D28: a currency filter saved with a raw spelling (`GBX`) now means its major currency (`GBP`). */
function toMajorCurrencies(filter: Filter): Filter {
  if (filter.kind !== 'in' || filter.columnId !== 'currency') return filter;
  const values = filter.values.map((v) => (Object.hasOwn(MINOR_UNITS, v) ? MINOR_UNITS[v]![0] : v));
  return { ...filter, values: [...new Set(values)] };
}

/**
 * Save path of D28 (review F-B1): the stored document already says `GBP`, so what `save` answers is
 * what is stored and what `get` returns, and the UI's cache never differs from the row.
 */
export function withMajorCurrencyFilters(config: TableConfigV1): TableConfigV1 {
  if (!config.filters?.some((f) => f.kind === 'in' && f.columnId === 'currency')) return config;
  return { ...config, filters: config.filters.map(toMajorCurrencies) };
}

function migrateFilters(raw: unknown): Filter[] {
  const out: Filter[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw.slice(0, FILTERS_MAX * 2)) {
    const parsed = filterSchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.columnId)) continue;
    seen.add(parsed.data.columnId);
    out.push(toMajorCurrencies(parsed.data));
    if (out.length === FILTERS_MAX) break;
  }
  return out;
}

/** The V1 normaliser: whatever the document is, the result is a valid `TableConfigV1`. */
function normaliseV1(raw: unknown): TableConfigV1 {
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

/**
 * Version steps: `STEPS[v]` turns a stored version-`v` document into a version-`v + 1` one. Add
 * one per `TABLE_CONFIG_VERSION` bump (a step may assume nothing beyond `unknown`: the final
 * normaliser re-validates). Version 0 = a document written before the version column was trusted:
 * shaped like V1, so its step is the identity.
 */
const STEPS: Record<number, (doc: unknown) => unknown> = {
  0: (doc) => doc,
};

/** `true` for a document written by a NEWER app version than this one (a rollback scenario). */
export const isNewerTableConfigVersion = (version: number): boolean =>
  version > TABLE_CONFIG_VERSION;

/**
 * Runs the step chain from the stored `version` up to `TABLE_CONFIG_VERSION` and normalises. The
 * result is ALWAYS the current shape (callers write `TABLE_CONFIG_VERSION` with it). A stored
 * version above the current one has no steps to run: it is read best-effort (what still validates
 * is kept) and `save` refuses to overwrite it (CONFLICT), so a rollback never destroys a newer view.
 */
export function migrateTableConfig(
  raw: unknown,
  version: number = TABLE_CONFIG_VERSION,
): TableConfigV1 {
  let doc = raw;
  const start = Number.isInteger(version) && version >= 0 ? version : 0;
  for (let v = start; v < TABLE_CONFIG_VERSION; v++) doc = (STEPS[v] ?? ((d) => d))(doc);
  return normaliseV1(doc);
}
