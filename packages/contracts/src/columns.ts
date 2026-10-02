import { z } from 'zod';

/**
 * Table column registry (S6, specs 16-18). `label` is the specs 17 wording, word for word (straight
 * apostrophes included); `shortLabel` is the compact header (specs 18 wording where it has one). METADATA only, browser-safe: the SQL mapping of the
 * sortable columns lives in `packages/server/src/spaces/table-columns.ts` and a server test fails
 * when a sortable column has no mapping. Fundamentals that are not stored yet (S8) are declared
 * (`availability: 'pending_s8'`): they are always `null` ("—"), never sortable, never invented.
 */

export const COLUMN_GROUPS = [
  { id: 'identification', label: 'Identification' },
  { id: 'description', label: 'Description' },
  { id: 'price', label: 'Cours' },
  { id: 'valuation', label: 'Valorisation' },
  { id: 'debt', label: 'Endettement' },
  { id: 'shareholders', label: 'Actionnariat' },
  { id: 'dividends', label: 'Dividendes' },
  { id: 'performance', label: 'Performance' },
  { id: 'tracking', label: 'Suivi' },
] as const;
export type ColumnGroupId = (typeof COLUMN_GROUPS)[number]['id'];

/** Semantic type of the column (sorting and filter families). */
export type ColumnDataType = 'text' | 'enum' | 'decimal' | 'percent' | 'money' | 'date';

/** Shape of `values[columnId]` in `positions.list` (see `tableCellSchema`). */
export type ColumnCell = 'text' | 'decimal' | 'date' | 'money' | 'perf' | 'percent' | 'fx' | 'row';
/**
 * `row` = no entry in `values`: the value lives on the row itself (`row.quantity`, the single source
 * of the quantity, also what `positions.setQuantity` edits). The column is still requestable,
 * sortable and filterable; asking for it adds nothing to `values`.
 */

/**
 * What the number means: `listing_currency` = the listing's raw currency (GBX stays pence),
 * `eur` = euros (reference currency, D7), `eur_per_unit` = specs 34 direction (1 USD = 0.85 EUR).
 */
export type ColumnUnit = 'percent' | 'eur' | 'listing_currency' | 'eur_per_unit' | 'quantity';

export interface TableColumnDef {
  id: string;
  /** French label, EXACTLY the specs 17 wording (the extra columns `perf_period`, `quantity` and `tracked_value_eur` use their own). */
  label: string;
  /** Compact header (specs 18 wording), defaults to `label`. */
  shortLabel?: string;
  group: ColumnGroupId;
  dataType: ColumnDataType;
  cell: ColumnCell;
  unit?: ColumnUnit;
  sortable: boolean;
  /**
   * S7 filter family (specs 21): `in` = one of a set of values (enum columns), `between` = numeric
   * min/max, `false` = not filterable. The `pending_s8` fundamentals are `false` on purpose: a
   * filter on a value that is always "—" would silently hide every row, so it is refused (BAD_REQUEST)
   * until S8 stores the data and flips the flag.
   */
  filterable: 'in' | 'between' | false;
  availability: 'available' | 'pending_s8';
}

const col = <const T extends TableColumnDef>(def: T): T => def;
const pending = { availability: 'pending_s8', sortable: false, filterable: false } as const;
const ok = { availability: 'available', filterable: false } as const;
const okIn = { availability: 'available', filterable: 'in' } as const;
const okBetween = { availability: 'available', filterable: 'between' } as const;

// One column per line: a registry is read as a table.
// prettier-ignore
export const TABLE_COLUMNS = [
  // Identification
  col({ id: 'name', label: 'Société', group: 'identification', dataType: 'text', cell: 'text', sortable: true, ...ok }),
  col({ id: 'symbol', label: 'Code', group: 'identification', dataType: 'text', cell: 'text', sortable: true, ...ok }),
  col({ id: 'instrument_type', label: "Type d'instrument", group: 'identification', dataType: 'enum', cell: 'text', sortable: true, ...okIn }),
  col({ id: 'exchange', label: 'Place de cotation retenue', group: 'identification', dataType: 'text', cell: 'text', sortable: true, ...okIn }),
  col({ id: 'selection_reason', label: 'Logique de choix de la place', group: 'identification', dataType: 'text', cell: 'text', sortable: true, ...ok }),
  col({ id: 'currency', label: 'Devise', group: 'identification', dataType: 'enum', cell: 'text', sortable: true, ...okIn }),
  col({ id: 'sector', label: "Secteur d'activité", shortLabel: 'Secteur', group: 'identification', dataType: 'text', cell: 'text', sortable: true, ...okIn }),
  // Description
  col({ id: 'description', label: 'Activité & positionnement concurrentiel', shortLabel: 'Activité', group: 'description', dataType: 'text', cell: 'text', sortable: false, ...ok }),
  // Cours. `price` is NOT sortable: it mixes currencies (GBX, USD, EUR); sort `price_eur`.
  col({ id: 'price', label: 'Cours dans la devise locale', shortLabel: 'Cours local', group: 'price', dataType: 'money', cell: 'money', unit: 'listing_currency', sortable: false, ...ok }),
  col({ id: 'fx_rate', label: 'Taux de change → EUR', group: 'price', dataType: 'decimal', cell: 'fx', unit: 'eur_per_unit', sortable: false, ...ok }),
  col({ id: 'price_eur', label: 'Cours en EUR', shortLabel: 'Cours EUR', group: 'price', dataType: 'money', cell: 'money', unit: 'eur', sortable: true, ...okBetween }),
  col({ id: 'price_date', label: 'Date du cours', group: 'price', dataType: 'date', cell: 'date', sortable: true, ...ok }),
  // Valorisation (S8)
  col({ id: 'market_cap', label: 'Capitalisation dans la devise locale', shortLabel: 'Capitalisation locale', group: 'valuation', dataType: 'money', cell: 'money', unit: 'listing_currency', ...pending }),
  col({ id: 'market_cap_eur', label: 'Capitalisation en EUR', shortLabel: 'Capitalisation EUR', group: 'valuation', dataType: 'money', cell: 'money', unit: 'eur', ...pending }),
  col({ id: 'enterprise_value', label: "Valeur d'entreprise", shortLabel: 'VE', group: 'valuation', dataType: 'money', cell: 'money', unit: 'eur', ...pending }),
  col({ id: 'ev_to_market_cap', label: 'VE / Capitalisation', group: 'valuation', dataType: 'decimal', cell: 'decimal', ...pending }),
  // Endettement (S8)
  col({ id: 'net_debt', label: 'Dette nette', group: 'debt', dataType: 'money', cell: 'money', unit: 'eur', ...pending }),
  col({ id: 'debt_ratio', label: "Taux d'endettement", group: 'debt', dataType: 'percent', cell: 'percent', unit: 'percent', ...pending }),
  col({ id: 'debt_ratio_kind', label: "Nature du ratio d'endettement", shortLabel: 'Nature du ratio', group: 'debt', dataType: 'enum', cell: 'text', ...pending }),
  // Actionnariat (S8)
  col({ id: 'main_holders', label: 'Principaux actionnaires', group: 'shareholders', dataType: 'text', cell: 'text', ...pending }),
  // Dividendes (S8)
  col({ id: 'dividend_annual', label: 'Dividende annuel', group: 'dividends', dataType: 'money', cell: 'money', unit: 'listing_currency', ...pending }),
  col({ id: 'dividend_yield', label: 'Rendement du dividende', group: 'dividends', dataType: 'percent', cell: 'percent', unit: 'percent', ...pending }),
  // Performance: perf_period resolves to perf_<period> (the global period of the dashboard).
  col({ id: 'perf_period', label: 'Performance période', group: 'performance', dataType: 'percent', cell: 'perf', unit: 'percent', sortable: true, ...okBetween }),
  col({ id: 'perf_1w', label: 'Performance 1 semaine', shortLabel: 'Perf. 1 sem.', group: 'performance', dataType: 'percent', cell: 'perf', unit: 'percent', sortable: true, ...okBetween }),
  col({ id: 'perf_1m', label: 'Performance 1 mois', shortLabel: 'Perf. 1 mois', group: 'performance', dataType: 'percent', cell: 'perf', unit: 'percent', sortable: true, ...okBetween }),
  col({ id: 'perf_6m', label: 'Performance 6 mois', shortLabel: 'Perf. 6 mois', group: 'performance', dataType: 'percent', cell: 'perf', unit: 'percent', sortable: true, ...okBetween }),
  col({ id: 'perf_1y', label: 'Performance 12 mois', shortLabel: 'Perf. 12 mois', group: 'performance', dataType: 'percent', cell: 'perf', unit: 'percent', sortable: true, ...okBetween }),
  col({ id: 'perf_5y', label: 'Performance 60 mois', shortLabel: 'Perf. 60 mois', group: 'performance', dataType: 'percent', cell: 'perf', unit: 'percent', sortable: true, ...okBetween }),
  col({ id: 'perf_max', label: 'Performance Max', shortLabel: 'Perf. Max', group: 'performance', dataType: 'percent', cell: 'perf', unit: 'percent', sortable: true, ...okBetween }),
  // Suivi (specs 33): own quantity (editable with positions.setQuantity) and its value in EUR.
  col({ id: 'quantity', label: 'Quantité', group: 'tracking', dataType: 'decimal', cell: 'row', unit: 'quantity', sortable: true, ...ok }),
  col({ id: 'tracked_value_eur', label: 'Valeur suivie (EUR)', group: 'tracking', dataType: 'money', cell: 'money', unit: 'eur', sortable: true, ...okBetween }),
] as const;

export type TableColumnId = (typeof TABLE_COLUMNS)[number]['id'];
export type AvailableColumnId = Extract<
  (typeof TABLE_COLUMNS)[number],
  { availability: 'available' }
>['id'];
export type SortableColumnId = Extract<(typeof TABLE_COLUMNS)[number], { sortable: true }>['id'];
export type InFilterColumnId = Extract<(typeof TABLE_COLUMNS)[number], { filterable: 'in' }>['id'];
export type BetweenFilterColumnId = Extract<
  (typeof TABLE_COLUMNS)[number],
  { filterable: 'between' }
>['id'];
export type FilterableColumnId = InFilterColumnId | BetweenFilterColumnId;

/** French labels of the instrument types (display and the sort key of `instrument_type`). */
export const INSTRUMENT_TYPE_LABELS = { stock: 'Action', etf: 'ETF' } as const;

export const TABLE_COLUMN_IDS = TABLE_COLUMNS.map((c) => c.id) as readonly TableColumnId[];
export const SORTABLE_COLUMN_IDS = TABLE_COLUMNS.filter((c) => c.sortable).map(
  (c) => c.id,
) as readonly SortableColumnId[];

export const IN_FILTER_COLUMN_IDS = TABLE_COLUMNS.filter((c) => c.filterable === 'in').map(
  (c) => c.id,
) as readonly InFilterColumnId[];
export const BETWEEN_FILTER_COLUMN_IDS = TABLE_COLUMNS.filter(
  (c) => c.filterable === 'between',
).map((c) => c.id) as readonly BetweenFilterColumnId[];

export const TABLE_COLUMNS_BY_ID: ReadonlyMap<TableColumnId, TableColumnDef> = new Map(
  TABLE_COLUMNS.map((c) => [c.id, c]),
);

/**
 * D24 (2026-10-01): the specs 18 default set plus Quantité (editable, specs 33) and Valeur
 * suivie (EUR), placed after Code and Cours EUR. The user's saved configuration (S7) overrides it.
 */
export const DEFAULT_TABLE_COLUMNS: readonly TableColumnId[] = [
  'name',
  'symbol',
  'price_eur',
  'quantity',
  'tracked_value_eur',
  'market_cap_eur',
  'sector',
  'dividend_yield',
  'perf_period',
  'perf_1y',
  'perf_5y',
];

export const tableColumnIdSchema = z.enum(
  TABLE_COLUMN_IDS as unknown as [TableColumnId, ...TableColumnId[]],
);
/** Whitelist of sortable ids (derived from the registry, never typed by hand). */
export const sortableColumnIdSchema = z.enum(
  SORTABLE_COLUMN_IDS as unknown as [SortableColumnId, ...SortableColumnId[]],
);

export const sortDirectionSchema = z.enum(['asc', 'desc']);
export const tableSortSchema = z.object({
  columnId: sortableColumnIdSchema,
  direction: sortDirectionSchema,
});
export type TableSort = z.infer<typeof tableSortSchema>;
