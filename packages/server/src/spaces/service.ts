import { ORPCError } from '@orpc/server';
import {
  POSITIONS_LIST_MAX,
  type PositionRow,
  type PositionsListOutput,
  type SpaceSummary,
  type SpacesListOutput,
} from '@waddlers/contracts';
import { normalizeCurrency } from '@waddlers/domain';
import type { Database, DbExecutor } from '../db/create';
import type { AuthorizedSpace } from './access';
import {
  countPositions,
  deletePosition,
  getLastSpaceId,
  getSpaceSummary,
  listPositions,
  listSpacesForUser,
  setLastSpaceId,
  updatePositionQuantity,
  type PositionListRow,
} from './repository';

/**
 * Canonical decimal string of a `numeric(24,8)` value: PostgreSQL pads the scale
 * (`12.50000000`); the API returns `12.5`. Pure string work, no float, no exponent.
 */
export function canonicalQuantity(value: string | null): string | null {
  if (value === null) return null;
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}

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

export function toPositionRow(row: PositionListRow): PositionRow {
  const normalized = normalizeCurrency(row.currency);
  return {
    id: row.id,
    quantity: canonicalQuantity(row.quantity),
    selectionReason: row.selectionReason,
    addedAt: row.createdAt.toISOString(),
    instrument: {
      id: row.instrumentId,
      name: row.instrumentName,
      type: row.instrumentType,
      isin: row.isin,
    },
    listing: {
      id: row.listingId,
      symbol: row.symbol,
      exchange: { mic: row.exchangeMic, name: row.exchangeName },
      currency: row.currency,
      currencyMajor: normalized?.currency ?? null,
      minorUnitDivisor: normalized ? normalized.divisor.toNumber() : null,
    },
  };
}

/**
 * One page of positions. Rows and total are read in a single read-only REPEATABLE READ
 * transaction so they describe the same snapshot (a concurrent add/remove cannot make `total`
 * and `hasMore` disagree with `rows`).
 */
export async function listSpacePositions(
  db: Database,
  space: AuthorizedSpace,
  page?: { offset?: number; limit?: number },
): Promise<PositionsListOutput> {
  const offset = page?.offset ?? 0;
  const limit = page?.limit ?? POSITIONS_LIST_MAX;
  const { rows, total } = await db.transaction(
    async (tx) => ({
      rows: await listPositions(tx, space, { offset, limit }),
      total: await countPositions(tx, space),
    }),
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  return { rows: rows.map(toPositionRow), total, hasMore: offset + rows.length < total };
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
