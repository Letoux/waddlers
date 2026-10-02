import {
  defaultTableConfig,
  type TableConfigOutput,
  type TableConfigV1,
} from '@waddlers/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../admin';
import { DashboardLimiter } from '../dashboard/limiter';
import { getDb } from '../db/client';
import { tableConfigs } from '../db/schema';
import {
  createApp,
  PASSWORD,
  releaseTestEnv,
  resetAuthTables,
  useTestEnv,
} from '../../test/auth-harness';
import { createSpaceRow } from '../../test/space-fixtures';
import type { DbExecutor } from '../db/create';
import { requireSpaceAccess } from './access';
import { saveTableConfig } from './table-config';

/** Hardening of `tableConfig.save` / `positions.*` (S7 audit F1, F2; review P3-1, P3-2, P3-5). */

let clock = 1_000_000;
const tableConfigLimiter = new DashboardLimiter({
  maxConcurrent: 2,
  ratePerMinute: 30,
  burst: 10,
  now: () => clock,
});
const dashboardLimiter = new DashboardLimiter({
  maxConcurrent: 2,
  ratePerMinute: 30,
  now: () => clock,
});
const { rpc, loginAs } = createApp({ tableConfigLimiter, dashboardLimiter });
let aliceId: string;
let cookie: string;
let space: string;

beforeAll(useTestEnv);
afterAll(async () => {
  await resetAuthTables();
  await releaseTestEnv();
});
beforeEach(async () => {
  await resetAuthTables();
  clock += 3_600_000; // every test starts with full buckets
  aliceId = (await createUser(getDb(), { username: 'alice', password: PASSWORD })).id;
  cookie = await loginAs('alice');
  space = await createSpaceRow('PEA', [{ userId: aliceId, role: 'viewer' }]);
});

const save = (config: unknown, spaceId = space) =>
  rpc('tableConfig.save', { spaceId, config }, { cookie });
const withFilters = (filters: unknown[], patch: object = {}) => ({
  ...defaultTableConfig(),
  filters,
  ...patch,
});
const rows = () => getDb().select().from(tableConfigs);

describe('ill-formed text (audit F1)', () => {
  const lone = [{ kind: 'in', columnId: 'sector', values: ['\uD800'] }];
  it('save refuses a lone surrogate with BAD_REQUEST (not a 500) and writes nothing', async () => {
    const res = await save(withFilters(lone));
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('BAD_REQUEST');
    expect(await rows()).toHaveLength(0);
  });
  it('positions.list refuses it in a filter value and in the search', async () => {
    const f = await rpc('positions.list', { spaceId: space, filters: lone }, { cookie });
    expect([f.status, f.json.code]).toEqual([400, 'BAD_REQUEST']);
    for (const search of ['\uD800', 'x\uDFFFy']) {
      const s = await rpc('positions.list', { spaceId: space, search }, { cookie });
      expect([s.status, s.json.code]).toEqual([400, 'BAD_REQUEST']);
    }
    const ok = await rpc('positions.list', { spaceId: space, search: 'hermès 😀' }, { cookie });
    expect(ok.status).toBe(200);
  });
});

describe('database errors of the write (audit F1, defence in depth)', () => {
  /** A db whose upsert fails with the given SQLSTATE (found through Drizzle's `cause`, like the real wrapper). */
  const failing = (code: string) =>
    ({
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: () => Promise.reject(new Error('query failed', { cause: { code } })),
          }),
        }),
      }),
    }) as unknown as DbExecutor;
  const authorized = () => requireSpaceAccess({ db: getDb(), userId: aliceId }, space, 'viewer');

  it.each(['22P02', '22P05'])('SQLSTATE %s is a BAD_REQUEST, not a 500', async (code) => {
    await expect(
      saveTableConfig(failing(code), await authorized(), defaultTableConfig()),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  it('an FK violation (membership revoked) is NOT_FOUND; any other error is not disguised', async () => {
    const sp = await authorized();
    await expect(saveTableConfig(failing('23503'), sp, defaultTableConfig())).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    await expect(
      saveTableConfig(failing('57014'), sp, defaultTableConfig()),
    ).rejects.not.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('admission control (audit F2)', () => {
  it('tableConfig.save: burst of 10 then a typed 429 with retryAfterSeconds and Retry-After', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await save(withFilters([], { pageSize: i % 2 === 0 ? 25 : 100 }));
      expect(res.status, `save ${i}`).toBe(200);
    }
    const res = await save(defaultTableConfig());
    expect(res.status).toBe(429);
    expect(res.json.code).toBe('TOO_MANY_REQUESTS');
    expect(res.json.data).toEqual({ retryAfterSeconds: 2 });
    expect(res.headers.get('retry-after')).toBe('2');
    // Reads, resets and the table are not rated by this bucket.
    expect((await rpc('tableConfig.get', { spaceId: space }, { cookie })).status).toBe(200);
    expect((await rpc('positions.list', { spaceId: space }, { cookie })).status).toBe(200);
    // The bucket refills (1 token per 2 s).
    clock += 2_000;
    expect((await save(defaultTableConfig())).status).toBe(200);
  });

  it('is per user: another user keeps their own bucket', async () => {
    const bob = (await createUser(getDb(), { username: 'bob', password: PASSWORD })).id;
    const bobCookie = await loginAs('bob');
    const bobSpace = await createSpaceRow('Bob', [{ userId: bob, role: 'viewer' }]);
    for (let i = 0; i < 11; i += 1) await save(defaultTableConfig());
    expect((await save(defaultTableConfig())).status).toBe(429);
    const res = await rpc(
      'tableConfig.save',
      { spaceId: bobSpace, config: defaultTableConfig() },
      { cookie: bobCookie },
    );
    expect(res.status).toBe(200);
  });

  it('an inaccessible space is NOT_FOUND, not 429 (the check runs after access)', async () => {
    for (let i = 0; i < 11; i += 1) await save(defaultTableConfig());
    const other = await createSpaceRow('Foreign', []);
    const res = await save(defaultTableConfig(), other);
    expect(res.json.code).toBe('NOT_FOUND');
  });

  it('positions.facets shares the positions.list policy: 4 in flight per user, unrated', async () => {
    const held = Array.from({ length: 4 }, () =>
      dashboardLimiter.acquire(aliceId, 'positions.facets', { maxConcurrent: 4, rated: false }),
    );
    expect(held.every((a) => a.allowed)).toBe(true);
    const res = await rpc('positions.facets', { spaceId: space }, { cookie });
    expect([res.status, res.json.code]).toEqual([429, 'TOO_MANY_REQUESTS']);
    expect(res.json.data).toEqual({ retryAfterSeconds: 1 });
    expect(res.headers.get('retry-after')).toBe('1');
    // The list has its own counter, and an inaccessible space is still NOT_FOUND.
    expect((await rpc('positions.list', { spaceId: space }, { cookie })).status).toBe(200);
    const other = await createSpaceRow('Foreign', []);
    expect((await rpc('positions.facets', { spaceId: other }, { cookie })).json.code).toBe(
      'NOT_FOUND',
    );
    const first = held[0];
    if (first?.allowed) first.release();
    expect((await rpc('positions.facets', { spaceId: space }, { cookie })).status).toBe(200);
    for (const h of held) if (h.allowed) h.release();
  });

  it('facets calls are unrated: a long run never gets a 429', async () => {
    for (let i = 0; i < 40; i += 1) {
      expect((await rpc('positions.facets', { spaceId: space }, { cookie })).status).toBe(200);
    }
  });
});

describe('identical writes are skipped (audit F2)', () => {
  it('saving the same document again leaves the row untouched; a change updates updated_at', async () => {
    const cfg = withFilters([{ kind: 'between', columnId: 'perf_1y', min: '5' }]);
    await save(cfg);
    const [first] = await rows();
    await new Promise((r) => setTimeout(r, 15));
    const again = await save(cfg);
    expect(again.json).toEqual({ config: cfg, isDefault: false });
    const [second] = await rows();
    expect(second?.updatedAt.getTime()).toBe(first?.updatedAt.getTime());
    const [{ xmin: x1 } = { xmin: '' }] = await getDb().execute<{ xmin: string }>(
      sql`select xmin::text from table_configs`,
    );
    await save(cfg);
    const [{ xmin: x2 } = { xmin: '' }] = await getDb().execute<{ xmin: string }>(
      sql`select xmin::text from table_configs`,
    );
    expect(x2, 'no new tuple was written').toBe(x1);
    await new Promise((r) => setTimeout(r, 15));
    await save({ ...cfg, density: 'compact' });
    const [third] = await rows();
    expect(third?.updatedAt.getTime()).toBeGreaterThan(first?.updatedAt.getTime() ?? 0);
    expect((third?.config as TableConfigV1).density).toBe('compact');
  });
});

describe('version dispatch (review P3-1)', () => {
  it('a view stored by a NEWER version is read best-effort and never overwritten (typed 409)', async () => {
    const cfg = withFilters([], { density: 'compact' });
    await save(cfg);
    await getDb().update(tableConfigs).set({ version: 99 }).where(eq(tableConfigs.userId, aliceId));
    const got = await rpc('tableConfig.get', { spaceId: space }, { cookie });
    expect(got.status).toBe(200);
    expect((got.json as unknown as TableConfigOutput).config.density).toBe('compact');
    const res = await save(withFilters([], { density: 'comfortable' }));
    expect([res.status, res.json.code]).toEqual([409, 'CONFLICT']);
    const [row] = await rows();
    expect(row?.version).toBe(99);
    expect((row?.config as TableConfigV1).density).toBe('compact');
  });
});

describe('size bound (review P3-2)', () => {
  /** The largest valid config: multibyte sector values, JSON just under 12 000 bytes. */
  function largest(): TableConfigV1 {
    const base = withFilters([]) as TableConfigV1;
    const make = (values: string[]): TableConfigV1 => ({
      ...base,
      filters: [{ kind: 'in', columnId: 'sector', values }],
    });
    const bytes = (c: TableConfigV1) => Buffer.byteLength(JSON.stringify(c));
    const values: string[] = [];
    while (values.length < 49 && bytes(make([...values, '€'.repeat(100)])) <= 12_000)
      values.push('€'.repeat(100));
    let n = 100;
    while (n > 1 && bytes(make([...values, '€'.repeat(n)])) > 12_000) n -= 1;
    values.push('€'.repeat(n));
    return make(values);
  }

  it('saves the largest valid config (200), stores it, and stays under the 16 384-byte CHECK', async () => {
    const cfg = largest();
    const size = Buffer.byteLength(JSON.stringify(cfg));
    expect(size).toBeLessThanOrEqual(12_000);
    expect(size).toBeGreaterThan(11_900);
    const res = await save(cfg);
    expect(res.status, JSON.stringify(res.json).slice(0, 200)).toBe(200);
    expect(res.json).toEqual({ config: cfg, isDefault: false });
    expect(await rows()).toHaveLength(1);
    const [{ n } = { n: 0 }] = await getDb().execute<{ n: number }>(
      sql`select pg_column_size(config)::int as n from table_configs`,
    );
    expect(n).toBeLessThanOrEqual(16_384);
  });

  it('one byte over the save bound is a BAD_REQUEST, not a CHECK violation', async () => {
    const cfg = largest();
    const [filter] = cfg.filters ?? [];
    if (filter?.kind !== 'in') throw new Error('fixture');
    const over = { ...cfg, filters: [{ ...filter, values: [...filter.values, '€'.repeat(2)] }] };
    const res = await save(over);
    expect([res.status, res.json.code]).toEqual([400, 'BAD_REQUEST']);
  });
});

describe('last write wins (review P3-5)', () => {
  it('two parallel saves: one row, equal to one of the inputs; each response equals its own input', async () => {
    const a = withFilters([], { density: 'compact', pageSize: 25 });
    const b = withFilters([{ kind: 'in', columnId: 'currency', values: ['USD'] }], {
      density: 'comfortable',
      pageSize: 200,
    });
    const [ra, rb] = await Promise.all([save(a), save(b)]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(ra.json).toEqual({ config: a, isDefault: false });
    expect(rb.json).toEqual({ config: b, isDefault: false });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect([a, b]).toContainEqual(stored[0]?.config);
  });
});
