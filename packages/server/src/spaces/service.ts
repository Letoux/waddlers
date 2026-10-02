import { ORPCError } from '@orpc/server';
import {
  DEFAULT_TABLE_COLUMNS,
  POSITIONS_LIST_MAX,
  type DashboardPeriod,
  type PositionsListOutput,
  type TablePositionRow as TablePositionRowOut,
  type TableColumnId,
  type TableSort,
  type SpaceSummary,
  type SpacesListOutput,
} from '@waddlers/contracts';
import { normalizeCurrency } from '@waddlers/domain';
import type { Database, DbExecutor } from '../db/create';
import type { AuthorizedSpace } from './access';
import { canonicalQuantity } from './quantity';
import {
  deletePosition,
  getLastSpaceId,
  getSpaceSummary,
  listSpacesForUser,
  setLastSpaceId,
  updatePositionQuantity,
} from './repository';
import { buildValues } from './table-cells';
import { queryTablePage, queryTableTotals, type TablePositionRow } from './table-query';
import { utcToday } from '../dashboard/compute';

export { canonicalQuantity };

export async function listSpaces(db: DbExecutor, userId: string): Promise<SpacesListOutput> {
  const rows = await listSpacesForUser(db, userId);
  const last = await getLastSpaceId(db, userId);
  // Advisory preference: honoured only while the space is still accessible, else first by name.
  const active = rows.find((s) => s.id === last) ?? rows[0];
  return { spaces: rows, activeSpaceId: active?.id ?? null };
}

export async function getSpace(db: DbExecutor, space: AuthorizedSpace): Promise<SpaceSummary> {
  const summary = await getSpaceSummary(db, space);
  if (!summary) throw new ORPCError('NOT_FOUND', { message: 'Not found' });
  return { ...summary, role: space.role };
}

export async function setActiveSpace(
  db: DbExecutor,
  space: AuthorizedSpace,
): Promise<{ activeSpaceId: string }> {
  await setLastSpaceId(db, space);
  return { activeSpaceId: space.id };
}

function toTableRow(
  row: TablePositionRow,
  columns: readonly TableColumnId[],
  period: DashboardPeriod,
  today: string,
): TablePositionRowOut {
  const d = row.data;
  const normalized = normalizeCurrency(d.currency);
  return {
    id: row.id,
    quantity: canonicalQuantity(d.quantity),
    selectionReason: d.selectionReason,
    addedAt: row.createdAt.toISOString(),
    instrument: {
      id: row.instrumentId,
      name: d.instrumentName,
      type: d.instrumentType,
      isin: row.isin,
    },
    listing: {
      id: row.listingId,
      symbol: d.symbol,
      exchange: { mic: row.exchangeMic, name: d.exchangeName },
      currency: d.currency,
      currencyMajor: normalized?.currency ?? null,
      minorUnitDivisor: normalized ? normalized.divisor.toNumber() : null,
    },
    values: buildValues(d, columns, period, today),
    descriptionTruncated: row.descriptionTruncated,
  };
}

export interface PositionsTableParams {
  page?: { offset?: number; limit?: number } | undefined;
  period?: DashboardPeriod | undefined;
  search?: string | undefined;
  sort?: TableSort | undefined;
  columns?: readonly TableColumnId[] | undefined;
}

export const DEFAULT_LIST_PERIOD: DashboardPeriod = '1m';

/**
 * One page of the table. Rows and totals are read in a single read-only REPEATABLE READ
 * transaction so they describe the same snapshot (a concurrent add/remove cannot make `total`
 * and `hasMore` disagree with `rows`). PostgreSQL only: no provider, no cache. The cell mapping
 * runs after the transaction committed.
 */
export async function listSpacePositions(
  db: Database,
  space: AuthorizedSpace,
  params: PositionsTableParams = {},
  now: () => Date = () => new Date(),
): Promise<PositionsListOutput> {
  const offset = params.page?.offset ?? 0;
  const limit = params.page?.limit ?? POSITIONS_LIST_MAX;
  const period = params.period ?? DEFAULT_LIST_PERIOD;
  const columns = params.columns ?? DEFAULT_TABLE_COLUMNS;
  const search = params.search?.trim() || undefined;
  const { rows, totals } = await db.transaction(
    async (tx) => ({
      rows: await queryTablePage(tx, space, {
        offset,
        limit,
        search,
        sort: params.sort,
        period,
        withDescription: columns.includes('description'),
      }),
      totals: await queryTableTotals(tx, space, search),
    }),
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  const today = utcToday(now());
  return {
    rows: rows.map((r) => toTableRow(r, columns, period, today)),
    total: totals.total,
    hasMore: offset + rows.length < totals.total,
    period,
    computedAt: totals.computedAt?.toISOString() ?? null,
    oldestComputedAt: totals.oldestComputedAt?.toISOString() ?? null,
  };
}

export async function setPositionQuantity(
  db: DbExecutor,
  space: AuthorizedSpace,
  positionId: string,
  quantity: string | null,
): Promise<{ positionId: string; quantity: string | null }> {
  const row = await updatePositionQuantity(db, space, positionId, quantity);
  if (!row) throw new ORPCError('NOT_FOUND', { message: 'Not found' });
  return { positionId: row.id, quantity: canonicalQuantity(row.quantity) };
}

export async function removeSpacePosition(
  db: DbExecutor,
  space: AuthorizedSpace,
  positionId: string,
): Promise<{ ok: true }> {
  if (!(await deletePosition(db, space, positionId))) {
    throw new ORPCError('NOT_FOUND', { message: 'Not found' });
  }
  return { ok: true };
}
