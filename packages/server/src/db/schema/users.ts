import { customType, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Case-insensitive text (requires the `citext` extension, created by migration 0000). */
export const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Login identifier, unique case-insensitively (citext). */
  username: citext('username').notNull().unique(),
  /** argon2id PHC string (includes salt and parameters). Never logged or returned. */
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Non-null = account disabled (cannot log in, sessions are rejected). */
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
});

export type User = typeof users.$inferSelect;
