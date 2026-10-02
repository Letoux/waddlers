import { z } from 'zod';
import { tableColumnIdSchema, tableSortSchema } from './columns';
import { dashboardPeriodSchema } from './dashboard';
import { filtersSchema } from './filters';

/**
 * `positions.list` table additions (S6). Numbers are plain decimal strings (never floats);
 * unavailable = `null` (rendered "—"), never "0". Dates are exchange-local `YYYY-MM-DD`.
 */

const plainDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Price, EUR price or tracked value. `reason` explains a null `amount` (a code, never prose). */
export const moneyCellSchema = z.object({
  kind: z.literal('money'),
  amount: z.string().nullable(),
  currency: z.string(),
  /** Date of the price the amount is based on. */
  asOf: plainDate.nullable(),
  /** Price older than 5 days or FX rate older than 7 days (same rule as the dashboard). Never "realtime". */
  isStale: z.boolean(),
  reason: z.string().nullable(),
});
export type MoneyCell = z.infer<typeof moneyCellSchema>;

/** Performance in the listing's LOCAL currency (D4), with the base trading day and the reason when null. */
export const perfCellSchema = z.object({
  kind: z.literal('perf'),
  value: z.string().nullable(),
  baseDate: plainDate.nullable(),
  reason: z.string().nullable(),
  /** Date of the end price the performance ends at. */
  asOf: plainDate.nullable(),
  isStale: z.boolean(),
});
export type PerfCell = z.infer<typeof perfCellSchema>;

/** Specs 34 direction: `eurPerUnit` = EUR for 1 unit of `currency` (1 USD = 0.85 EUR). */
export const fxCellSchema = z.object({
  kind: z.literal('fx'),
  eurPerUnit: z.string().nullable(),
  currency: z.string(),
  rateDate: plainDate.nullable(),
  isStale: z.boolean(),
});
export type FxCell = z.infer<typeof fxCellSchema>;

/**
 * A percentage that is not a performance over a period (debt ratio, dividend yield; S8 fills them):
 * no base date. Same null/reason/stale conventions as the other cells.
 */
export const percentCellSchema = z.object({
  kind: z.literal('percent'),
  value: z.string().nullable(),
  reason: z.string().nullable(),
  /** Date of the data the percentage is based on. */
  asOf: plainDate.nullable(),
  isStale: z.boolean(),
});
export type PercentCell = z.infer<typeof percentCellSchema>;

/**
 * A cell is a plain string (text, enum, date, decimal columns) or an object discriminated by
 * `kind` (`money | perf | percent | fx`): `switch (cell.kind)` narrows without a cast.
 */
export const tableCellSchema = z
  .union([
    z.string(),
    z.discriminatedUnion('kind', [
      moneyCellSchema,
      perfCellSchema,
      percentCellSchema,
      fxCellSchema,
    ]),
  ])
  .nullable();
export type TableCell = z.infer<typeof tableCellSchema>;

/** `values[columnId]` of a row: shape given by the column's `cell` kind in the registry. */
export const tableValuesSchema = z.partialRecord(tableColumnIdSchema, tableCellSchema);
export type TableValues = z.infer<typeof tableValuesSchema>;

/**
 * The table returns at most this many characters of `description` (a preview, security P3); the full
 * text is read by the instrument detail (S9). `descriptionTruncated` on the row says it was cut.
 */
export const DESCRIPTION_PREVIEW_CHARS = 280;

export const POSITIONS_SEARCH_MAX = 100;
/** Free text; `%`, `_` and `\` are literal. NUL is refused (PostgreSQL text cannot hold it). */
export const positionsSearchSchema = z
  .string()
  .max(POSITIONS_SEARCH_MAX)
  .refine((s) => !s.includes('\u0000'), 'Recherche invalide.');

/** Optional fields of `positions.list` added by S6 and S7 (all additive). */
export const positionsTableInputFields = {
  /** Drives `perf_period`. Default `1m` (the dashboard default). */
  period: dashboardPeriodSchema.optional(),
  /** Case-insensitive substring over name, code, ISIN, sector, currency, exchange name and MIC. */
  search: positionsSearchSchema.optional(),
  /** NULLS LAST in both directions, stable tiebreak (name, position id). Default: name asc. */
  sort: tableSortSchema.optional(),
  /** Which `values` to return (default: `DEFAULT_TABLE_COLUMNS`). Pending columns come back null. */
  columns: z.array(tableColumnIdSchema).max(64).optional(),
  /** S7, specs 21: combined with AND, applied to `rows` and `total` (see `filters.ts`). */
  filters: filtersSchema.optional(),
} as const;
