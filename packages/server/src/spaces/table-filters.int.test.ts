import type { Filter, PositionsFacetsOutput, PositionsListOutput } from '@waddlers/contracts';
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
} from '../../test/table-fixtures';

/**
 * SORT_DATASET reminder (prices in EUR unless said): Alpha 50 (stock, Energie, XPAR, qty 10),
 * bravo 50 (Energie, XPAR, qty 5), Charlie 200 USD = 160 (Finance, XNAS, qty 2), delta 10 (ETF,
 * qty null), Echo 2000 GBX = 25 (Finance, XLON, qty 100), foxtrot (USD, no price, qty 0), Golf (no
 * metrics at all), hotel 80 (Technologie, XPAR, qty 7.5). perf 1y: 10.5, 10.5, -3.2, null, 40,
 * null, null, 10.5. Tracked value EUR: 500, 250, 320, null, 2500, null, null, 600.
 */

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
  spaceId = await createSpaceRow('PEA', [{ userId, role: 'viewer' }]);
  await seedEntries(spaceId, SORT_DATASET, NOW);
});

async function list(extra: Record<string, unknown>, id = spaceId): Promise<PositionsListOutput> {
  const res = await rpc('positions.list', { spaceId: id, ...extra }, { cookie });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as unknown as PositionsListOutput;
}
const names = (o: PositionsListOutput) => o.rows.map((r) => r.instrument.name).sort();
async function found(filters: Filter[], extra: Record<string, unknown> = {}) {
  const out = await list({ filters, ...extra });
  expect(out.total, 'total reflects the filters').toBe(out.rows.length);
  return names(out);
}
const between = (columnId: string, min?: string, max?: string): Filter =>
  ({ kind: 'between', columnId, ...(min ? { min } : {}), ...(max ? { max } : {}) }) as Filter;
const within = (columnId: string, ...values: string[]): Filter =>
  ({ kind: 'in', columnId, values }) as Filter;

describe('each filterable column', () => {
  it.each([
    ['instrument_type etf', within('instrument_type', 'etf'), ['delta']],
    ['sector', within('sector', 'Technologie'), ['foxtrot', 'hotel']],
    [
      'sector, two values',
      within('sector', 'Technologie', 'Energie'),
      ['Alpha', 'bravo', 'foxtrot', 'hotel'],
    ],
    ['currency GBP covers a GBX listing (D28)', within('currency', 'GBP'), ['Echo']],
    ['currency USD', within('currency', 'USD'), ['Charlie', 'foxtrot']],
    ['exchange by MIC', within('exchange', 'XNAS'), ['Charlie', 'foxtrot']],
    ['perf_1w', between('perf_1w', '2', '5'), ['Charlie', 'Echo', 'hotel']],
    ['perf_1m', between('perf_1m', undefined, '0'), ['bravo', 'Echo']],
    ['perf_6m', between('perf_6m', '4'), ['bravo', 'hotel']],
    ['perf_1y', between('perf_1y', '10'), ['Alpha', 'Echo', 'bravo', 'hotel']],
    ['perf_5y', between('perf_5y', '20', '21'), ['Alpha', 'bravo']],
    ['perf_max', between('perf_max', '50'), ['Echo']],
    ['price_eur', between('price_eur', '30', '100'), ['Alpha', 'bravo', 'hotel']],
    [
      'tracked_value_eur',
      between('tracked_value_eur', '300', '600'),
      ['Alpha', 'Charlie', 'hotel'],
    ],
  ])('%s', async (_name, filter, expected) => {
    expect(await found([filter])).toEqual([...expected].sort());
  });

  it('a sector filter never matches an ETF (sector is not applicable to it, specs 24)', async () => {
    expect(await found([within('sector', 'Finance')])).toEqual(['Charlie', 'Echo']);
  });

  it('the raw spelling is not a filter value: GBX is well-formed but matches nothing (D28)', async () => {
    expect(await found([within('currency', 'GBX')])).toEqual([]);
  });

  it('perf_period follows the requested period', async () => {
    const f = [between('perf_period', '10')];
    expect(await found(f, { period: '1y' })).toEqual(['Alpha', 'Echo', 'bravo', 'hotel']);
    expect(await found(f, { period: '1w' })).toEqual([]);
    expect(await found(f, { period: 'max' })).toEqual(['Alpha', 'Echo', 'bravo', 'hotel']);
  });
});

describe('combination, nulls, units', () => {
  it('filters combine with AND', async () => {
    expect(
      await found([
        within('instrument_type', 'stock'),
        within('exchange', 'XPAR'),
        between('perf_1y', '10'),
      ]),
    ).toEqual(['Alpha', 'bravo', 'hotel']);
    expect(
      await found([
        within('exchange', 'XPAR'),
        between('perf_1y', '10'),
        between('price_eur', '60'),
      ]),
    ).toEqual(['hotel']);
    expect(await found([within('sector', 'Energie'), within('currency', 'USD')])).toEqual([]);
  });

  it('a null value never matches `between`: unavailable rows are excluded, not read as 0', async () => {
    // perf_6m: delta has none, foxtrot has no price, Golf has no metrics row at all.
    expect(await found([between('perf_6m', undefined, '100')])).toEqual([
      'Alpha',
      'Charlie',
      'Echo',
      'bravo',
      'hotel',
    ]);
    // A range containing 0 must not match the unavailable rows either.
    expect(await found([between('perf_1y', '-100', '100')])).toEqual([
      'Alpha',
      'Charlie',
      'Echo',
      'bravo',
      'hotel',
    ]);
    // Watchlist (delta), foxtrot (no price) and Golf (no metrics) have no tracked value.
    expect(await found([between('tracked_value_eur', '0')])).toEqual([
      'Alpha',
      'Charlie',
      'Echo',
      'bravo',
      'hotel',
    ]);
  });

  it('percent filters take percent units (10 means 10 %), bounds inclusive', async () => {
    expect(await found([between('perf_1y', '10.5', '10.5')])).toEqual(['Alpha', 'bravo', 'hotel']);
    expect(await found([between('perf_1y', '0.105')])).toEqual(['Alpha', 'Echo', 'bravo', 'hotel']);
    expect(await found([between('perf_1y', '10.51', '39.99')])).toEqual([]);
    expect(await found([between('perf_1y', '-3.2', '-3.2')])).toEqual(['Charlie']);
  });

  it('price_eur ranges are on the converted value: GBX pence, USD rate', async () => {
    expect(await found([between('price_eur', '25', '25')])).toEqual(['Echo']); // 2000 GBX / 100 / 0.8
    expect(await found([between('price_eur', '24.99', '25.01')])).toEqual(['Echo']);
    expect(await found([between('price_eur', '150', '170')])).toEqual(['Charlie']); // 200 USD / 1.25
    // The raw GBX number (2000) is NOT what the filter sees.
    expect(await found([between('price_eur', '1000')])).toEqual([]);
  });

  it('without an FX rate the EUR price is unavailable, so the row is excluded (never guessed)', async () => {
    await seedFx([]);
    expect(await found([between('price_eur', '0')])).toEqual(['Alpha', 'bravo', 'delta', 'hotel']);
    expect(await found([between('tracked_value_eur', '0')])).toEqual(['Alpha', 'bravo', 'hotel']);
  });
});

describe('total, pagination, search and sort with filters', () => {
  it('total counts every match, pages slice them', async () => {
    const filters = [between('perf_1y', '10')];
    const sort = { columnId: 'name', direction: 'asc' } as const;
    const p1 = await list({ filters, sort, page: { offset: 0, limit: 3 } });
    expect(p1).toMatchObject({ total: 4, hasMore: true });
    expect(p1.rows.map((r) => r.instrument.name)).toEqual(['Alpha', 'bravo', 'Echo']);
    const p2 = await list({ filters, sort, page: { offset: 3, limit: 3 } });
    expect(p2).toMatchObject({ total: 4, hasMore: false });
    expect(p2.rows.map((r) => r.instrument.name)).toEqual(['hotel']);
    expect((await list({ filters, page: { offset: 4, limit: 3 } })).rows).toEqual([]);
  });

  it('composes with search and sort', async () => {
    const out = await list({
      filters: [between('perf_1y', '10')],
      search: 'xpar',
      sort: { columnId: 'price_eur', direction: 'desc' },
    });
    expect(out.total).toBe(3);
    expect(out.rows.map((r) => r.instrument.name)).toEqual(['hotel', 'Alpha', 'bravo']);
  });

  it('no filters, an empty list, or a filter that matches nothing behave as documented', async () => {
    expect((await list({})).total).toBe(SORT_DATASET.length);
    expect((await list({ filters: [] })).total).toBe(SORT_DATASET.length);
    expect(await list({ filters: [between('perf_1y', '1000')] })).toMatchObject({
      total: 0,
      rows: [],
      hasMore: false,
    });
  });
});

describe('input validation (BAD_REQUEST)', () => {
  const bad = async (filters: unknown[]) => {
    const res = await rpc('positions.list', { spaceId, filters }, { cookie });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(res.json.code).toBe('BAD_REQUEST');
  };
  it('refuses min > max, a pending fundamental, an unknown column and exponent bounds', async () => {
    await bad([between('perf_1y', '10', '5')]);
    await bad([{ kind: 'between', columnId: 'dividend_yield', min: '1' }]);
    await bad([{ kind: 'between', columnId: 'market_cap_eur', min: '1' }]);
    await bad([{ kind: 'between', columnId: 'nope', min: '1' }]);
    await bad([{ kind: 'between', columnId: 'perf_1y', min: '1e3' }]);
    await bad([{ kind: 'in', columnId: 'currency', values: ['eur'] }]);
    await bad([between('perf_1y', '1'), between('perf_1y', '2')]);
  });
});

describe('positions.facets', () => {
  it('lists the distinct values with counts, over the whole space', async () => {
    const res = await rpc('positions.facets', { spaceId }, { cookie });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const f = res.json as unknown as PositionsFacetsOutput;
    expect(f.instrument_type).toEqual([
      { value: 'stock', label: 'Action', count: 7 },
      { value: 'etf', label: 'ETF', count: 1 },
    ]);
    // delta (ETF) and Golf have no sector: they are not a facet value.
    expect(f.sector).toEqual([
      { value: 'Energie', label: 'Energie', count: 2 },
      { value: 'Finance', label: 'Finance', count: 2 },
      { value: 'Technologie', label: 'Technologie', count: 2 },
    ]);
    expect(f.currency).toEqual([
      { value: 'EUR', label: 'EUR', count: 5 },
      { value: 'USD', label: 'USD', count: 2 },
      { value: 'GBP', label: 'GBP (cotations en pence incluses)', count: 1 },
    ]);
    expect(f.exchange).toEqual([
      { value: 'XPAR', label: 'Euronext Paris', count: 5 },
      { value: 'XNAS', label: 'Nasdaq', count: 2 },
      { value: 'XLON', label: 'London Stock Exchange', count: 1 },
    ]);
  });

  it('is scoped to the authorized space: another space never leaks in', async () => {
    const other = await createSpaceRow('Actions US', [{ userId, role: 'viewer' }]);
    const foreign = await createSpaceRow('Foreign', []);
    await seedEntries(
      other,
      [{ name: 'Zed', symbol: 'ZED', sector: 'Santé', mic: 'XNAS', currency: 'USD' }],
      NOW,
    );
    await seedEntries(
      foreign,
      [{ name: 'Secret', symbol: 'SEC', sector: 'Secret sector', mic: 'XLON', currency: 'GBX' }],
      NOW,
    );
    const res = await rpc('positions.facets', { spaceId: other }, { cookie });
    const f = res.json as unknown as PositionsFacetsOutput;
    expect(f.sector).toEqual([{ value: 'Santé', label: 'Santé', count: 1 }]);
    expect(f.currency).toEqual([{ value: 'USD', label: 'USD', count: 1 }]);
    expect(JSON.stringify(f)).not.toContain('Secret');
    const denied = await rpc('positions.facets', { spaceId: foreign }, { cookie });
    expect(denied.status).toBe(404);
  });
});
