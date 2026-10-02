import {
  TABLE_COLUMN_IDS,
  defaultTableConfig,
  type TableConfigOutput,
  type TableConfigV1,
} from '@waddlers/contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../admin';
import { getDb } from '../db/client';
import { pgErrorCode } from '../db/errors';
import { spaceMembers, tableConfigs } from '../db/schema';
import {
  createApp,
  PASSWORD,
  releaseTestEnv,
  resetAuthTables,
  useTestEnv,
} from '../../test/auth-harness';
import { createSpaceRow } from '../../test/space-fixtures';

const { rpc, loginAs } = createApp();
let alice: string;
let bob: string;
let aliceCookie: string;
let bobCookie: string;
let pea: string;
let us: string;

beforeAll(useTestEnv);
afterAll(async () => {
  await resetAuthTables();
  await releaseTestEnv();
});

beforeEach(async () => {
  await resetAuthTables();
  alice = (await createUser(getDb(), { username: 'alice', password: PASSWORD })).id;
  bob = (await createUser(getDb(), { username: 'bob', password: PASSWORD })).id;
  aliceCookie = await loginAs('alice');
  bobCookie = await loginAs('bob');
  pea = await createSpaceRow('PEA', [
    { userId: alice, role: 'viewer' },
    { userId: bob, role: 'editor' },
  ]);
  us = await createSpaceRow('Actions US', [{ userId: alice, role: 'owner' }]);
});

const call = (proc: string, input: object, cookie: string) => rpc(proc, input, { cookie });
const get = async (spaceId: string, cookie: string) => {
  const res = await call('tableConfig.get', { spaceId }, cookie);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as unknown as TableConfigOutput;
};
const save = (spaceId: string, config: unknown, cookie: string, extra: object = {}) =>
  call('tableConfig.save', { spaceId, config, ...extra }, cookie);

/** A recognisable config: `first` shown first, a sort, a filter, compact, 100 per page. */
function config(first: string, patch: Partial<TableConfigV1> = {}): TableConfigV1 {
  const base = defaultTableConfig();
  const rest = base.columns.filter((c) => c.id !== first);
  return {
    ...base,
    columns: [{ id: first as TableConfigV1['columns'][number]['id'], visible: true }, ...rest],
    sort: { columnId: 'perf_1y', direction: 'desc' },
    filters: [{ kind: 'between', columnId: 'perf_1y', min: '10' }],
    density: 'compact',
    pageSize: 100,
    ...patch,
  };
}

describe('get, save, reset', () => {
  it('without a saved row, get returns the D24 defaults flagged isDefault', async () => {
    expect(await get(pea, aliceCookie)).toEqual({ config: defaultTableConfig(), isDefault: true });
  });

  it('save then get round-trips the whole config (a viewer can save their own view)', async () => {
    const cfg = config('symbol');
    const saved = await save(pea, cfg, aliceCookie);
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json).toEqual({ config: cfg, isDefault: false });
    expect(await get(pea, aliceCookie)).toEqual({ config: cfg, isDefault: false });
  });

  it('saving again replaces the config (upsert, repeatable)', async () => {
    await save(pea, config('symbol'), aliceCookie);
    await save(pea, config('symbol'), aliceCookie);
    const second = config('sector', { density: 'comfortable', sort: undefined, filters: [] });
    await save(pea, second, aliceCookie);
    expect((await get(pea, aliceCookie)).config).toEqual(second);
    expect(await getDb().select().from(tableConfigs)).toHaveLength(1);
  });

  it('reset deletes the row and returns the defaults; it is idempotent', async () => {
    await save(pea, config('symbol'), aliceCookie);
    const res = await call('tableConfig.reset', { spaceId: pea }, aliceCookie);
    expect(res.json).toEqual({ config: defaultTableConfig(), isDefault: true });
    expect(await getDb().select().from(tableConfigs)).toHaveLength(0);
    expect((await call('tableConfig.reset', { spaceId: pea }, aliceCookie)).status).toBe(200);
    expect((await get(pea, aliceCookie)).isDefault).toBe(true);
  });
});

describe('isolation per user and per space', () => {
  it('alice in PEA, alice in Actions US and bob in PEA have three independent views', async () => {
    await save(pea, config('symbol'), aliceCookie);
    await save(us, config('sector'), aliceCookie);
    await save(pea, config('currency'), bobCookie);
    expect((await get(pea, aliceCookie)).config.columns[0]?.id).toBe('symbol');
    expect((await get(us, aliceCookie)).config.columns[0]?.id).toBe('sector');
    expect((await get(pea, bobCookie)).config.columns[0]?.id).toBe('currency');
    // Resetting one view leaves the others alone.
    await call('tableConfig.reset', { spaceId: pea }, aliceCookie);
    expect((await get(pea, aliceCookie)).isDefault).toBe(true);
    expect((await get(us, aliceCookie)).config.columns[0]?.id).toBe('sector');
    expect((await get(pea, bobCookie)).config.columns[0]?.id).toBe('currency');
  });

  it("a user without a saved view never sees another member's view of the same space", async () => {
    await save(pea, config('symbol'), aliceCookie);
    expect(await get(pea, bobCookie)).toEqual({ config: defaultTableConfig(), isDefault: true });
    await call('tableConfig.reset', { spaceId: pea }, bobCookie);
    expect((await get(pea, aliceCookie)).config.columns[0]?.id).toBe('symbol');
  });

  it('a forged userId in the input is ignored: the row written is the caller’s', async () => {
    const res = await save(pea, config('symbol'), aliceCookie, { userId: bob });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const rows = await getDb().select().from(tableConfigs);
    expect(rows.map((r) => r.userId)).toEqual([alice]);
    expect((await get(pea, bobCookie)).isDefault).toBe(true);
    // Same for get and reset.
    const reset = await call('tableConfig.reset', { spaceId: pea, userId: alice }, bobCookie);
    expect(reset.status).toBe(200);
    expect(await getDb().select().from(tableConfigs)).toHaveLength(1);
  });

  it('a non-member gets NOT_FOUND on every procedure and writes nothing', async () => {
    const stranger = await createSpaceRow('Other', []);
    for (const proc of ['tableConfig.get', 'tableConfig.reset']) {
      expect((await call(proc, { spaceId: stranger }, aliceCookie)).status).toBe(404);
    }
    expect((await save(stranger, config('symbol'), aliceCookie)).status).toBe(404);
    expect(await getDb().select().from(tableConfigs)).toHaveLength(0);
  });
});

describe('migrate on read (stored data older than the registry)', () => {
  const store = (raw: unknown) =>
    getDb().insert(tableConfigs).values({ userId: alice, spaceId: pea, version: 1, config: raw });

  it('drops unknown ids, appends new registry columns hidden, drops an invalid sort and filters', async () => {
    await store({
      columns: [
        { id: 'symbol', visible: true },
        { id: 'column_removed_in_a_later_release', visible: true },
        { id: 'name', visible: true },
      ],
      sort: { columnId: 'price', direction: 'asc' },
      filters: [
        { kind: 'between', columnId: 'dividend_yield', min: '1' },
        { kind: 'between', columnId: 'perf_1y', min: '5' },
      ],
      density: 'compact',
    });
    const { config: out, isDefault } = await get(pea, aliceCookie);
    expect(isDefault).toBe(false);
    expect(out.columns.map((c) => c.id).slice(0, 2)).toEqual(['symbol', 'name']);
    expect(out.columns.map((c) => c.id)).not.toContain('column_removed_in_a_later_release');
    expect(out.columns).toHaveLength(TABLE_COLUMN_IDS.length);
    expect(out.columns.filter((c) => c.visible).map((c) => c.id)).toEqual(['symbol', 'name']);
    expect(out.sort).toBeUndefined();
    expect(out.filters).toEqual([{ kind: 'between', columnId: 'perf_1y', min: '5' }]);
    expect(out.density).toBe('compact');
    expect(out.pageSize).toBe(50);
  });

  it('a stored config with no usable column falls back to the D24 columns; garbage never fails the read', async () => {
    await store({ columns: [{ id: 'gone', visible: true }] });
    expect((await get(pea, aliceCookie)).config.columns).toEqual(defaultTableConfig().columns);
    await getDb()
      .update(tableConfigs)
      .set({ config: { columns: 'nonsense', filters: 7 } });
    expect((await get(pea, aliceCookie)).config.columns).toEqual(defaultTableConfig().columns);
  });
});

describe('integrity (database)', () => {
  it('revoking the membership deletes that user’s config (FK cascade), others keep theirs', async () => {
    await save(pea, config('symbol'), aliceCookie);
    await save(pea, config('currency'), bobCookie);
    await save(us, config('sector'), aliceCookie);
    await getDb()
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, pea), eq(spaceMembers.userId, alice)));
    const left = await getDb().select().from(tableConfigs);
    expect(left.map((r) => `${r.userId}:${r.spaceId}`).sort()).toEqual(
      [`${bob}:${pea}`, `${alice}:${us}`].sort(),
    );
    // Re-granting the membership does not resurrect the old view.
    await getDb().insert(spaceMembers).values({ spaceId: pea, userId: alice, role: 'viewer' });
    expect((await get(pea, aliceCookie)).isDefault).toBe(true);
  });

  it('a config cannot exist for a non-member (FK to the membership)', async () => {
    const other = await createSpaceRow('Other', []);
    const insert = getDb()
      .insert(tableConfigs)
      .values({ userId: alice, spaceId: other, version: 1, config: {} });
    await expect(insert).rejects.toSatisfy((e) => pgErrorCode(e) === '23503');
  });

  it('the database bounds the document (CHECK) and the API refuses an oversized save', async () => {
    const huge = { columns: [], pad: 'x'.repeat(20_000) };
    const insert = getDb()
      .insert(tableConfigs)
      .values({ userId: alice, spaceId: pea, version: 1, config: huge });
    await expect(insert).rejects.toSatisfy((e) => pgErrorCode(e) === '23514');
    // 50 sector values of 100 three-byte characters: well-formed filters, but over the save bound.
    const values = Array.from(
      { length: 50 },
      (_, j) => `${'€'.repeat(98)}${String(j).padStart(2, '0')}`,
    );
    const big = config('symbol', { filters: [{ kind: 'in', columnId: 'sector', values }] });
    const res = await save(pea, big, aliceCookie);
    expect(res.status).toBe(400);
    expect(await getDb().select().from(tableConfigs)).toHaveLength(0);
  });

  it('save is strict: unknown column, duplicate, nothing visible, invalid sort, non-filterable filter', async () => {
    const base = defaultTableConfig();
    const bad = async (patch: object) =>
      expect((await save(pea, { ...base, ...patch }, aliceCookie)).status).toBe(400);
    await bad({ columns: [{ id: 'nope', visible: true }] });
    await bad({
      columns: [
        { id: 'name', visible: true },
        { id: 'name', visible: true },
      ],
    });
    await bad({ columns: base.columns.map((c) => ({ ...c, visible: false })) });
    await bad({ sort: { columnId: 'price', direction: 'asc' } });
    await bad({ filters: [{ kind: 'between', columnId: 'net_debt', min: '1' }] });
    await bad({ pageSize: 30 });
    expect(await getDb().select().from(tableConfigs)).toHaveLength(0);
  });
});
