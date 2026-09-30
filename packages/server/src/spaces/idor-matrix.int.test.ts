import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, disableUser } from '../admin';
import { getDb } from '../db/client';
import { spacePositions, spaces } from '../db/schema';
import {
  createApp,
  PASSWORD,
  releaseTestEnv,
  resetAuthTables,
  useTestEnv,
} from '../../test/auth-harness';
import { allContractPaths, CLASSIFICATION } from '../../test/procedure-classification';
import { createPositionRow, createSpaceRow, ensureReferenceData } from '../../test/space-fixtures';

/**
 * IDOR matrix: EVERY space-scoped procedure x every kind of caller. Data-driven. The last
 * describe enumerates the contract and fails when a procedure taking `spaceId` is missing here.
 */

type Outcome = 'ok' | 'NOT_FOUND' | 'FORBIDDEN' | 'UNAUTHORIZED';
type Actor =
  | 'anonymous'
  | 'disabledUser'
  | 'nonMember'
  | 'memberOfAnotherSpace'
  | 'viewer'
  | 'editor'
  | 'owner';

interface Fixture {
  spaceA: string;
  spaceB: string;
  /** Positions of space A (owner is the caller in the ok cases). */
  posA: string;
  /** A position that belongs to space B only. */
  posB: string;
  missingSpace: string;
}

interface ProcedureSpec {
  path: string;
  minRole: 'viewer' | 'editor';
  takesPosition: boolean;
  input: (spaceId: string, positionId: string) => Record<string, unknown>;
}

const PROCEDURES: ProcedureSpec[] = [
  {
    path: 'spaces.get',
    minRole: 'viewer',
    takesPosition: false,
    input: (spaceId) => ({ spaceId }),
  },
  {
    path: 'spaces.setActive',
    minRole: 'viewer',
    takesPosition: false,
    input: (spaceId) => ({ spaceId }),
  },
  {
    path: 'positions.list',
    minRole: 'viewer',
    takesPosition: false,
    input: (spaceId) => ({ spaceId }),
  },
  {
    path: 'positions.setQuantity',
    minRole: 'editor',
    takesPosition: true,
    input: (spaceId, positionId) => ({ spaceId, positionId, quantity: '99.5' }),
  },
  {
    path: 'positions.remove',
    minRole: 'editor',
    takesPosition: true,
    input: (spaceId, positionId) => ({ spaceId, positionId }),
  },
];

const ROLE_RANK = { viewer: 0, editor: 1, owner: 2 } as const;

/** Expected outcome for a caller with a proper request on their own accessible space A. */
function expectedOnSpaceA(actor: Actor, spec: ProcedureSpec): Outcome {
  switch (actor) {
    case 'anonymous':
    case 'disabledUser':
      return 'UNAUTHORIZED';
    case 'nonMember':
    case 'memberOfAnotherSpace':
      return 'NOT_FOUND';
    case 'viewer':
    case 'editor':
    case 'owner':
      return ROLE_RANK[actor] >= ROLE_RANK[spec.minRole] ? 'ok' : 'FORBIDDEN';
  }
}

const STATUS: Record<Exclude<Outcome, 'ok'>, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
};

const { rpc, loginAs } = createApp();
const cookies = {} as Record<Actor, string | undefined>;
let fx: Fixture;

beforeAll(async () => {
  useTestEnv();
  await resetAuthTables();
  const db = getDb();
  const ids: Record<string, string> = {};
  for (const name of ['nonmember', 'other', 'viewer', 'editor', 'owner', 'disabled']) {
    ids[name] = (await createUser(db, { username: name, password: PASSWORD })).id;
  }
  // Space memberships are created per test (below); logins happen once.
  cookies.anonymous = undefined;
  cookies.nonMember = await loginAs('nonmember');
  cookies.memberOfAnotherSpace = await loginAs('other');
  cookies.viewer = await loginAs('viewer');
  cookies.editor = await loginAs('editor');
  cookies.owner = await loginAs('owner');
  cookies.disabledUser = await loginAs('disabled');
  await disableUser(db, { username: 'disabled' });
  (globalThis as { __ids?: Record<string, string> }).__ids = ids;
});
afterAll(async () => {
  await resetAuthTables();
  await releaseTestEnv();
});

beforeEach(async () => {
  const ids = (globalThis as unknown as { __ids: Record<string, string> }).__ids;
  const db = getDb();
  await db.delete(spaces); // cascades memberships and positions
  const ref = await ensureReferenceData();
  const spaceA = await createSpaceRow('Space A', [
    { userId: ids.owner!, role: 'owner' },
    { userId: ids.editor!, role: 'editor' },
    { userId: ids.viewer!, role: 'viewer' },
    { userId: ids.disabled!, role: 'owner' },
  ]);
  const spaceB = await createSpaceRow('Space B', [{ userId: ids.other!, role: 'owner' }]);
  fx = {
    spaceA,
    spaceB,
    posA: await createPositionRow(spaceA, ref.ai, '10'),
    posB: await createPositionRow(spaceB, ref.msft, '7'),
    missingSpace: crypto.randomUUID(),
  };
  await createPositionRow(spaceA, ref.cw8, '3');
});

async function snapshot() {
  const rows = await getDb().select().from(spacePositions);
  return rows
    .map((r) => `${r.id}|${r.spaceId}|${r.quantity}`)
    .sort()
    .join('\n');
}

const ACTORS: Actor[] = [
  'anonymous',
  'disabledUser',
  'nonMember',
  'memberOfAnotherSpace',
  'viewer',
  'editor',
  'owner',
];

async function call(
  spec: ProcedureSpec,
  actor: Actor,
  spaceId: string,
  positionId: string,
  rawInput?: unknown,
) {
  return rpc(spec.path, rawInput ?? spec.input(spaceId, positionId), {
    ...(cookies[actor] ? { cookie: cookies[actor] } : {}),
  });
}

function expectOutcome(res: Awaited<ReturnType<typeof call>>, outcome: Outcome) {
  if (outcome === 'ok') {
    expect(res.status).toBe(200);
  } else {
    expect(res.json.code).toBe(outcome);
    expect(res.status).toBe(STATUS[outcome]);
  }
}

describe.each(PROCEDURES)('IDOR matrix: $path', (spec) => {
  it.each(ACTORS)('%s on space A', async (actor) => {
    const before = await snapshot();
    const outcome = expectedOnSpaceA(actor, spec);
    expectOutcome(await call(spec, actor, fx.spaceA, fx.posA), outcome);
    if (outcome !== 'ok') expect(await snapshot()).toBe(before);
  });

  it('a nonexistent spaceId is NOT_FOUND for a valid, privileged caller', async () => {
    const before = await snapshot();
    expectOutcome(await call(spec, 'owner', fx.missingSpace, fx.posA), 'NOT_FOUND');
    expect(await snapshot()).toBe(before);
  });

  it('a nonexistent space and an inaccessible space are indistinguishable', async () => {
    const missing = await call(spec, 'nonMember', fx.missingSpace, fx.posA);
    const foreign = await call(spec, 'nonMember', fx.spaceA, fx.posA);
    expect(missing.status).toBe(foreign.status);
    expect(missing.json).toEqual(foreign.json);
  });

  it("someone else's space (member of B only) is NOT_FOUND, not FORBIDDEN", async () => {
    // 'other' owns space B; space A is not theirs.
    expectOutcome(await call(spec, 'memberOfAnotherSpace', fx.spaceA, fx.posA), 'NOT_FOUND');
    // ...but their own space works.
    expectOutcome(await call(spec, 'memberOfAnotherSpace', fx.spaceB, fx.posB), 'ok');
  });

  it.each(['not-a-uuid', '', "'; drop table spaces; --", '00000000-0000-0000-0000-000000000000'])(
    'a malformed/zero spaceId %j is NOT_FOUND',
    async (bad) => {
      expectOutcome(await call(spec, 'owner', bad, fx.posA), 'NOT_FOUND');
    },
  );

  it('authorization wins over input validation (garbage payload)', async () => {
    const garbage = { spaceId: fx.spaceA, positionId: 'nope', quantity: '1e3', extra: true };
    expectOutcome(await call(spec, 'nonMember', fx.spaceA, fx.posA, garbage), 'NOT_FOUND');
    expectOutcome(
      await call(spec, 'viewer', fx.spaceA, fx.posA, garbage),
      // Extra keys are stripped for viewer-level procedures, so the request is valid there.
      spec.minRole === 'editor' ? 'FORBIDDEN' : 'ok',
    );
    expectOutcome(await call(spec, 'anonymous', fx.spaceA, fx.posA, garbage), 'UNAUTHORIZED');
  });

  if (spec.takesPosition) {
    it('a position of ANOTHER space passed with an accessible spaceId is NOT_FOUND and untouched', async () => {
      const before = await snapshot();
      // Owner of A targets B's position through A: must be resolved inside A only.
      expectOutcome(await call(spec, 'owner', fx.spaceA, fx.posB), 'NOT_FOUND');
      expect(await snapshot()).toBe(before);
      // The role check still comes first for a viewer.
      expectOutcome(await call(spec, 'viewer', fx.spaceA, fx.posB), 'FORBIDDEN');
      // And B's own owner cannot use A's position through B.
      expectOutcome(await call(spec, 'memberOfAnotherSpace', fx.spaceB, fx.posA), 'NOT_FOUND');
      expect(await snapshot()).toBe(before);
    });

    it('a random, well-formed positionId is NOT_FOUND', async () => {
      expectOutcome(await call(spec, 'owner', fx.spaceA, crypto.randomUUID()), 'NOT_FOUND');
    });
  }
});

describe('spaces.list (user-scoped, not space-scoped)', () => {
  it('only ever returns the caller spaces; anonymous/disabled are UNAUTHORIZED', async () => {
    const own = await rpc('spaces.list', undefined, { cookie: cookies.memberOfAnotherSpace! });
    expect(own.status).toBe(200);
    const names = (own.json as unknown as { spaces: { name: string }[] }).spaces.map((s) => s.name);
    expect(names).toEqual(['Space B']);
    const none = await rpc('spaces.list', undefined, { cookie: cookies.nonMember! });
    expect((none.json as unknown as { spaces: unknown[] }).spaces).toEqual([]);
    expect((none.json as unknown as { activeSpaceId: unknown }).activeSpaceId).toBeNull();
    expect((await rpc('spaces.list')).status).toBe(401);
    expect((await rpc('spaces.list', undefined, { cookie: cookies.disabledUser! })).status).toBe(
      401,
    );
  });
});

describe('the matrix covers the whole contract', () => {
  it('contains exactly the procedures classified as space-scoped', () => {
    const spacePaths = Object.entries(CLASSIFICATION)
      .filter(([, c]) => c === 'space')
      .map(([p]) => p)
      .sort();
    expect(spacePaths).toEqual(PROCEDURES.map((p) => p.path).sort());
  });

  it('classification covers the whole contract (see contract-classification.test.ts)', () => {
    expect(Object.keys(CLASSIFICATION).sort()).toEqual(allContractPaths());
  });
});

describe('the ok path really did its job (sanity of the matrix)', () => {
  it('owner setQuantity and remove change state, viewer does not', async () => {
    const [setQ, remove] = [PROCEDURES[3]!, PROCEDURES[4]!];
    expectOutcome(await call(setQ, 'editor', fx.spaceA, fx.posA), 'ok');
    const [row] = await getDb().select().from(spacePositions).where(eq(spacePositions.id, fx.posA));
    expect(Number(row?.quantity)).toBe(99.5);
    expectOutcome(await call(remove, 'owner', fx.spaceA, fx.posA), 'ok');
    expect(
      await getDb().select().from(spacePositions).where(eq(spacePositions.id, fx.posA)),
    ).toHaveLength(0);
  });
});
