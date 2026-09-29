import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { instruments } from './instruments';
import { listings } from './listings';
import { citext } from './citext';
import { users } from './users';

import {
  QUANTITY_MAX_FRACTION_DIGITS,
  QUANTITY_MAX_INTEGER_DIGITS,
  SPACE_ROLES,
  type SpaceRole,
} from '@waddlers/contracts';

export { SPACE_ROLES, type SpaceRole };

/** numeric(24, 8): the API schema (`quantitySchema`) is derived from the same digit counts. */
export const QUANTITY_SCALE = QUANTITY_MAX_FRACTION_DIGITS;
export const QUANTITY_PRECISION = QUANTITY_MAX_INTEGER_DIGITS + QUANTITY_MAX_FRACTION_DIGITS;

/** Spaces are created by the admin only (specs 7). Names are unique so the admin CLI can address them. */
export const spaces = pgTable(
  'spaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: citext('name').notNull().unique(),
    /** EUR only in the MVP (D7); the column stays for later. */
    referenceCurrency: text('reference_currency').notNull().default('EUR'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('spaces_reference_currency_format', sql`${table.referenceCurrency} ~ '^[A-Z]{3}$'`),
  ],
);

export const spaceMembers = pgTable(
  'space_members',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<SpaceRole>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.userId] }),
    // Space list for a user; the primary key covers lookups by (space, user).
    index('space_members_user_id_idx').on(table.userId),
    check('space_members_role_check', sql`${table.role} in ('owner', 'editor', 'viewer')`),
  ],
);

export const spacePositions = pgTable(
  'space_positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    instrumentId: uuid('instrument_id').notNull(),
    /** Listing chosen for this space (D8). Must belong to `instrumentId` (composite FK). */
    listingId: uuid('listing_id').notNull(),
    /** Why this listing was retained (specs 35). Null = not recorded; never invented. */
    selectionReason: text('selection_reason'),
    /** Null = watchlist entry (D9); never coerced to 0. Decimal string in JS. */
    quantity: numeric('quantity', { precision: QUANTITY_PRECISION, scale: QUANTITY_SCALE }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('space_positions_space_instrument_unique').on(table.spaceId, table.instrumentId),
    index('space_positions_listing_id_idx').on(table.listingId),
    index('space_positions_instrument_id_idx').on(table.instrumentId),
    foreignKey({
      name: 'space_positions_listing_instrument_fk',
      columns: [table.listingId, table.instrumentId],
      foreignColumns: [listings.id, listings.instrumentId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'space_positions_instrument_id_fk',
      columns: [table.instrumentId],
      foreignColumns: [instruments.id],
    }).onDelete('restrict'),
    // `<> 'NaN'` matters: PostgreSQL orders NaN above every number, so `>= 0` alone accepts it.
    check(
      'space_positions_quantity_valid',
      sql`${table.quantity} is null or (${table.quantity} >= 0 and ${table.quantity} <> 'NaN')`,
    ),
  ],
);

export type Space = typeof spaces.$inferSelect;
export type SpacePosition = typeof spacePositions.$inferSelect;
