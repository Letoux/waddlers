import { SPACE_WRITER_ROLES } from '@waddlers/contracts';
import { and, asc, count, eq, exists, inArray, sql } from 'drizzle-orm';
import type { DbExecutor } from '../db/create';
import { spaceMembers, spacePositions, spaces, users, type SpaceRole } from '../db/schema';
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

/** Spaces the user is a member of (the join on membership is the access rule), by name. */
export async function listSpacesForUser(
  db: DbExecutor,
  userId: string,
): Promise<SpaceSummaryRow[]> {
  const memberSpaceIds = db
    .select({ id: spaceMembers.spaceId })
    .from(spaceMembers)
    .where(eq(spaceMembers.userId, userId));
  const counts = db
    .select({ spaceId: spacePositions.spaceId, n: count().as('n') })
    .from(spacePositions)
    .where(inArray(spacePositions.spaceId, memberSpaceIds))
    .groupBy(spacePositions.spaceId)
    .as('position_counts');
  return db
    .select({
      id: spaces.id,
      name: spaces.name,
      referenceCurrency: spaces.referenceCurrency,
      role: spaceMembers.role,
      positionCount: sql<number>`coalesce(${counts.n}, 0)`.mapWith(Number),
    })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .leftJoin(counts, eq(counts.spaceId, spaces.id))
    .where(eq(spaceMembers.userId, userId))
    .orderBy(asc(sql`lower(${spaces.name})`), asc(spaces.id));
}

export async function getSpaceSummary(
  db: DbExecutor,
  space: AuthorizedSpace,
): Promise<Omit<SpaceSummaryRow, 'role'> | undefined> {
  const counts = db
    .select({ spaceId: spacePositions.spaceId, n: count().as('n') })
    .from(spacePositions)
    .where(eq(spacePositions.spaceId, space.id))
    .groupBy(spacePositions.spaceId)
    .as('position_counts');
  const [row] = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      referenceCurrency: spaces.referenceCurrency,
      positionCount: sql<number>`coalesce(${counts.n}, 0)`.mapWith(Number),
    })
    .from(spaces)
    .leftJoin(counts, eq(counts.spaceId, spaces.id))
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

/**
 * Re-checks the writer role inside the write itself, so a membership revoked or downgraded between
 * `requireSpaceAccess` and the statement cannot be written through (no check-then-act window).
 * Operator access (no user) has nothing to re-check.
 */
function writerGuard(space: AuthorizedSpace) {
  const userId = space.userId;
  if (userId === null) return undefined;
  return exists(
    sql`(select 1 from ${spaceMembers} where ${spaceMembers.spaceId} = ${space.id}
      and ${spaceMembers.userId} = ${userId}
      and ${inArray(spaceMembers.role, [...SPACE_WRITER_ROLES])})`,
  );
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
    .where(
      and(
        eq(spacePositions.id, positionId),
        eq(spacePositions.spaceId, space.id),
        writerGuard(space),
      ),
    )
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
    .where(
      and(
        eq(spacePositions.id, positionId),
        eq(spacePositions.spaceId, space.id),
        writerGuard(space),
      ),
    )
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
