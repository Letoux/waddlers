import type { PositionsFacetsOutput } from '@waddlers/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../admin';
import { getDb } from '../db/client';
import {
  createApp,
  PASSWORD,
  releaseTestEnv,
  resetAuthTables,
  useTestEnv,
} from '../../test/auth-harness';
import { createSpaceRow } from '../../test/space-fixtures';
import {
  DEFAULT_FX,
  ensureExchanges,
  SORT_DATASET,
  seedEntries,
  seedFx,
  type EntrySpec,
} from '../../test/table-fixtures';

/** Facets (S7) and their contract with the `in` filters: D28 (major currency), truncation, staleness. */

const NOW = new Date('2026-09-30T12:00:00Z');
const { rpc, loginAs } = createApp({ now: () => NOW });
let cookie: string;
let userId: string;
let spaceId: string;

beforeAll(useTestEnv);
afterAll(async () => {
  await resetAuthTables();
  await releaseTestEnv();
});
beforeEach(async () => {
  await resetAuthTables();
  userId = (await createUser(getDb(), { username: 'alice', password: PASSWORD })).id;
  cookie = await loginAs('alice');
  await ensureExchanges();
  await seedFx(DEFAULT_FX);
  spaceId = await createSpaceRow('PEA', [{ userId, role: 'editor' }]);
});

const facets = async (id = spaceId) => {
  const res = await rpc('positions.facets', { spaceId: id }, { cookie });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as unknown as PositionsFacetsOutput;
};
const COLUMNS = ['instrument_type', 'sector', 'currency', 'exchange'] as const;

const MINOR: EntrySpec[] = [
  { name: 'M1', symbol: 'M1', currency: 'GBX', mic: 'XLON', sector: 'Energie' },
  { name: 'M2', symbol: 'M2', currency: 'GBp', mic: 'XLON', sector: 'Energie' },
  { name: 'M3', symbol: 'M3', currency: 'GBP', mic: 'XLON', sector: 'Finance' },
  { name: 'M4', symbol: 'M4', currency: 'ZAc', mic: 'XLON', sector: 'Finance' },
  { name: 'M5', symbol: 'M5', currency: 'USD', mic: 'XNAS', sector: 'Finance' },
];

describe('facets and filters agree (D28)', () => {
  it('currency facets group the major currency; the label says when pence are included', async () => {
    await seedEntries(spaceId, MINOR, NOW);
    expect((await facets()).currency).toEqual([
      { value: 'GBP', label: 'GBP (cotations en pence incluses)', count: 3 },
      { value: 'USD', label: 'USD', count: 1 },
      { value: 'ZAR', label: 'ZAR (cotations en pence incluses)', count: 1 },
    ]);
  });

  it.each([
    ['the dataset', SORT_DATASET],
    ['GBX, GBp and ZAc listings', [...SORT_DATASET, ...MINOR]],
  ])(
    'every value of every facet, sent back as an `in` filter, returns exactly its count (%s)',
    async (_n, specs) => {
      await seedEntries(spaceId, specs, NOW);
      const f = await facets();
      let checked = 0;
      for (const columnId of COLUMNS) {
        for (const { value, count } of f[columnId]) {
          const res = await rpc(
            'positions.list',
            { spaceId, filters: [{ kind: 'in', columnId, values: [value] }] },
            { cookie },
          );
          expect(res.status, `${columnId}=${value}: ${JSON.stringify(res.json)}`).toBe(200);
          expect((res.json as { total: number }).total, `${columnId}=${value}`).toBe(count);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(8);
    },
  );

  it('the major currency facet value and the search agree: GBP finds the pence listings too', async () => {
    await seedEntries(spaceId, MINOR, NOW);
    const res = await rpc('positions.list', { spaceId, search: 'GBP' }, { cookie });
    expect((res.json as { total: number }).total).toBe(3);
  });
});

describe('truncation and stale filter values', () => {
  it('reports truncated per facet when a list is cut at 200 values', async () => {
    const many: EntrySpec[] = Array.from({ length: 201 }, (_, i) => ({
      name: `S${i}`,
      symbol: `S${i}`,
      sector: `Sector ${String(i).padStart(3, '0')}`,
      metrics: false,
    }));
    await seedEntries(spaceId, many, NOW);
    const f = await facets();
    expect(f.sector).toHaveLength(200);
    expect(f.truncated).toEqual({
      instrument_type: false,
      sector: true,
      currency: false,
      exchange: false,
    });
  });

  it('a filter on a value that vanished: facets drop it, list answers 0 (the UI merges active values)', async () => {
    const [positionId] = await seedEntries(
      spaceId,
      [{ name: 'Only', symbol: 'ONL', sector: 'Santé' }],
      NOW,
    );
    expect((await facets()).sector).toEqual([{ value: 'Santé', label: 'Santé', count: 1 }]);
    const save = await rpc(
      'tableConfig.save',
      {
        spaceId,
        config: {
          columns: [{ id: 'name', visible: true }],
          filters: [{ kind: 'in', columnId: 'sector', values: ['Santé'] }],
        },
      },
      { cookie },
    );
    expect(save.status, JSON.stringify(save.json)).toBe(200);
    const rm = await rpc('positions.remove', { spaceId, positionId }, { cookie });
    expect(rm.status).toBe(200);
    expect((await facets()).sector).toEqual([]);
    const got = await rpc('tableConfig.get', { spaceId }, { cookie });
    const filters = (got.json as { config: { filters: unknown[] } }).config.filters;
    expect(filters).toHaveLength(1);
    const list = await rpc('positions.list', { spaceId, filters }, { cookie });
    expect(list.json).toMatchObject({ total: 0, rows: [] });
  });

  it('facets follow add and remove; a quantity change does not alter them', async () => {
    const [a] = await seedEntries(spaceId, [{ name: 'A', symbol: 'A', sector: 'Energie' }], NOW);
    const before = await facets();
    const q = await rpc(
      'positions.setQuantity',
      { spaceId, positionId: a, quantity: '42' },
      { cookie },
    );
    expect(q.status, JSON.stringify(q.json)).toBe(200);
    expect(await facets()).toEqual(before);
    await seedEntries(spaceId, [{ name: 'B', symbol: 'B', sector: 'Energie' }], NOW);
    expect((await facets()).sector).toEqual([{ value: 'Energie', label: 'Energie', count: 2 }]);
    await rpc('positions.remove', { spaceId, positionId: a }, { cookie });
    expect((await facets()).sector).toEqual([{ value: 'Energie', label: 'Energie', count: 1 }]);
  });
});
