import { ORPCError } from '@orpc/server';
import { SPACE_ROLES, spaceIdInputSchema, type SpaceRole } from '@waddlers/contracts';
import { and, eq } from 'drizzle-orm';
import type { DbExecutor } from '../db/create';
import { spaceMembers } from '../db/schema';

/**
 * Space authorization core (S3). The ONLY way to obtain an `AuthorizedSpace` for a request is
 * `requireSpaceAccess`; every repository that reads or writes per-space data takes one, so
 * "forgot the access check" is a compile error, not a review finding.
 *
 * Rules:
 * - a space the caller cannot access and a space that does not exist are indistinguishable:
 *   both `NOT_FOUND` (never FORBIDDEN, which would confirm existence);
 * - an accessible space with an insufficient role is `FORBIDDEN`;
 * - ids of child rows (positions) are always resolved *within* the authorized space.
 */

declare const authorized: unique symbol;

export interface AuthorizedSpace {
  /** Not constructible outside this module without a cast (which lint/review must reject). */
  readonly [authorized]: true;
  readonly id: string;
  /** The effective role that passed the check (`owner` for admin access). */
  readonly role: SpaceRole;
  /** The requesting user; `null` for operator (admin CLI / seed) access. */
  readonly userId: string | null;
}

const ROLE_RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, owner: 2 };

export function roleAtLeast(role: SpaceRole, minRole: SpaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

function isSpaceRole(value: string): value is SpaceRole {
  return (SPACE_ROLES as readonly string[]).includes(value);
}

const notFound = () => new ORPCError('NOT_FOUND', { message: 'Not found' });
const forbidden = () => new ORPCError('FORBIDDEN', { message: 'Forbidden' });

const UUID = spaceIdInputSchema.shape.spaceId;

export interface SpaceAccessContext {
  db: DbExecutor;
  userId: string;
}

/**
 * Resolves the caller's membership of `spaceId`. A malformed id is `NOT_FOUND` too (it cannot
 * name a space, and the database must never see it).
 */
export async function requireSpaceAccess(
  ctx: SpaceAccessContext,
  spaceId: unknown,
  minRole: SpaceRole,
): Promise<AuthorizedSpace> {
  const id = UUID.safeParse(spaceId);
  if (!id.success) throw notFound();
  const [member] = await ctx.db
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, id.data), eq(spaceMembers.userId, ctx.userId)))
    .limit(1);
  if (!member || !isSpaceRole(member.role)) throw notFound();
  if (!roleAtLeast(member.role, minRole)) throw forbidden();
  // Canonical lower-case id: what is minted matches what is stored, whatever case the client sent.
  return mint(id.data.toLowerCase(), member.role, ctx.userId);
}

function mint(id: string, role: SpaceRole, userId: string | null): AuthorizedSpace {
  return { id, role, userId } as AuthorizedSpace;
}

/**
 * Operator access for the admin CLI and the dev seed, which act as the database owner of the
 * deployment, not as a user. `spaceId` must come from a lookup by an operator-supplied name.
 * Never call this from a request path (web/oRPC): there is no user to check.
 */
export function operatorSpaceAccess(spaceId: string): AuthorizedSpace {
  return mint(spaceId, 'owner', null);
}
