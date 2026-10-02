import { ORPCError } from '@orpc/server';
import {
  TABLE_CONFIG_VERSION,
  defaultTableConfig,
  type TableConfigOutput,
  type TableConfigV1,
} from '@waddlers/contracts';
import { and, eq } from 'drizzle-orm';
import type { DbExecutor } from '../db/create';
import { pgErrorCode } from '../db/errors';
import { tableConfigs } from '../db/schema';
import type { AuthorizedSpace } from './access';
import { migrateTableConfig } from './table-config-migrate';

/**
 * The caller's own table view of a space (S7, D27). The row key is `(space.userId, space.id)`:
 * the user comes from the authorized session (`AuthorizedSpace.userId`), never from input, so
 * there is no way to name another user's row. Operator access (no user) has no view.
 */

function userOf(space: AuthorizedSpace): string {
  if (space.userId === null) throw new Error('table config requires a user-scoped space access');
  return space.userId;
}

export async function getTableConfig(
  db: DbExecutor,
  space: AuthorizedSpace,
): Promise<TableConfigOutput> {
  const [row] = await db
    .select({ config: tableConfigs.config })
    .from(tableConfigs)
    .where(and(eq(tableConfigs.userId, userOf(space)), eq(tableConfigs.spaceId, space.id)))
    .limit(1);
  if (!row) return { config: defaultTableConfig(), isDefault: true };
  return { config: migrateTableConfig(row.config), isDefault: false };
}

/** Idempotent upsert (saving the same config twice is a no-op in effect). */
export async function saveTableConfig(
  db: DbExecutor,
  space: AuthorizedSpace,
  config: TableConfigV1,
): Promise<TableConfigOutput> {
  const userId = userOf(space);
  try {
    await db
      .insert(tableConfigs)
      .values({ userId, spaceId: space.id, version: TABLE_CONFIG_VERSION, config })
      .onConflictDoUpdate({
        target: [tableConfigs.userId, tableConfigs.spaceId],
        set: { version: TABLE_CONFIG_VERSION, config, updatedAt: new Date() },
      });
  } catch (error) {
    // The membership was revoked between the access check and the write (FK 23503): the space is gone for this user.
    if (pgErrorCode(error) === '23503') throw new ORPCError('NOT_FOUND', { message: 'Not found' });
    throw error;
  }
  return getTableConfig(db, space);
}

/** Deletes the caller's row (idempotent) and returns the defaults. */
export async function resetTableConfig(
  db: DbExecutor,
  space: AuthorizedSpace,
): Promise<TableConfigOutput> {
  await db
    .delete(tableConfigs)
    .where(and(eq(tableConfigs.userId, userOf(space)), eq(tableConfigs.spaceId, space.id)));
  return { config: defaultTableConfig(), isDefault: true };
}
