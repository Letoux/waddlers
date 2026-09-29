import { quantitySchema, spaceRoleSchema, type SpaceRole } from '@waddlers/contracts';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { findUserByUsername } from '../auth/users';
import type { Database } from '../db/create';
import { listings, spaceMembers, spaces } from '../db/schema';
import { operatorSpaceAccess } from '../spaces/access';
import { findTrackedListing, insertPosition } from '../spaces/repository';
import { AdminError } from './errors';

/**
 * Operator-side space management (admin CLI). Spaces are created and shared by the admin only
 * (specs 7, decision D17); there is no user-facing create/rename/delete.
 */

const spaceNameSchema = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(64, 'at most 64 characters')
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'control characters are not allowed');

function parseSpaceName(raw: string): string {
  const result = spaceNameSchema.safeParse(raw);
  if (!result.success) {
    throw new AdminError(`Invalid space name: ${result.error.issues[0]?.message ?? 'invalid'}`);
  }
  return result.data;
}

async function findSpaceIdByName(db: Database, rawName: string): Promise<string> {
  const name = parseSpaceName(rawName);
  const [row] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.name, name))
    .limit(1);
  if (!row) throw new AdminError('Space not found');
  return row.id;
}

/** Reference currency is EUR in the MVP (D7). */
export async function createSpace(
  db: Database,
  input: { name: string },
): Promise<{ id: string; name: string }> {
  const name = parseSpaceName(input.name);
  const [created] = await db
    .insert(spaces)
    .values({ name })
    .onConflictDoNothing({ target: spaces.name })
    .returning({ id: spaces.id, name: spaces.name });
  if (!created) throw new AdminError('Space already exists');
  return created;
}

export async function renameSpace(
  db: Database,
  input: { space: string; newName: string },
): Promise<void> {
  const id = await findSpaceIdByName(db, input.space);
  const name = parseSpaceName(input.newName);
  const [clash] = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.name, name));
  if (clash && clash.id !== id) throw new AdminError('A space with that name already exists');
  await db
    .update(spaces)
    .set({ name, updatedAt: sql`now()` })
    .where(eq(spaces.id, id));
}

/** Idempotent upsert: granting again changes the role. */
export async function grantSpace(
  db: Database,
  input: { space: string; username: string; role: string },
): Promise<{ created: boolean; role: SpaceRole }> {
  const role = spaceRoleSchema.safeParse(input.role);
  if (!role.success) throw new AdminError('Invalid role (owner, editor or viewer)');
  const spaceId = await findSpaceIdByName(db, input.space);
  const user = await findUserByUsername(db, input.username);
  if (!user) throw new AdminError('User not found');
  const [existing] = await db
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .where(sql`${spaceMembers.spaceId} = ${spaceId} and ${spaceMembers.userId} = ${user.id}`);
  await db
    .insert(spaceMembers)
    .values({ spaceId, userId: user.id, role: role.data })
    .onConflictDoUpdate({
      target: [spaceMembers.spaceId, spaceMembers.userId],
      set: { role: role.data },
    });
  return { created: !existing, role: role.data };
}

/** Idempotent: revoking a non-member is a no-op (`removed: false`). */
export async function revokeSpace(
  db: Database,
  input: { space: string; username: string },
): Promise<{ removed: boolean }> {
  const spaceId = await findSpaceIdByName(db, input.space);
  const user = await findUserByUsername(db, input.username);
  if (!user) throw new AdminError('User not found');
  const rows = await db
    .delete(spaceMembers)
    .where(sql`${spaceMembers.spaceId} = ${spaceId} and ${spaceMembers.userId} = ${user.id}`)
    .returning({ userId: spaceMembers.userId });
  return { removed: rows.length > 0 };
}

export interface AdminSpaceRow {
  id: string;
  name: string;
  members: number;
  positions: number;
}

export async function listAllSpaces(db: Database): Promise<AdminSpaceRow[]> {
  return db
    .select({
      id: spaces.id,
      name: spaces.name,
      members: sql<number>`(select count(*)::int from space_members sm where sm.space_id = spaces.id)`,
      positions: sql<number>`(select count(*)::int from space_positions sp where sp.space_id = spaces.id)`,
    })
    .from(spaces)
    .orderBy(asc(sql`lower(${spaces.name})`));
}

/** `AI.XPAR` -> symbol `AI`, MIC `XPAR`. Split at the LAST dot: symbols may contain dots (`BRK.B`). */
export function parseListingRef(raw: string): { symbol: string; mic: string } {
  const dot = raw.lastIndexOf('.');
  const symbol = dot > 0 ? raw.slice(0, dot) : '';
  const mic = dot > 0 ? raw.slice(dot + 1).toUpperCase() : '';
  if (!symbol || !/^[A-Z0-9]{4}$/.test(mic)) {
    throw new AdminError('Invalid listing: expected <symbol>.<exchangeMIC>, e.g. AI.XPAR');
  }
  return { symbol, mic };
}

/**
 * Adds a position to a space for an existing listing (`<symbol>.<MIC>`), with an optional decimal
 * quantity (absent = watchlist entry, never 0). The user-facing add form comes after the S4
 * search (D11). Not repeatable: an already tracked instrument is an error, nothing is changed.
 */
export async function addPosition(
  db: Database,
  input: { space: string; listing: string; quantity?: string; selectionReason?: string },
): Promise<{ instrumentId: string }> {
  const { symbol, mic } = parseListingRef(input.listing);
  let quantity: string | null = null;
  if (input.quantity !== undefined) {
    const parsed = quantitySchema.safeParse(input.quantity);
    if (!parsed.success) {
      throw new AdminError(
        'Invalid quantity: non-negative decimal, at most 16 integer and 8 fraction digits',
      );
    }
    quantity = parsed.data;
  }
  const spaceId = await findSpaceIdByName(db, input.space);
  const [listing] = await db
    .select({ id: listings.id, instrumentId: listings.instrumentId })
    .from(listings)
    .where(sql`${listings.exchangeMic} = ${mic} and ${listings.symbol} = ${symbol}`)
    .limit(1);
  if (!listing) throw new AdminError('Unknown listing (reference data is not loaded for it)');
  const space = operatorSpaceAccess(spaceId);
  const inserted = await insertPosition(db, space, {
    instrumentId: listing.instrumentId,
    listingId: listing.id,
    quantity,
    selectionReason: input.selectionReason ?? null,
  });
  if (!inserted) {
    const tracked = await findTrackedListing(db, space, listing.instrumentId);
    throw new AdminError(
      tracked === listing.id
        ? 'Position already exists in this space'
        : 'This instrument is already tracked in this space with another listing',
    );
  }
  return { instrumentId: listing.instrumentId };
}
