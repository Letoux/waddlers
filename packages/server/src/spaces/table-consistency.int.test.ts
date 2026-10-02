import type {
  DashboardSummaryOutput,
  MoneyCell,
  PositionsListOutput,
  TableColumnId,
} from '@waddlers/contracts';
import { Decimal } from '@waddlers/domain';
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
import { ensureExchanges, seedEntries, seedFx, type EntrySpec } from '../../test/table-fixtures';

/**
 * D25: the table's Cours EUR / Valeur suivie use exactly the dashboard's current rule, so
 * sum(Valeur suivie, non-null rows) = dashboard total and the null rows = missing + watchlist.
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

const ENTRIES: EntrySpec[] = [
  { name: 'Eur Co', symbol: 'EUR1', quantity: '10', metrics: { price: '50.25' } },
  // The USD listing lags by a holiday day: its price is dated 09-29, spaceAsOf is 09-30.
  {
    name: 'Usd Co',
    symbol: 'USD1',
    mic: 'XNAS',
    currency: 'USD',
    quantity: '3',
    metrics: { price: '200.10', asOfDate: '2026-09-29' },
  },
  {
    name: 'Gbx Co',
    symbol: 'GBX1',
    mic: 'XLON',
    currency: 'GBX',
    quantity: '100',
    metrics: { price: '2000', asOfDate: '2026-09-30' },
  },
  // Held but no rate for the currency (CHF) -> missing (fx_missing).
  { name: 'Chf Co', symbol: 'CHF1', currency: 'CHF', quantity: '4', metrics: { price: '10' } },
  { name: 'No Price', symbol: 'NOP1', quantity: '2', metrics: { price: null } },
  { name: 'No Metrics', symbol: 'NOM1', quantity: '2', metrics: false },
  { name: 'Zero Qty', symbol: 'ZER1', quantity: '0', metrics: { price: '80' } },
  // Watchlist entries: priced, but never part of the value.
  { name: 'Watch Eur', symbol: 'WAT1', quantity: null, metrics: { price: '30' } },
  {
    name: 'Watch Usd',
    symbol: 'WAT2',
    mic: 'XNAS',
    currency: 'USD',
    quantity: null,
    metrics: { price: '125' },
  },
];

beforeEach(async () => {
  await resetAuthTables();
  const userId = (await createUser(getDb(), { username: 'alice', password: PASSWORD })).id;
  cookie = await loginAs('alice');
  await ensureExchanges();
  await seedFx([
    // USD: the newest rate dated <= spaceAsOf (09-30) wins; the 10-01 one is in the future,
    // the 09-12 one is older than the window.
    { currency: 'USD', rate: '1.5', date: '2026-09-12' },
    { currency: 'USD', rate: '1.2', date: '2026-09-25' },
    { currency: 'USD', rate: '1.25', date: '2026-09-28' },
    { currency: 'USD', rate: '9', date: '2026-10-01' },
    { currency: 'GBP', rate: '0.8', date: '2026-09-30' },
  ]);
  spaceId = await createSpaceRow('PEA', [{ userId, role: 'viewer' }]);
  await seedEntries(spaceId, ENTRIES, NOW);
});

async function table(columns: TableColumnId[] = ['tracked_value_eur', 'price_eur']) {
  const res = await rpc('positions.list', { spaceId, columns }, { cookie });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as unknown as PositionsListOutput;
}

describe('D25 table vs dashboard', () => {
  it('sum of Valeur suivie = dashboard total, null rows = missing + watchlist', async () => {
    const summaryRes = await rpc('dashboard.summary', { spaceId, period: '1m' }, { cookie });
    expect(summaryRes.status).toBe(200);
    const summary = summaryRes.json as unknown as DashboardSummaryOutput;
    const out = await table();

    const tracked = (r: PositionsListOutput['rows'][number]) =>
      r.values.tracked_value_eur as MoneyCell;
    const sum = out.rows
      .map((r) => tracked(r).amount)
      .filter((a): a is string => a !== null)
      .reduce((acc, a) => acc.plus(a), new Decimal(0));
    // Hand-computed: 10 x 50.25 + 3 x 200.10 / 1.25 + 100 x 2000 / 100 / 0.8 + 0 = 502.5 + 480.24 + 2500
    expect(sum.toFixed()).toBe('3482.74');
    expect(summary.total.amount).toBe(sum.toFixed());

    const nullIds = out.rows.filter((r) => tracked(r).amount === null).map((r) => r.id);
    const names = (ids: string[]) =>
      ids.map((id) => out.rows.find((r) => r.id === id)!.instrument.name).sort();
    expect(names(nullIds)).toEqual(
      [
        ...summary.missing.map((m) => m.name),
        ...out.rows.filter((r) => r.quantity === null).map((r) => r.instrument.name),
      ].sort(),
    );
    expect(summary.missing.map((m) => m.name).sort()).toEqual(['Chf Co', 'No Metrics', 'No Price']);
    expect(summary.watchlistCount).toBe(2);
  });

  it('Cours EUR is the same conversion, quantity-free (watchlist rows included)', async () => {
    const out = await table();
    const eur = (name: string) =>
      (out.rows.find((r) => r.instrument.name === name)!.values.price_eur as MoneyCell).amount;
    expect(eur('Eur Co')).toBe('50.25');
    expect(eur('Usd Co')).toBe('160.08'); // 200.10 / 1.25 (rate of 09-28, not the 09-12 or 10-01 ones)
    expect(eur('Gbx Co')).toBe('25'); // 2000 pence / 100 / 0.8
    expect(eur('Watch Usd')).toBe('100'); // a watchlist row uses the same window
    expect(eur('Chf Co')).toBeNull();
    const chf = out.rows.find((r) => r.instrument.name === 'Chf Co')!.values.price_eur as MoneyCell;
    expect(chf.reason).toBe('fx_missing');
  });

  it('a rate older than the 7-day window is no rate (never reused, never 1)', async () => {
    await seedFx([{ currency: 'USD', rate: '1.5', date: '2026-09-22' }]); // 8 days before 09-30
    const out = await table(['price_eur', 'fx_rate']);
    const usd = out.rows.find((r) => r.instrument.name === 'Usd Co')!;
    expect(usd.values.price_eur).toMatchObject({ amount: null, reason: 'fx_missing' });
    expect(usd.values.fx_rate).toMatchObject({ eurPerUnit: null });
  });
});
