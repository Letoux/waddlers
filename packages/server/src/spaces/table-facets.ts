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
import { majorCurrencyOf } from './table-fx';

/**
 * Facets of the `in` filters (S7): distinct values with counts over ALL the positions of the
 * authorized space (search and filters are deliberately ignored, see `table-facets` in the
 * contracts). One grouped query per facet, in one read-only REPEATABLE READ transaction so the four
 * lists describe the same snapshot. PostgreSQL only, no provider, no cache (cheap, indexed by space).
 */

/** Appended to a currency label when minor-unit listings (GBX, GBp, ZAc) are grouped under it. */
const MINOR_LABEL_SUFFIX = ' (cotations en pence incluses)';

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
    .limit(FACET_VALUES_MAX + 1);
}

/**
 * D28: grouped by MAJOR currency (`GBP` covers GBX/GBp, `ZAR` covers ZAc), the exact value the
 * `currency` filter compares to; an invalid code (NULL major) is not a facet value. The label says
 * when minor-unit listings are included, so the choice is not a surprise next to the raw cell.
 */
async function currencyFacet(
  tx: Tx,
  space: AuthorizedSpace,
): Promise<{ value: string; label: string; count: number }[]> {
  const major = majorCurrencyOf(listings.currency);
  return tx
    .select({
      value: sql<string>`${major}`,
      label: sql<string>`case when bool_or(${listings.currency} <> ${major}) then ${major} || ${MINOR_LABEL_SUFFIX} else ${major} end`,
      count: sql<number>`count(*)::int`,
    })
    .from(spacePositions)
    .innerJoin(listings, eq(listings.id, spacePositions.listingId))
    .where(and(eq(spacePositions.spaceId, space.id), sql`${major} is not null`))
    .groupBy(sql`${major}`)
    .orderBy(desc(sql`count(*)`), asc(sql`${major}`))
    .limit(FACET_VALUES_MAX + 1);
}

type FacetRows = { value: string; label: string; count: number }[];

/** Keeps the first `FACET_VALUES_MAX` rows; the query asked for one more to know whether it was cut. */
function cap(rows: FacetRows): { values: FacetRows; truncated: boolean } {
  return { values: rows.slice(0, FACET_VALUES_MAX), truncated: rows.length > FACET_VALUES_MAX };
}

export async function getPositionFacets(
  db: Database,
  space: AuthorizedSpace,
): Promise<PositionsFacetsOutput> {
  return db.transaction(
    async (tx) => {
      const types = cap(await facet(tx, space, instruments.type));
      const sector = cap(await facet(tx, space, sectorExpr, sectorExpr, true));
      const currency = cap(await currencyFacet(tx, space));
      const exchange = cap(await facet(tx, space, exchanges.mic, exchanges.name));
      return {
        instrument_type: types.values.map((t) => ({
          ...t,
          label: INSTRUMENT_TYPE_LABELS[t.value as keyof typeof INSTRUMENT_TYPE_LABELS] ?? t.value,
        })),
        sector: sector.values,
        currency: currency.values,
        exchange: exchange.values,
        truncated: {
          instrument_type: types.truncated,
          sector: sector.truncated,
          currency: currency.truncated,
          exchange: exchange.truncated,
        },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
