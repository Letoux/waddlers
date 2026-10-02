import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, disableUser } from '../admin';
import { getDb } from '../db/client';
import { listingMetrics, spacePositions, spaces } from '../db/schema';
import {
  createApp,
  PASSWORD,
  releaseTestEnv,
  resetAuthTables,
  useTestEnv,
} from '../../test/auth-harness';
import { DashboardLimiter } from '../dashboard/limiter';
import { recomputeListingMetrics } from '../market-data/metrics';
import { recordSuccess, upsertBars, upsertFxRates } from '../market-data/repository';
import { testConfig } from '../../test/market-fixtures';
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
  /** Identity of space B's own instrument (distinct from every instrument of space A). */
  msft: { instrumentId: string; listingId: string };
  posCw8: string;
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
    // The S6 table input: sort, search, period and columns are part of the matrix payload.
    input: (spaceId) => ({
      spaceId,
      period: '1m',
      sort: { columnId: 'perf_period', direction: 'desc' },
      columns: ['name', 'symbol', 'price_eur', 'tracked_value_eur', 'description'],
    }),
  },
  ...['summary', 'history', 'movers'].map((name): ProcedureSpec => ({
    path: `dashboard.${name}`,
    minRole: 'viewer',
    takesPosition: false,
    input: (spaceId) => ({ spaceId, period: '1m' }),
  })),
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

// Generous dashboard cap: the matrix fires many calls as one user (the cap has its own tests).
const { rpc, loginAs } = createApp({
  dashboardLimiter: new DashboardLimiter({ maxConcurrent: 50, ratePerMinute: 100_000 }),
});
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
    msft: ref.msft,
    posCw8: await createPositionRow(spaceA, ref.cw8, '3'),
  };
  await seedMarketData(ref);
});

const NOW = new Date('2026-09-30T12:00:00Z');

/**
 * Market data for every instrument, so the dashboard procedures return real content (positions,
 * series, movers) in the ok cases: A holds AI and CW8 (1240 EUR), B holds MSFT only (7 x 250 USD / 1.25).
 */
async function seedMarketData(ref: Awaited<ReturnType<typeof ensureReferenceData>>) {
  const db = getDb();
  const bars: [string, { id: string; currency: string }, [string, string][]][] = [
    [
      'ai',
      { id: ref.ai.listingId, currency: 'EUR' },
      [
        ['2026-08-25', '88'],
        ['2026-09-01', '90'],
        ['2026-09-30', '100'],
      ],
    ],
    [
      'cw8',
      { id: ref.cw8.listingId, currency: 'EUR' },
      [
        ['2026-08-25', '68'],
        ['2026-09-01', '70'],
        ['2026-09-30', '80'],
      ],
    ],
    [
      'msft',
      { id: ref.msft.listingId, currency: 'USD' },
      [
        ['2026-08-25', '190'],
        ['2026-09-01', '200'],
        ['2026-09-30', '250'],
      ],
    ],
  ];
  for (const [, listing, rows] of bars) {
    await upsertBars(
      db,
      listing,
      rows.map(([date, close]) => ({ date, close, adjClose: null })),
      { source: 'fake', fetchedAt: NOW },
    );
    await recordSuccess(db, listing.id, 'history', NOW, { historyCompleteFrom: '2026-08-25' });
  }
  await upsertFxRates(
    db,
    ['2026-09-01', '2026-09-30'].map((date) => ({ date, currency: 'USD', ratePerEur: '1.25' })),
    { source: 'fake', fetchedAt: NOW },
  );
  await recomputeListingMetrics(db, { now: NOW, config: testConfig });
}

/** Every `positionId` anywhere in a response body. */
function positionIdsIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => positionIdsIn(v, out));
  else if (typeof value === 'object' && value !== null) {
    for (const [key, v] of Object.entries(value)) {
      if (key === 'positionId' && typeof v === 'string') out.push(v);
      else positionIdsIn(v, out);
    }
  }
  return out;
}

/** An ok dashboard answer for `spaceId` may only mention positions of that space. */
async function expectOnlyPositionsOf(res: Awaited<ReturnType<typeof call>>, spaceId: string) {
  const ids = positionIdsIn(res.json);
  if (ids.length === 0) return;
  const owned = await getDb()
    .select({ id: spacePositions.id })
    .from(spacePositions)
    .where(inArray(spacePositions.id, ids));
  const inSpace = await getDb()
    .select({ id: spacePositions.id })
    .from(spacePositions)
    .where(eq(spacePositions.spaceId, spaceId));
  const allowed = new Set(inSpace.map((r) => r.id));
  expect(owned.every((r) => allowed.has(r.id))).toBe(true);
  expect(ids.every((id) => allowed.has(id))).toBe(true);
}

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
    const res = await call(spec, actor, fx.spaceA, fx.posA);
    expectOutcome(res, outcome);
    if (outcome !== 'ok') expect(await snapshot()).toBe(before);
    else if (spec.path.startsWith('dashboard.')) await expectOnlyPositionsOf(res, fx.spaceA);
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
    // ...but their own space works, and only mentions their own positions.
    const own = await call(spec, 'memberOfAnotherSpace', fx.spaceB, fx.posB);
    expectOutcome(own, 'ok');
    if (spec.path.startsWith('dashboard.')) await expectOnlyPositionsOf(own, fx.spaceB);
  });

  it.each(['not-a-uuid', '', "'; drop table spaces; --", '00000000-0000-0000-0000-000000000000'])(
    'a malformed/zero spaceId %j is NOT_FOUND',
    async (bad) => {
      expectOutcome(await call(spec, 'owner', bad, fx.posA), 'NOT_FOUND');
    },
  );

  it('authorization wins over input validation (garbage payload)', async () => {
    // `period` stays valid: the dashboard inputs are only { spaceId, period } and a bad one is a 400.
    const garbage = {
      spaceId: fx.spaceA,
      period: '1m',
      positionId: 'nope',
      quantity: '1e3',
      extra: true,
    };
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

describe.each(PROCEDURES.filter((p) => p.path.startsWith('dashboard.')))(
  'dashboard isolation and validation: $path',
  (spec) => {
    const bogus = (spaceId: string) => ({ spaceId, period: 'bogus' });

    it('a garbage period: NOT_FOUND for a non-member (access first), BAD_REQUEST for a viewer', async () => {
      const nonMember = await call(spec, 'nonMember', fx.spaceA, fx.posA, bogus(fx.spaceA));
      expect(nonMember.json.code).toBe('NOT_FOUND');
      expect(nonMember.status).toBe(404);
      const viewer = await call(spec, 'viewer', fx.spaceA, fx.posA, bogus(fx.spaceA));
      expect(viewer.json.code).toBe('BAD_REQUEST');
      expect(viewer.status).toBe(400);
      // A member of another space does not learn anything either.
      const other = await call(spec, 'memberOfAnotherSpace', fx.spaceA, fx.posA, bogus(fx.spaceA));
      expect(other.json.code).toBe('NOT_FOUND');
    });

    it("space B's own instrument never appears in space A's answer, and vice versa", async () => {
      const a = JSON.stringify((await call(spec, 'owner', fx.spaceA, fx.posA)).json);
      const b = JSON.stringify((await call(spec, 'memberOfAnotherSpace', fx.spaceB, fx.posB)).json);
      for (const leak of [fx.msft.instrumentId, fx.msft.listingId, fx.posB, 'Microsoft', 'MSFT']) {
        expect(a, `A leaks ${leak}`).not.toContain(leak);
      }
      for (const leak of [fx.posA, fx.posCw8, 'Air Liquide', 'World ETF']) {
        expect(b, `B leaks ${leak}`).not.toContain(leak);
      }
      // The answers really hold each space's own content (the check above is not vacuous).
      const movers = spec.path === 'dashboard.movers';
      expect(a).toContain(movers ? 'Air Liquide' : '1240');
      expect(b).toContain(movers ? 'Microsoft' : '1400');
    });
  },
);

describe('positions.list (table, S6) isolation and validation', () => {
  const spec = PROCEDURES.find((p) => p.path === 'positions.list')!;
  type Listed = { rows: { id: string; instrument: { name: string } }[]; total: number };
  const list = async (actor: Actor, spaceId: string, extra: Record<string, unknown> = {}) =>
    (await call(spec, actor, spaceId, fx.posA, { spaceId, ...extra })).json as unknown as Listed;

  it.each([
    ['unknown column', { sort: { columnId: 'password', direction: 'asc' } }],
    ['pending column', { sort: { columnId: 'market_cap_eur', direction: 'asc' } }],
    ['bad direction', { sort: { columnId: 'name', direction: 'sideways' } }],
    ['sql in column', { sort: { columnId: 'name; drop table spaces', direction: 'asc' } }],
    ['bad period', { period: 'bogus' }],
    ['NUL in search', { search: 'a\u0000b' }],
    ['limit over 200', { page: { offset: 0, limit: 201 } }],
    ['unknown requested column', { columns: ['nope'] }],
  ])('%s: NOT_FOUND for a non-member (access first), BAD_REQUEST for a viewer', async (_n, bad) => {
    const nonMember = await call(spec, 'nonMember', fx.spaceA, fx.posA, {
      spaceId: fx.spaceA,
      ...bad,
    });
    expect(nonMember.json.code).toBe('NOT_FOUND');
    expect(nonMember.status).toBe(404);
    const other = await call(spec, 'memberOfAnotherSpace', fx.spaceA, fx.posA, {
      spaceId: fx.spaceA,
      ...bad,
    });
    expect(other.json.code).toBe('NOT_FOUND');
    const viewer = await call(spec, 'viewer', fx.spaceA, fx.posA, { spaceId: fx.spaceA, ...bad });
    expect(viewer.json.code).toBe('BAD_REQUEST');
    expect(viewer.status).toBe(400);
    expect(
      (await call(spec, 'anonymous', fx.spaceA, fx.posA, { spaceId: fx.spaceA, ...bad })).status,
    ).toBe(401);
  });

  it('each space answers with its own rows only, whatever the sort, search or columns', async () => {
    const a = await list('owner', fx.spaceA);
    const b = await list('memberOfAnotherSpace', fx.spaceB);
    expect(a.rows.map((r) => r.instrument.name).sort()).toEqual(['Air Liquide', 'World ETF']);
    expect(b.rows.map((r) => r.instrument.name)).toEqual(['Microsoft']);
    expect([a.total, b.total]).toEqual([2, 1]);
    // Searching for the other space's content (name, code, ISIN, exchange) through the own space finds nothing.
    for (const search of ['Microsoft', 'MSFT', 'US5949181045', 'Nasdaq', 'XNAS', 'USD']) {
      const viaA = await list('owner', fx.spaceA, { search });
      expect(viaA.rows, search).toEqual([]);
      expect(viaA.total, search).toBe(0);
    }
    // ... and the same search through the owning space does find it (not vacuous).
    expect((await list('memberOfAnotherSpace', fx.spaceB, { search: 'msft' })).total).toBe(1);
    for (const sortColumn of [
      'name',
      'perf_period',
      'tracked_value_eur',
      'quantity',
      'price_eur',
    ]) {
      const sorted = await list('owner', fx.spaceA, {
        sort: { columnId: sortColumn, direction: 'desc' },
        columns: ['description', 'name', 'tracked_value_eur'],
      });
      expect(JSON.stringify(sorted)).not.toContain('Microsoft');
      expect(sorted.rows.map((r) => r.id)).not.toContain(fx.posB);
    }
  });
});

describe('positions.list computedAt / oldestComputedAt are per space (S6 review F7)', () => {
  it("space A reports A's own newest and oldest computed_at, never space B's later one", async () => {
    const db = getDb();
    const aListings = await db
      .select({ id: spacePositions.listingId })
      .from(spacePositions)
      .where(eq(spacePositions.spaceId, fx.spaceA));
    expect(aListings).toHaveLength(2);
    const stamp = (id: string, iso: string) =>
      db
        .update(listingMetrics)
        .set({ computedAt: new Date(iso) })
        .where(eq(listingMetrics.listingId, id));
    await stamp(aListings[0]!.id, '2026-09-30T08:00:00Z');
    await stamp(aListings[1]!.id, '2026-09-30T09:00:00Z');
    await stamp(fx.msft.listingId, '2026-09-30T23:00:00Z'); // B's, later than anything of A
    const spec = PROCEDURES.find((p) => p.path === 'positions.list')!;
    const stamps = async (actor: Actor, spaceId: string) => {
      const json = (await call(spec, actor, spaceId, fx.posA, { spaceId })).json as unknown as {
        computedAt: string | null;
        oldestComputedAt: string | null;
      };
      return [json.computedAt, json.oldestComputedAt];
    };
    expect(await stamps('owner', fx.spaceA)).toEqual([
      '2026-09-30T09:00:00.000Z',
      '2026-09-30T08:00:00.000Z',
    ]);
    expect(await stamps('memberOfAnotherSpace', fx.spaceB)).toEqual([
      '2026-09-30T23:00:00.000Z',
      '2026-09-30T23:00:00.000Z',
    ]);
  });
});

describe('dashboard totals are per space (distinct instruments and values)', () => {
  it('summary of A = 1240 EUR (AI 10 x 100 + CW8 3 x 80), of B = 1400 EUR (MSFT 7 x 250 / 1.25)', async () => {
    const spec = PROCEDURES.find((p) => p.path === 'dashboard.summary')!;
    const total = async (actor: Actor, spaceId: string) =>
      ((await call(spec, actor, spaceId, fx.posA)).json as unknown as { total: { amount: string } })
        .total.amount;
    expect(await total('owner', fx.spaceA)).toBe('1240');
    expect(await total('memberOfAnotherSpace', fx.spaceB)).toBe('1400');
  });
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
    const setQ = PROCEDURES.find((p) => p.path === 'positions.setQuantity')!;
    const remove = PROCEDURES.find((p) => p.path === 'positions.remove')!;
    expectOutcome(await call(setQ, 'editor', fx.spaceA, fx.posA), 'ok');
    const [row] = await getDb().select().from(spacePositions).where(eq(spacePositions.id, fx.posA));
    expect(Number(row?.quantity)).toBe(99.5);
    expectOutcome(await call(remove, 'owner', fx.spaceA, fx.posA), 'ok');
    expect(
      await getDb().select().from(spacePositions).where(eq(spacePositions.id, fx.posA)),
    ).toHaveLength(0);
  });
});
