import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { exchanges } from './exchanges';
import { instruments } from './instruments';

/**
 * A tradable line of an instrument on one exchange. `currency` is the provider's raw quote
 * currency, minor units included (`GBX`, `GBp`, `ZAc`); major-currency handling goes through
 * `normalizeCurrency` (@waddlers/domain), never by editing this column.
 */
export const listings = pgTable(
  'listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'restrict' }),
    exchangeMic: text('exchange_mic')
      .notNull()
      .references(() => exchanges.mic, { onDelete: 'restrict' }),
    symbol: text('symbol').notNull(),
    currency: text('currency').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('listings_exchange_symbol_unique').on(table.exchangeMic, table.symbol),
    // Target of the composite FK from space_positions: a position's listing must belong to its instrument.
    unique('listings_id_instrument_unique').on(table.id, table.instrumentId),
    index('listings_instrument_id_idx').on(table.instrumentId),
    // Raw provider code: 3 uppercase letters, or a known lower-case minor unit (kept in sync with
    // MINOR_UNITS in @waddlers/domain; a test asserts it). Mixed case otherwise is rejected.
    check(
      'listings_currency_format',
      sql`${table.currency} ~ '^[A-Z]{3}$' or ${table.currency} in ('GBp', 'ZAc')`,
    ),
    check('listings_symbol_not_blank', sql`length(btrim(${table.symbol})) > 0`),
  ],
);

export type Listing = typeof listings.$inferSelect;

/** Provider-specific symbol for a listing (e.g. EODHD `AI.PA`). Adapter-facing only. */
export const listingProviderIds = pgTable(
  'listing_provider_ids',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerSymbol: text('provider_symbol').notNull(),
  },
  (table) => [
    unique('listing_provider_ids_listing_provider_unique').on(table.listingId, table.provider),
    unique('listing_provider_ids_provider_symbol_unique').on(table.provider, table.providerSymbol),
    check(
      'listing_provider_ids_provider_format',
      sql`${table.provider} ~ '^[a-z][a-z0-9_]{1,31}$'`,
    ),
  ],
);

export type ListingProviderId = typeof listingProviderIds.$inferSelect;
