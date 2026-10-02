import {
  INSTRUMENT_TYPE_LABELS,
  SORTABLE_COLUMN_IDS,
  TABLE_COLUMN_IDS,
  type MoneyCell,
  type PerfCell,
  type PositionsListOutput,
  type SortableColumnId,
  type TableCell,
} from '@waddlers/contracts';
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

const NOW = new Date('2026-09-30T12:00:00Z');
const { rpc, loginAs } = createApp({ now: () => NOW });
let cookie: string;
let spaceId: string;
let ids: Record<string, string>;

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
  await seedFx(DEFAULT_FX);
  spaceId = await createSpaceRow('PEA', [{ userId, role: 'viewer' }]);
  const positions = await seedEntries(spaceId, SORT_DATASET, NOW);
  ids = Object.fromEntries(SORT_DATASET.map((s, i) => [s.name, positions[i]!]));
});

async function list(input: Record<string, unknown> = {}) {
  const res = await rpc(
    'positions.list',
    { spaceId, columns: TABLE_COLUMN_IDS, ...input },
    { cookie },
  );
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as unknown as PositionsListOutput;
}
const names = (r: PositionsListOutput) => r.rows.map((x) => x.instrument.name);
const cell = <T extends TableCell>(r: PositionsListOutput['rows'][number], id: string) =>
  r.values[id as keyof typeof r.values] as T;

/** Comparable key of a sort column for a row (null = unavailable). */
function keyOf(
  id: SortableColumnId,
  row: PositionsListOutput['rows'][number],
): string | number | null {
  if (id === 'quantity') return row.quantity === null ? null : Number(row.quantity);
  const v = cell(row, id);
  if (v === null) return null;
  // instrument_type sorts by its French label (Action before ETF), not by the wire id.
  if (id === 'instrument_type') return INSTRUMENT_TYPE_LABELS[v as 'stock' | 'etf'];
  if (typeof v === 'string') return v.toLowerCase();
  if ('value' in v) return v.value === null ? null : Number((v as PerfCell).value);
  return (v as MoneyCell).amount === null ? null : Number((v as MoneyCell).amount);
}

describe.each(SORTABLE_COLUMN_IDS)('sort by %s', (columnId) => {
  it.each(['asc', 'desc'] as const)(
    '%s: monotone, nulls last, stable tiebreak',
    async (direction) => {
      const out = await list({ sort: { columnId, direction } });
      expect(out.rows).toHaveLength(SORT_DATASET.length);
      const keys = out.rows.map((r) => keyOf(columnId, r));
      const firstNull = keys.indexOf(null);
      if (firstNull >= 0) expect(keys.slice(firstNull).every((k) => k === null)).toBe(true);
      const present = keys.slice(0, firstNull < 0 ? undefined : firstNull) as (string | number)[];
      for (let i = 1; i < present.length; i++) {
        const [a, b] = [present[i - 1]!, present[i]!];
        expect(direction === 'asc' ? a <= b : a >= b, `${a} then ${b}`).toBe(true);
      }
      for (let i = 1; i < out.rows.length; i++) {
        if (keys[i - 1] !== keys[i]) continue;
        const [a, b] = [out.rows[i - 1]!, out.rows[i]!];
        const byName = a.instrument.name
          .toLowerCase()
          .localeCompare(b.instrument.name.toLowerCase());
        expect(
          byName < 0 || (byName === 0 && a.id < b.id),
          `${a.instrument.name} / ${b.instrument.name}`,
        ).toBe(true);
      }
      // Same request twice: identical order (deterministic).
      expect((await list({ sort: { columnId, direction } })).rows.map((r) => r.id)).toEqual(
        out.rows.map((r) => r.id),
      );
    },
  );
});

describe('default order and values', () => {
  it('no sort: instrument name case-insensitive, then id', async () => {
    expect(names(await list())).toEqual([
      'Alpha',
      'bravo',
      'Charlie',
      'delta',
      'Echo',
      'foxtrot',
      'Golf',
      'hotel',
    ]);
  });

  it('omitted columns return the default set only (no description unless asked, no quantity: row.quantity)', async () => {
    const res = await rpc('positions.list', { spaceId }, { cookie });
    const out = res.json as unknown as PositionsListOutput;
    expect(Object.keys(out.rows[0]!.values).sort()).toEqual(
      [
        'name',
        'symbol',
        'price_eur',
        'tracked_value_eur',
        'market_cap_eur',
        'sector',
        'dividend_yield',
        'perf_period',
        'perf_1y',
        'perf_5y',
      ].sort(),
    );
  });

  it('watchlist entries are listed with a null quantity and a null tracked value', async () => {
    const out = await list();
    const delta = out.rows.find((r) => r.id === ids.delta)!;
    expect(delta.quantity).toBeNull();
    expect(delta.values).not.toHaveProperty('quantity'); // row.quantity is the single source
    expect(cell<MoneyCell>(delta, 'tracked_value_eur')).toMatchObject({
      amount: null,
      reason: 'watchlist',
    });
    expect(cell<MoneyCell>(delta, 'price_eur').amount).toBe('10');
  });

  it('GBX: local price in pence, EUR price converted, rate in EUR per unit', async () => {
    const echo = (await list()).rows.find((r) => r.id === ids.Echo)!;
    expect(echo.listing).toMatchObject({
      currency: 'GBX',
      currencyMajor: 'GBP',
      minorUnitDivisor: 100,
    });
    expect(cell<MoneyCell>(echo, 'price')).toMatchObject({ amount: '2000', currency: 'GBX' });
    expect(cell<MoneyCell>(echo, 'price_eur')).toMatchObject({ amount: '25', currency: 'EUR' });
    expect(cell(echo, 'fx_rate')).toMatchObject({ eurPerUnit: '0.0125', rateDate: '2026-09-30' });
    expect(cell<MoneyCell>(echo, 'tracked_value_eur').amount).toBe('2500');
  });

  it('ETF: sector not applicable (null, even if a value is stored), pending columns null (specs 24)', async () => {
    const delta = (await list()).rows.find((r) => r.id === ids.delta)!;
    expect(delta.instrument.type).toBe('etf');
    expect(cell(delta, 'sector')).toBeNull();
    for (const id of [
      'market_cap',
      'market_cap_eur',
      'enterprise_value',
      'net_debt',
      'debt_ratio',
      'main_holders',
      'dividend_yield',
    ]) {
      expect(cell(delta, id), id).toBeNull();
    }
    expect(cell<PerfCell>(delta, 'perf_1y')).toMatchObject({
      value: null,
      reason: 'history_too_short',
    });
  });

  it('unavailable is null with a reason, never zero (no price, no metrics row)', async () => {
    const out = await list();
    const fox = out.rows.find((r) => r.id === ids.foxtrot)!;
    expect(cell<MoneyCell>(fox, 'price')).toMatchObject({ amount: null, reason: 'price_missing' });
    expect(cell<MoneyCell>(fox, 'tracked_value_eur').amount).toBeNull();
    expect(fox.quantity).toBe('0'); // a real zero quantity stays 0
    const golf = out.rows.find((r) => r.id === ids.Golf)!;
    expect(cell<MoneyCell>(golf, 'price_eur')).toMatchObject({
      amount: null,
      reason: 'metrics_missing',
    });
    expect(cell(golf, 'price_date')).toBeNull();
  });

  it('stale flag: price older than 5 days is stale, a current one is not', async () => {
    const out = await list();
    expect(
      cell<MoneyCell>(
        out.rows.find((r) => r.id === ids.hotel)!,
        'price',
      ).isStale,
    ).toBe(true);
    expect(
      cell<MoneyCell>(
        out.rows.find((r) => r.id === ids.Alpha)!,
        'price',
      ).isStale,
    ).toBe(false);
    expect(
      cell<PerfCell>(
        out.rows.find((r) => r.id === ids.hotel)!,
        'perf_1y',
      ).isStale,
    ).toBe(true);
  });

  it('computedAt is the newest computed_at of the matching rows, oldestComputedAt the oldest, null when none has metrics', async () => {
    const all = await list();
    expect(all.computedAt).toBe('2026-09-30T12:00:00.000Z');
    expect(all.oldestComputedAt).toBe('2026-09-30T08:00:00.000Z'); // Alpha
    expect(all).not.toHaveProperty('asOf'); // renamed (S6 review F7)
    expect(await list({ search: 'alpha' })).toMatchObject({
      computedAt: '2026-09-30T08:00:00.000Z',
      oldestComputedAt: '2026-09-30T08:00:00.000Z',
    });
    // hotel (11:00) is the oldest once Alpha is out of the match; Golf has no metrics row.
    expect(await list({ search: 'tech' })).toMatchObject({
      computedAt: '2026-09-30T12:00:00.000Z',
      oldestComputedAt: '2026-09-30T11:00:00.000Z',
    });
    expect(await list({ search: 'GGG' })).toMatchObject({
      computedAt: null,
      oldestComputedAt: null,
    });
  });
});

describe('perf_period follows the period', () => {
  it.each(['1w', '1m', '6m', '1y', '5y', 'max'] as const)('period %s', async (period) => {
    const column = `perf_${period}` as SortableColumnId;
    const viaPeriod = await list({ period, sort: { columnId: 'perf_period', direction: 'desc' } });
    const direct = await list({ sort: { columnId: column, direction: 'desc' } });
    expect(viaPeriod.period).toBe(period);
    expect(viaPeriod.rows.map((r) => r.id)).toEqual(direct.rows.map((r) => r.id));
    for (const r of viaPeriod.rows) expect(cell(r, 'perf_period')).toEqual(cell(r, column));
  });

  it('defaults to 1m and says so', async () => {
    const out = await list();
    expect(out.period).toBe('1m');
    expect(
      cell<PerfCell>(
        out.rows.find((r) => r.id === ids.Alpha)!,
        'perf_period',
      ).value,
    ).toBe('2');
  });
});

describe('pagination', () => {
  it.each([
    [{ columnId: 'sector', direction: 'asc' }],
    [{ columnId: 'perf_1y', direction: 'desc' }],
    [{ columnId: 'price_eur', direction: 'asc' }],
    [undefined],
  ] as const)(
    'pages of 3 under sort %j: no duplicate, no gap, consistent total/hasMore',
    async (sort) => {
      const whole = await list({ ...(sort ? { sort } : {}), page: { offset: 0, limit: 200 } });
      expect(whole.hasMore).toBe(false);
      const seen: string[] = [];
      for (let offset = 0; ; offset += 3) {
        const page = await list({ ...(sort ? { sort } : {}), page: { offset, limit: 3 } });
        expect(page.total).toBe(SORT_DATASET.length);
        expect(page.hasMore).toBe(offset + page.rows.length < page.total);
        seen.push(...page.rows.map((r) => r.id));
        if (!page.hasMore) break;
      }
      expect(seen).toEqual(whole.rows.map((r) => r.id));
      expect(new Set(seen).size).toBe(SORT_DATASET.length);
    },
  );

  it('total is the filtered count; an offset past the end is empty, not an error', async () => {
    const hit = await list({ search: 'finance', page: { offset: 0, limit: 1 } });
    expect(hit).toMatchObject({ total: 2, hasMore: true });
    const past = await list({ page: { offset: 500, limit: 10 } });
    expect(past).toMatchObject({ rows: [], total: SORT_DATASET.length, hasMore: false });
  });

  it('the old simple call (no page, no sort) still returns the S3 fields', async () => {
    const res = await rpc('positions.list', { spaceId }, { cookie });
    const out = res.json as unknown as PositionsListOutput;
    expect(out.rows).toHaveLength(8);
    expect(out.rows[0]).toMatchObject({
      quantity: '10',
      selectionReason: 'Place principale',
      instrument: { name: 'Alpha', type: 'stock', isin: 'FR0000120073' },
      listing: {
        symbol: 'AAA',
        currency: 'EUR',
        exchange: { mic: 'XPAR', name: 'Euronext Paris' },
      },
    });
    expect(out).toMatchObject({ total: 8, hasMore: false });
  });
});
