import { z } from 'zod';
import {
  DEFAULT_TABLE_COLUMNS,
  TABLE_COLUMN_IDS,
  tableColumnIdSchema,
  tableSortSchema,
} from './columns';
import { filtersSchema } from './filters';

/**
 * Persisted table configuration (S7, specs 16/19, D27): ONE per user and space (the user's own
 * view; never shared). Contents: ordered columns with visibility, sort, filters, density, page
 * size. NOT persisted: the search text and the period (they live in the URL).
 *
 * The stored document is versioned (`TABLE_CONFIG_VERSION`) and MIGRATED ON READ by the server:
 * unknown/removed column ids are dropped, columns added to the registry since are appended hidden,
 * a sort or filter that is no longer valid is dropped, an empty configuration falls back to the
 * D24 defaults. `save` is strict (a bad id is a BAD_REQUEST), `get` never fails on old data.
 */

export const TABLE_CONFIG_VERSION = 1;
export const TABLE_DENSITIES = ['comfortable', 'compact'] as const;
export const TABLE_PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_TABLE_DENSITY = 'comfortable';
export const DEFAULT_TABLE_PAGE_SIZE = 50;
/**
 * Hard bound of the stored document: a CHECK on `pg_column_size(config)`, which is the jsonb
 * (binary) size, NOT the JSON text length. A registry-sized config is ~2 KB of JSON.
 */
export const TABLE_CONFIG_MAX_BYTES = 16_384;
/**
 * Bound of what `save` accepts, in UTF-8 bytes of the JSON text. The 4 384-byte margin below the
 * CHECK is jsonb overhead, measured at about 750 bytes for the largest valid document (per-entry
 * headers and number/length encoding), plus headroom; it is NOT room for migrate-on-read (migration
 * runs in memory and the stored row is only rewritten by a `save`, which re-validates this bound).
 * An integration test saves the largest valid document and checks it fits the CHECK.
 */
export const TABLE_CONFIG_MAX_SAVE_BYTES = 12_000;

export const tableConfigColumnSchema = z.object({ id: tableColumnIdSchema, visible: z.boolean() });
export type TableConfigColumn = z.infer<typeof tableConfigColumnSchema>;

export const tableConfigV1Schema = z
  .object({
    /** Order = display order. Every id once. At least one visible column. */
    columns: z.array(tableConfigColumnSchema).min(1).max(TABLE_COLUMN_IDS.length),
    sort: tableSortSchema.optional(),
    filters: filtersSchema.optional(),
    density: z.enum(TABLE_DENSITIES).optional(),
    pageSize: z.union([z.literal(25), z.literal(50), z.literal(100), z.literal(200)]).optional(),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.columns.forEach((c, i) => {
      if (seen.has(c.id)) {
        ctx.addIssue({ code: 'custom', path: ['columns', i, 'id'], message: 'Colonne en double.' });
      }
      seen.add(c.id);
    });
    if (!config.columns.some((c) => c.visible)) {
      ctx.addIssue({ code: 'custom', path: ['columns'], message: 'Au moins une colonne visible.' });
    }
  });
export type TableConfigV1 = z.infer<typeof tableConfigV1Schema>;

/** D24 defaults: the default columns visible in D24 order, then every other registry column hidden. */
export function defaultTableConfig(): TableConfigV1 {
  const visible = new Set<string>(DEFAULT_TABLE_COLUMNS);
  return {
    columns: [
      ...DEFAULT_TABLE_COLUMNS.map((id) => ({ id, visible: true })),
      ...TABLE_COLUMN_IDS.filter((id) => !visible.has(id)).map((id) => ({ id, visible: false })),
    ],
    filters: [],
    density: DEFAULT_TABLE_DENSITY,
    pageSize: DEFAULT_TABLE_PAGE_SIZE,
  };
}

/** `isDefault` = no saved row: `config` is `defaultTableConfig()`. */
export const tableConfigOutputSchema = z.object({
  config: tableConfigV1Schema,
  isDefault: z.boolean(),
});
export type TableConfigOutput = z.infer<typeof tableConfigOutputSchema>;

/** UTF-8 byte length (this package has neither DOM nor Node typings, so no TextEncoder/Buffer). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export const tableConfigGetInputSchema = z.object({ spaceId: z.uuid() });
export const tableConfigSaveInputSchema = z.object({
  spaceId: z.uuid(),
  config: tableConfigV1Schema.refine(
    (c) => utf8Length(JSON.stringify(c)) <= TABLE_CONFIG_MAX_SAVE_BYTES,
    'Configuration trop volumineuse.',
  ),
});
export type TableConfigSaveInput = z.infer<typeof tableConfigSaveInputSchema>;
