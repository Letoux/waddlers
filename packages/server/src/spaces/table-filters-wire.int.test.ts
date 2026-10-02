import type { Filter, PositionsListOutput } from '@waddlers/contracts';
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
import { DEFAULT_FX, ensureExchanges, seedEntries, seedFx } from '../../test/table-fixtures';

/**
 * Filters compare the WIRE value (8 decimals, half-even: what the cell shows), and a EUR price that
 * rounds to zero is unavailable (review P3-3). Also `computedAt` under filters (review P3-8).
 */

const NOW = new Date('2026-09-30T12:00:00Z');
const { rpc, loginAs } = createApp({ now: () => NOW });
let cookie: string;
let spaceId: string;

beforeAll(useTestEnv);
afterAll(async () => {
  await resetAuthTables();
  await releaseTestEnv();
});
beforeEach(async () => {
  await resetAuthTables();
  const userId = (await createUser(getDb(), { username: 'alice', password: PASSWORD })).id;
  cookie = await loginAs('alice');
  await ensureExchanges();
  await seedFx([...DEFAULT_FX, { currency: 'CHF', rate: '3', date: '2026-09-30' }]);
  spaceId = await createSpaceRow('PEA', [{ userId, role: 'viewer' }]);
});

async function list(extra: Record<string, unknown>): Promise<PositionsListOutput> {
  const res = await rpc('positions.list', { spaceId, ...extra }, { cookie });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as unknown as PositionsListOutput;
}
const between = (columnId: string, min?: string, max?: string): Filter =>
  ({ kind: 'between', columnId, ...(min ? { min } : {}), ...(max ? { max } : {}) }) as Filter;
const names = async (filters: Filter[]) =>
  (await list({ filters })).rows.map((r) => r.instrument.name).sort();

describe('wire-value comparison (documented: the filter sees the number the cell shows)', () => {
  it('9.996 EUR with a minimum of 10 is excluded; a maximum of 9.996 includes it (exact, no rounding to 2 decimals)', async () => {
    await seedEntries(spaceId, [{ name: 'P', symbol: 'P', metrics: { price: '9.996' } }], NOW);
    expect(await names([between('price_eur', '10')])).toEqual([]);
    expect(await names([between('price_eur', undefined, '9.996')])).toEqual(['P']);
    expect(await names([between('price_eur', '9.996', '9.996')])).toEqual(['P']);
  });

  it('a value that ROUNDS to the bound at wire scale matches it (29.99999999 CHF / 3 shows 10)', async () => {
    await seedEntries(
      spaceId,
      [{ name: 'R', symbol: 'R', currency: 'CHF', metrics: { price: '29.99999999' } }],
      NOW,
    );
    const out = await list({ columns: ['price_eur'] });
    expect(out.rows[0]?.values.price_eur).toMatchObject({ amount: '10' });
    expect(await names([between('price_eur', '10', '10')])).toEqual(['R']);
  });

  it('half-even ties follow the cell: 0.5 x 0.00000001 EUR shows 0 (even), so min 0.00000001 excludes it', async () => {
    await seedEntries(
      spaceId,
      [{ name: 'T', symbol: 'T', quantity: '0.5', metrics: { price: '0.00000001' } }],
      NOW,
    );
    const out = await list({ columns: ['tracked_value_eur'] });
    expect(out.rows[0]?.values.tracked_value_eur).toMatchObject({ amount: '0' });
    expect(await names([between('tracked_value_eur', '0.00000001')])).toEqual([]);
    // A displayed 0 is a real 0 for the tracked value (not an unavailable one).
    expect(await names([between('tracked_value_eur', '0', '0')])).toEqual(['T']);
  });
});

describe('a EUR price that rounds to zero is unavailable (rounds_to_zero cell)', () => {
  it('is excluded by every price_eur filter, even a range that contains 0', async () => {
    await seedEntries(
      spaceId,
      [
        { name: 'Tiny', symbol: 'TINY', currency: 'CHF', metrics: { price: '0.00000001' } },
        { name: 'Normal', symbol: 'NRM', metrics: { price: '5' } },
      ],
      NOW,
    );
    const out = await list({ columns: ['price_eur'] });
    const tiny = out.rows.find((r) => r.instrument.name === 'Tiny');
    expect(tiny?.values.price_eur).toMatchObject({ amount: null, reason: 'rounds_to_zero' });
    expect(await names([between('price_eur', '0')])).toEqual(['Normal']);
    expect(await names([between('price_eur', '-1', '1')])).toEqual([]);
    expect(await names([between('price_eur', undefined, '100')])).toEqual(['Normal']);
  });
});

describe('computedAt / oldestComputedAt under filters (review P3-8)', () => {
  it('describe the MATCHING rows only', async () => {
    const t = (iso: string) => new Date(iso);
    await seedEntries(
      spaceId,
      [
        {
          name: 'Old',
          symbol: 'OLD',
          sector: 'Energie',
          metrics: { computedAt: t('2026-09-01T00:00:00Z') },
        },
        {
          name: 'Mid',
          symbol: 'MID',
          sector: 'Finance',
          metrics: { computedAt: t('2026-09-15T00:00:00Z') },
        },
        {
          name: 'New',
          symbol: 'NEW',
          sector: 'Finance',
          metrics: { computedAt: t('2026-09-29T00:00:00Z') },
        },
      ],
      NOW,
    );
    const all = await list({});
    expect([all.oldestComputedAt, all.computedAt]).toEqual([
      '2026-09-01T00:00:00.000Z',
      '2026-09-29T00:00:00.000Z',
    ]);
    const finance = await list({
      filters: [{ kind: 'in', columnId: 'sector', values: ['Finance'] }],
    });
    expect([finance.oldestComputedAt, finance.computedAt]).toEqual([
      '2026-09-15T00:00:00.000Z',
      '2026-09-29T00:00:00.000Z',
    ]);
    const none = await list({ filters: [{ kind: 'in', columnId: 'sector', values: ['Santé'] }] });
    expect([none.total, none.computedAt, none.oldestComputedAt]).toEqual([0, null, null]);
  });
});

describe('a filter on a column absent from `columns` (review P3-8)', () => {
  it('still applies: filters and displayed columns are independent', async () => {
    await seedEntries(
      spaceId,
      [
        { name: 'A', symbol: 'A', metrics: { price: '5', perf: { '1y': '20' } } },
        { name: 'B', symbol: 'B', metrics: { price: '5', perf: { '1y': '1' } } },
      ],
      NOW,
    );
    const out = await list({ columns: ['name'], filters: [between('perf_1y', '10')] });
    expect(out.rows.map((r) => r.instrument.name)).toEqual(['A']);
    expect(out.total).toBe(1);
    expect(Object.keys(out.rows[0]?.values ?? {})).toEqual(['name']);
  });
});
