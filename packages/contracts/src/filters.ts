import { z } from 'zod';
import { isStorableText } from './text';
import {
  BETWEEN_FILTER_COLUMN_IDS,
  IN_FILTER_COLUMN_IDS,
  type BetweenFilterColumnId,
  type InFilterColumnId,
} from './columns';

/**
 * Table filters (S7, specs 21). Filters of `positions.list` are combined with AND (specs 21 "ET").
 * At most one filter per column (a second range on the same column is a client bug, not a feature).
 *
 * - `in`: enum columns (type, sector, currency, exchange). The value is compared EXACTLY (case
 *   included) with the stored one; `instrument_type` takes `stock | etf`, `currency` the MAJOR
 *   currency (D28: `GBP` matches GBX/GBp listings, `ZAR` matches ZAc; the Devise cell keeps the raw
 *   spelling), `exchange` the MIC (`XPAR`), `sector` the stored sector text. Values are refused
 *   when they contain NUL or a lone UTF-16 surrogate.
 * - `between`: numeric columns, inclusive bounds, plain decimal strings (no exponent, no floats).
 *   Percent columns (every `perf_*`) take PERCENT units: `10` means 10 %. Money columns
 *   (`price_eur`, `tracked_value_eur`) take euros.
 * - A `null` ("—") value NEVER matches a `between` filter: a row whose value is unavailable is
 *   excluded while the filter is active (not guessed, not treated as 0). The same for `in`.
 * - Columns that are not `filterable` in the registry (the S8 fundamentals, always "—") are
 *   refused by this schema (BAD_REQUEST): a filter must never silently hide every row.
 */

export const FILTERS_MAX = 20;
export const FILTER_IN_VALUES_MAX = 50;
export const FILTER_VALUE_MAX_CHARS = 100;

/** Plain signed decimal: at most 15 integer digits and 8 fraction digits, no exponent, no `+`. */
export const FILTER_DECIMAL_REGEX = /^-?(0|[1-9][0-9]{0,14})(\.[0-9]{1,8})?$/;
export const filterDecimalSchema = z
  .string()
  .regex(FILTER_DECIMAL_REGEX, 'Nombre décimal invalide (séparateur « . », sans exposant).');

/** Scaled integer (8 fraction digits) of a validated decimal string, for exact comparison. */
function scaled(value: string): bigint {
  const negative = value.startsWith('-');
  const [int = '0', frac = ''] = (negative ? value.slice(1) : value).split('.');
  const n = BigInt(int + frac.padEnd(8, '0'));
  return negative ? -n : n;
}
/** Exact comparison of two validated decimal strings (-1, 0, 1). */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  const x = scaled(a);
  const y = scaled(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const inColumnIdSchema = z.enum(
  IN_FILTER_COLUMN_IDS as unknown as [InFilterColumnId, ...InFilterColumnId[]],
);
const betweenColumnIdSchema = z.enum(
  BETWEEN_FILTER_COLUMN_IDS as unknown as [BetweenFilterColumnId, ...BetweenFilterColumnId[]],
);

const valueSchema = z
  .string()
  .min(1)
  .max(FILTER_VALUE_MAX_CHARS)
  .refine(isStorableText, 'Valeur invalide.');

/** Closed or formatted domains: `instrument_type` is a closed list, currency and MIC have a fixed shape. */
const VALUE_DOMAIN: Record<string, RegExp> = {
  instrument_type: /^(stock|etf)$/,
  currency: /^[A-Z]{3}$/,
  exchange: /^[A-Z0-9]{4}$/,
};

export const inFilterSchema = z
  .object({
    kind: z.literal('in'),
    columnId: inColumnIdSchema,
    values: z.array(valueSchema).min(1).max(FILTER_IN_VALUES_MAX),
  })
  .superRefine((f, ctx) => {
    const domain = VALUE_DOMAIN[f.columnId];
    if (domain === undefined) return;
    f.values.forEach((v, i) => {
      if (!domain.test(v))
        ctx.addIssue({ code: 'custom', path: ['values', i], message: 'Valeur invalide.' });
    });
  });

export const betweenFilterSchema = z
  .object({
    kind: z.literal('between'),
    columnId: betweenColumnIdSchema,
    min: filterDecimalSchema.optional(),
    max: filterDecimalSchema.optional(),
  })
  .superRefine((f, ctx) => {
    if (f.min === undefined && f.max === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Un minimum ou un maximum est requis.' });
    } else if (
      f.min !== undefined &&
      f.max !== undefined &&
      compareDecimalStrings(f.min, f.max) > 0
    ) {
      ctx.addIssue({ code: 'custom', path: ['min'], message: 'Le minimum dépasse le maximum.' });
    }
  });

export const filterSchema = z.discriminatedUnion('kind', [inFilterSchema, betweenFilterSchema]);
export type Filter = z.infer<typeof filterSchema>;
export type InFilter = z.infer<typeof inFilterSchema>;
export type BetweenFilter = z.infer<typeof betweenFilterSchema>;

export const filtersSchema = z
  .array(filterSchema)
  .max(FILTERS_MAX)
  .superRefine((filters, ctx) => {
    const seen = new Set<string>();
    filters.forEach((f, i) => {
      if (seen.has(f.columnId)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'columnId'],
          message: 'Un seul filtre par colonne.',
        });
      }
      seen.add(f.columnId);
    });
  });
