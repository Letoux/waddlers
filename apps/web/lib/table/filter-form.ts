import {
  compareDecimalStrings,
  filterDecimalSchema,
  INSTRUMENT_TYPE_LABELS,
  TABLE_COLUMNS_BY_ID,
  type BetweenFilter,
  type BetweenFilterColumnId,
  type DashboardPeriod,
  type Filter,
  type FacetValue,
  type InFilter,
  type InFilterColumnId,
  type PositionsFacetsOutput,
} from '@waddlers/contracts';
import { parseQuantityInput } from '@/lib/spaces/quantity';
import { columnHeader } from '@/lib/table/cells';

/**
 * Filter building and labels (S7, specs 21). The form works on what the user types (French
 * decimal comma, optional sign); the API receives plain decimal strings with `.`. Percent
 * columns are in percent units (`10` = 10 %), money columns in EUR.
 */

export const FILTER_NOTE = 'Les titres sans donnée pour un filtre actif sont masqués.';
export const BOUND_INVALID = 'Nombre invalide (ex. -12,5).';
export const RANGE_INVALID = 'Le minimum dépasse le maximum.';

export type BoundResult = { ok: true; value: string | null } | { ok: false; message: string };

/** One typed bound -> API decimal string; blank -> `null`; accepts `,` or `.`, `-` or `−`. */
export function parseBound(raw: string): BoundResult {
  const text = raw.trim().replace(/^[−–]/, '-');
  if (text === '') return { ok: true, value: null };
  const negative = text.startsWith('-');
  const magnitude = parseQuantityInput(negative ? text.slice(1).trimStart() : text);
  if (!magnitude.ok) return { ok: false, message: magnitude.message };
  if (magnitude.value === null) return { ok: false, message: BOUND_INVALID };
  const signed =
    negative && /[1-9]/.test(magnitude.value) ? `-${magnitude.value}` : magnitude.value;
  return filterDecimalSchema.safeParse(signed).success
    ? { ok: true, value: signed }
    : { ok: false, message: BOUND_INVALID };
}

export type RangeResult =
  | { ok: true; filter: BetweenFilter | null }
  | { ok: false; minError?: string; maxError?: string; rangeError?: string };

/** Typed min/max -> a `between` filter; both blank -> no filter; min > max is an error. */
export function buildBetweenFilter(
  columnId: BetweenFilterColumnId,
  rawMin: string,
  rawMax: string,
): RangeResult {
  const min = parseBound(rawMin);
  const max = parseBound(rawMax);
  if (!min.ok || !max.ok) {
    return {
      ok: false,
      ...(!min.ok ? { minError: min.message } : {}),
      ...(!max.ok ? { maxError: max.message } : {}),
    };
  }
  if (min.value === null && max.value === null) return { ok: true, filter: null };
  if (min.value !== null && max.value !== null && compareDecimalStrings(min.value, max.value) > 0) {
    return { ok: false, rangeError: RANGE_INVALID };
  }
  return {
    ok: true,
    filter: {
      kind: 'between',
      columnId,
      ...(min.value !== null ? { min: min.value } : {}),
      ...(max.value !== null ? { max: max.value } : {}),
    },
  };
}

/** Text to prefill an input from a stored bound: decimal comma. */
export const boundToText = (bound: string | undefined) => (bound ?? '').replace('.', ',');

/** Replace (or add, or with `null` remove) the single filter of a column. */
export function upsertFilter(
  filters: readonly Filter[],
  columnId: string,
  next: Filter | null,
): Filter[] {
  const rest = filters.filter((f) => f.columnId !== columnId);
  return next ? [...rest, next] : rest;
}

/** Tick or untick one value of an `in` filter; no value left removes the filter. */
export function toggleInValue(
  filters: readonly Filter[],
  columnId: InFilterColumnId,
  value: string,
  checked: boolean,
): Filter[] {
  const current = filters.find((f): f is InFilter => f.kind === 'in' && f.columnId === columnId);
  const values = new Set(current?.values ?? []);
  if (checked) values.add(value);
  else values.delete(value);
  return upsertFilter(
    filters,
    columnId,
    values.size > 0 ? { kind: 'in', columnId, values: [...values] } : null,
  );
}

const fmt = (decimal: string) => decimal.replace('-', '−').replace('.', ',');

function rangeLabel(f: BetweenFilter, unit: string): string {
  const u = unit ? `\u00a0${unit}` : '';
  if (f.min !== undefined && f.max !== undefined) return `${fmt(f.min)}${u} à ${fmt(f.max)}${u}`;
  if (f.min !== undefined) return `≥ ${fmt(f.min)}${u}`;
  return `≤ ${fmt(f.max ?? '')}${u}`;
}

function inValueLabel(columnId: string, value: string, facets: PositionsFacetsOutput | undefined) {
  const known = facets?.[columnId as InFilterColumnId]?.find((v: FacetValue) => v.value === value);
  if (known) return known.label;
  if (columnId === 'instrument_type') {
    return INSTRUMENT_TYPE_LABELS[value as keyof typeof INSTRUMENT_TYPE_LABELS] ?? value;
  }
  return value;
}

/**
 * Column name in the filter UI. A saved `perf_period` filter follows the URL period, so its name
 * carries the period it applies to now ("Perf. 1 mois (période)").
 */
export function filterColumnName(columnId: string, period: DashboardPeriod): string {
  const def = TABLE_COLUMNS_BY_ID.get(columnId as never);
  if (!def) return columnId;
  return columnId === 'perf_period'
    ? `${columnHeader(def, period)} (période)`
    : columnHeader(def, period);
}

/** Facet option of an active `in` value that the facets no longer return (count 0 = absent). */
export type FacetOption = FacetValue;

/**
 * Choices of an `in` filter: the facets, plus every ACTIVE value the facets do not return any more
 * (position removed, renamed, 200 cap) with count 0, so it stays visible, checked, and can be
 * unticked.
 */
export function mergeFacetOptions(
  columnId: InFilterColumnId,
  options: readonly FacetValue[],
  activeValues: readonly string[],
): FacetOption[] {
  const known = new Set(options.map((o) => o.value));
  const missing = activeValues
    .filter((v) => !known.has(v))
    .map((value) => ({ value, label: inValueLabel(columnId, value, undefined), count: 0 }));
  return [...options, ...missing];
}

/** Visible text of a filter chip, e.g. "Perf. 12 mois : 5 % à 20 %" or "Devise : EUR, USD". */
export function chipLabel(
  filter: Filter,
  facets: PositionsFacetsOutput | undefined,
  period: DashboardPeriod,
): string {
  const def = TABLE_COLUMNS_BY_ID.get(filter.columnId);
  const name = filterColumnName(filter.columnId, period);
  if (filter.kind === 'in') {
    return `${name} : ${filter.values.map((v) => inValueLabel(filter.columnId, v, facets)).join(', ')}`;
  }
  const unit = def?.unit === 'percent' ? '%' : def?.unit === 'eur' ? '€' : '';
  return `${name} : ${rangeLabel(filter, unit)}`;
}
