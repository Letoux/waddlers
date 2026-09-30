import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Global reference data (not per space). Enums are text + CHECK. */
export const INSTRUMENT_TYPES = ['stock', 'etf'] as const;
export type InstrumentType = (typeof INSTRUMENT_TYPES)[number];

export const instruments = pgTable(
  'instruments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').$type<InstrumentType>().notNull(),
    name: text('name').notNull(),
    /** Nullable: never invented. Unique when present (several NULLs are allowed). */
    isin: text('isin').unique(),
    sector: text('sector'),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('instruments_type_check', sql`${table.type} in ('stock', 'etf')`),
    check('instruments_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check('instruments_isin_format', sql`${table.isin} ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'`),
  ],
);

export type Instrument = typeof instruments.$inferSelect;
