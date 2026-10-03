import { ORPCError } from '@orpc/server';
import {
  TABLE_CONFIG_VERSION,
  defaultTableConfig,
  type TableConfigOutput,
  type TableConfigV1,
} from '@waddlers/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { DbExecutor } from '../db/create';
import { pgErrorCode } from '../db/errors';
import { tableConfigs } from '../db/schema';
import type { AuthorizedSpace } from './access';
import {
  isNewerTableConfigVersion,
  migrateTableConfig,
  withMajorCurrencyFilters,
} from './table-config-migrate';

/**
 * The caller's own table view of a space (S7, D27). The row key is `(space.userId, space.id)`:
 * the user comes from the authorized session (`AuthorizedSpace.userId`), never from input, so
 * there is no way to name another user's row. Operator access (no user) has no view.
 */

/** The stored view was written by a NEWER app version: `save` refuses to overwrite it (router: typed CONFLICT). */
export class TableConfigNewerVersionError extends Error {
  constructor() {
    super('table config written by a newer version');
    this.name = 'TableConfigNewerVersionError';
  }
}

function userOf(space: AuthorizedSpace): string {
  if (space.userId === null) throw new Error('table config requires a user-scoped space access');
  return space.userId;
}

export async function getTableConfig(
  db: DbExecutor,
  space: AuthorizedSpace,
): Promise<TableConfigOutput> {
  const [row] = await db
    .select({ config: tableConfigs.config, version: tableConfigs.version })
    .from(tableConfigs)
    .where(and(eq(tableConfigs.userId, userOf(space)), eq(tableConfigs.spaceId, space.id)))
    .limit(1);
  if (!row) return { config: defaultTableConfig(), isDefault: true };
  return { config: migrateTableConfig(row.config, row.version), isDefault: false };
}

/**
 * Upsert, LAST WRITE WINS (two tabs saving at once: the later statement overwrites, the stored row
 * is always exactly one of the inputs, never a merge). Returns ITS OWN write (`returning`, then
 * migrated), not a re-read, so a response never shows another request's config. Safe to repeat:
 * saving a document identical to the stored one does not write (no new tuple, `updated_at` kept);
 * a stored version NEWER than this app's is never overwritten (CONFLICT, so a rollback cannot
 * destroy a newer view). SQLSTATE 22P02/22P05 (text PostgreSQL cannot hold) is a BAD_REQUEST: the
 * schema already refuses NUL and lone surrogates, this is defence in depth.
 */
export async function saveTableConfig(
  db: DbExecutor,
  space: AuthorizedSpace,
  input: TableConfigV1,
): Promise<TableConfigOutput> {
  const userId = userOf(space);
  const config = withMajorCurrencyFilters(input); // D28: GBX is stored (and answered) as GBP
  try {
    const [written] = await db
      .insert(tableConfigs)
      .values({ userId, spaceId: space.id, version: TABLE_CONFIG_VERSION, config })
      .onConflictDoUpdate({
        target: [tableConfigs.userId, tableConfigs.spaceId],
        set: { version: TABLE_CONFIG_VERSION, config, updatedAt: new Date() },
        // Skip a no-op write (identical document) and never downgrade a newer version.
        setWhere: sql`${tableConfigs.version} < ${TABLE_CONFIG_VERSION} or (${tableConfigs.version} = ${TABLE_CONFIG_VERSION} and ${tableConfigs.config} is distinct from excluded.config)`,
      })
      .returning({ config: tableConfigs.config, version: tableConfigs.version });
    if (written)
      return { config: migrateTableConfig(written.config, written.version), isDefault: false };
    // Nothing written: the stored document is identical (fine, it is what we would have written), or newer.
    const [stored] = await db
      .select({ version: tableConfigs.version })
      .from(tableConfigs)
      .where(and(eq(tableConfigs.userId, userId), eq(tableConfigs.spaceId, space.id)))
      .limit(1);
    if (stored && isNewerTableConfigVersion(stored.version))
      throw new TableConfigNewerVersionError();
    return { config: migrateTableConfig(config), isDefault: false };
  } catch (error) {
    if (error instanceof TableConfigNewerVersionError) throw error;
    const code = pgErrorCode(error);
    // The membership was revoked between the access check and the write (FK 23503): the space is gone for this user.
    if (code === '23503') throw new ORPCError('NOT_FOUND', { message: 'Not found' });
    if (code === '22P02' || code === '22P05')
      throw new ORPCError('BAD_REQUEST', { message: 'Invalid input' });
    throw error;
  }
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
