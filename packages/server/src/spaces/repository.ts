import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbExecutor } from '../db/create';
import {
  exchanges,
  instruments,
  listings,
  spaceMembers,
  spacePositions,
  spaces,
  users,
  type InstrumentType,
  type SpaceRole,
} from '../db/schema';
import type { AuthorizedSpace } from './access';

/**
 * Space and position repositories. Per-space data (positions, space details) is only reachable
 * with an `AuthorizedSpace`; user-scoped listing is bounded by the membership join itself.
 */

export interface SpaceSummaryRow {
  id: string;
  name: string;
  referenceCurrency: string;
  role: SpaceRole;
  positionCount: number;
}

/**
 * Literal, fully qualified SQL on purpose: Drizzle renders `${spaces.id}` unqualified in a
 * single-table select, which would silently bind to the subquery's own `id` column.
 */
const positionCountSql = sql<number>`(
  select count(*)::int from space_positions sp where sp.space_id = spaces.id
)`;

/** Spaces the user is a member of (the join on membership is the access rule), by name. */
export async function listSpacesForUser(
  db: DbExecutor,
  userId: string,
): Promise<SpaceSummaryRow[]> {
  const rows = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      referenceCurrency: spaces.referenceCurrency,
      role: spaceMembers.role,
      positionCount: positionCountSql,
    })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(eq(spaceMembers.userId, userId))
    .orderBy(asc(sql`lower(${spaces.name})`), asc(spaces.id));
  return rows as SpaceSummaryRow[];
}

export async function getSpaceSummary(
  db: DbExecutor,
  space: AuthorizedSpace,
): Promise<Omit<SpaceSummaryRow, 'role'> | undefined> {
  const [row] = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      referenceCurrency: spaces.referenceCurrency,
      positionCount: positionCountSql,
    })
    .from(spaces)
    .where(eq(spaces.id, space.id))
    .limit(1);
  return row;
}

export async function getLastSpaceId(db: DbExecutor, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ lastSpaceId: users.lastSpaceId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.lastSpaceId ?? null;
}

/** `space.userId` is the user whose preference is stored (operator access has none). */
export async function setLastSpaceId(db: DbExecutor, space: AuthorizedSpace): Promise<void> {
  if (space.userId === null) throw new Error('setLastSpaceId requires a user-scoped space access');
  await db.update(users).set({ lastSpaceId: space.id }).where(eq(users.id, space.userId));
}

export interface PositionListRow {
  id: string;
  quantity: string | null;
  selectionReason: string | null;
  createdAt: Date;
  instrumentId: string;
  instrumentName: string;
  instrumentType: InstrumentType;
  isin: string | null;
  listingId: string;
  symbol: string;
  currency: string;
  exchangeMic: string;
  exchangeName: string;
}

export async function listPositions(
  db: DbExecutor,
  space: AuthorizedSpace,
  limit: number,
): Promise<PositionListRow[]> {
  return db
    .select({
      id: spacePositions.id,
      quantity: spacePositions.quantity,
      selectionReason: spacePositions.selectionReason,
      createdAt: spacePositions.createdAt,
      instrumentId: instruments.id,
      instrumentName: instruments.name,
      instrumentType: instruments.type,
      isin: instruments.isin,
      listingId: listings.id,
      symbol: listings.symbol,
      currency: listings.currency,
      exchangeMic: exchanges.mic,
      exchangeName: exchanges.name,
    })
    .from(spacePositions)
    .innerJoin(instruments, eq(instruments.id, spacePositions.instrumentId))
    .innerJoin(listings, eq(listings.id, spacePositions.listingId))
    .innerJoin(exchanges, eq(exchanges.mic, listings.exchangeMic))
    .where(eq(spacePositions.spaceId, space.id))
    .orderBy(asc(sql`lower(${instruments.name})`), asc(spacePositions.id))
    .limit(limit);
}

export async function countPositions(db: DbExecutor, space: AuthorizedSpace): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(spacePositions)
    .where(eq(spacePositions.spaceId, space.id));
  return row?.n ?? 0;
}

/** The position id is resolved inside the space: an id from another space updates nothing. */
export async function updatePositionQuantity(
  db: DbExecutor,
  space: AuthorizedSpace,
  positionId: string,
  quantity: string | null,
): Promise<{ id: string; quantity: string | null } | undefined> {
  const [row] = await db
    .update(spacePositions)
    .set({ quantity, updatedAt: sql`now()` })
    .where(and(eq(spacePositions.id, positionId), eq(spacePositions.spaceId, space.id)))
    .returning({ id: spacePositions.id, quantity: spacePositions.quantity });
  return row;
}

export async function deletePosition(
  db: DbExecutor,
  space: AuthorizedSpace,
  positionId: string,
): Promise<boolean> {
  const rows = await db
    .delete(spacePositions)
    .where(and(eq(spacePositions.id, positionId), eq(spacePositions.spaceId, space.id)))
    .returning({ id: spacePositions.id });
  return rows.length > 0;
}

/**
 * Adds a position with a listing chosen for this space. The composite FK guarantees the listing
 * belongs to the instrument. Returns `false` when the instrument is already tracked in the space.
 */
export async function insertPosition(
  db: DbExecutor,
  space: AuthorizedSpace,
  input: {
    instrumentId: string;
    listingId: string;
    quantity: string | null;
    selectionReason: string | null;
  },
): Promise<boolean> {
  const rows = await db
    .insert(spacePositions)
    .values({ spaceId: space.id, ...input })
    .onConflictDoNothing({ target: [spacePositions.spaceId, spacePositions.instrumentId] })
    .returning({ id: spacePositions.id });
  return rows.length > 0;
}

export async function findTrackedListing(
  db: DbExecutor,
  space: AuthorizedSpace,
  instrumentId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ listingId: spacePositions.listingId })
    .from(spacePositions)
    .where(and(eq(spacePositions.spaceId, space.id), eq(spacePositions.instrumentId, instrumentId)))
    .limit(1);
  return row?.listingId;
}
