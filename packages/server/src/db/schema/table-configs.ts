import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { TABLE_CONFIG_MAX_BYTES } from '@waddlers/contracts';
import { spaceMembers } from './spaces';

/**
 * Persisted table view (S7, D27): one row per (user, space). The composite FK to the MEMBERSHIP
 * (not to users and spaces separately) means a revoked membership takes the row with it, and a
 * user can never hold a config for a space they are not in. The primary key is the only lookup
 * (get/save/reset are always by (user, space)); the FK's referencing columns are covered by it too.
 * `config` is the versioned document of `@waddlers/contracts` (`tableConfigV1Schema`), migrated on
 * read; the CHECK bounds its size whatever the application does.
 */
export const tableConfigs = pgTable(
  'table_configs',
  {
    userId: uuid('user_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    /** Schema version of `config` (`TABLE_CONFIG_VERSION` when written). */
    version: integer('version').notNull(),
    config: jsonb('config').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.spaceId] }),
    foreignKey({
      name: 'table_configs_member_fk',
      columns: [table.spaceId, table.userId],
      foreignColumns: [spaceMembers.spaceId, spaceMembers.userId],
    }).onDelete('cascade'),
    check('table_configs_version_positive', sql`${table.version} >= 1`),
    check(
      'table_configs_config_size',
      sql`jsonb_typeof(${table.config}) = 'object' and pg_column_size(${table.config}) <= ${sql.raw(String(TABLE_CONFIG_MAX_BYTES))}`,
    ),
  ],
);

export type TableConfigRow = typeof tableConfigs.$inferSelect;
