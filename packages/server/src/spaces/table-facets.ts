import {
  FACET_VALUES_MAX,
  INSTRUMENT_TYPE_LABELS,
  type PositionsFacetsOutput,
} from '@waddlers/contracts';
import { and, asc, desc, eq, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Database } from '../db/create';
import { exchanges, instruments, listings, spacePositions } from '../db/schema';
import type { AuthorizedSpace } from './access';
import { sectorExpr } from './table-columns';

/**
 * Facets of the `in` filters (S7): distinct values with counts over ALL the positions of the
 * authorized space (search and filters are deliberately ignored, see `table-facets` in the
 * contracts). One grouped query per facet, in one read-only REPEATABLE READ transaction so the four
 * lists describe the same snapshot. PostgreSQL only, no provider, no cache (cheap, indexed by space).
 */

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Groups by `value` (and `label` when it is another column): no bound parameter in GROUP BY. */
async function facet(
  tx: Tx,
  space: AuthorizedSpace,
  value: SQL | AnyColumn,
  label: SQL | AnyColumn = value,
  notNull = false,
): Promise<{ value: string; label: string; count: number }[]> {
  const groupKeys = label === value ? [value] : [value, label];
  return tx
    .select({
      value: sql<string>`${value}`,
      label: sql<string>`${label}`,
      count: sql<number>`count(*)::int`,
    })
    .from(spacePositions)
    .innerJoin(instruments, eq(instruments.id, spacePositions.instrumentId))
    .innerJoin(listings, eq(listings.id, spacePositions.listingId))
    .innerJoin(exchanges, eq(exchanges.mic, listings.exchangeMic))
    .where(
      and(eq(spacePositions.spaceId, space.id), notNull ? sql`${value} is not null` : undefined),
    )
    .groupBy(...groupKeys.map((k) => sql`${k}`))
    .orderBy(desc(sql`count(*)`), asc(sql`${value}`))
    .limit(FACET_VALUES_MAX);
}

export async function getPositionFacets(
  db: Database,
  space: AuthorizedSpace,
): Promise<PositionsFacetsOutput> {
  return db.transaction(
    async (tx) => {
      const types = await facet(tx, space, instruments.type);
      return {
        instrument_type: types.map((t) => ({
          ...t,
          label: INSTRUMENT_TYPE_LABELS[t.value as keyof typeof INSTRUMENT_TYPE_LABELS] ?? t.value,
        })),
        sector: await facet(tx, space, sectorExpr, sectorExpr, true),
        currency: await facet(tx, space, listings.currency),
        exchange: await facet(tx, space, exchanges.mic, exchanges.name),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
