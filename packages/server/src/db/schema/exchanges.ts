import { sql } from 'drizzle-orm';
import { check, pgTable, text } from 'drizzle-orm/pg-core';

/** Global reference data (not per space): trading venues, keyed by ISO 10383 MIC. */
export const exchanges = pgTable(
  'exchanges',
  {
    mic: text('mic').primaryKey(),
    name: text('name').notNull(),
    /** IANA timezone; trading dates are exchange-local (specs 31, DOMAIN.md). */
    timezone: text('timezone').notNull(),
    /** ISO 3166-1 alpha-2. */
    country: text('country').notNull(),
  },
  (table) => [
    check('exchanges_mic_format', sql`${table.mic} ~ '^[A-Z0-9]{4}$'`),
    check('exchanges_country_format', sql`${table.country} ~ '^[A-Z]{2}$'`),
  ],
);

export type Exchange = typeof exchanges.$inferSelect;
