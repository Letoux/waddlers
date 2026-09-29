import { pgTable, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { citext } from './citext';
import { spaces } from './spaces';

export { citext };

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
  /** Last space the user selected (active-space UX). Advisory: access is always re-checked. */
  lastSpaceId: uuid('last_space_id').references((): AnyPgColumn => spaces.id, {
    onDelete: 'set null',
  }),
});

export type User = typeof users.$inferSelect;
