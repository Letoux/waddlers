import type { DashboardHistoryOutput, DashboardSummaryOutput } from '@waddlers/contracts';
import { Decimal } from '@waddlers/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../admin';
import { getDb } from '../db/client';
import { recomputeListingMetrics } from '../market-data/metrics';
import { recordSuccess, upsertBars, upsertFxRates, upsertQuotes } from '../market-data/repository';
import { createApp, PASSWORD, releaseTestEnv, useTestEnv } from '../../test/auth-harness';
import { resetMarketTables, testConfig } from '../../test/market-fixtures';
import { createPositionRow, createSpaceRow, ensureReferenceData } from '../../test/space-fixtures';
import { DashboardLimiter } from './limiter';

/** D23 end to end: the value card delta describes the same value as the total. */

const NOW = new Date('2026-09-30T12:00:00Z');
const { rpc, loginAs } = createApp({
  now: () => NOW,
  dashboardLimiter: new DashboardLimiter({ maxConcurrent: 50, ratePerMinute: 100_000 }),
});

beforeAll(useTestEnv);
afterAll(releaseTestEnv);

let ref: Awaited<ReturnType<typeof ensureReferenceData>>;
let cookie: string;
let spaceId: string;

async function bars(listingId: string, currency: string, rows: [string, string][]) {
  await upsertBars(
    getDb(),
    { id: listingId, currency },
    rows.map(([date, close]) => ({ date, close, adjClose: null })),
    { source: 'fake', fetchedAt: NOW },
  );
  await recordSuccess(getDb(), listingId, 'history', NOW, { historyCompleteFrom: rows[0]![0] });
}

beforeEach(async () => {
  await resetMarketTables();
  const userId = (await createUser(getDb(), { username: 'alice', password: PASSWORD })).id;
  cookie = await loginAs('alice');
  ref = await ensureReferenceData();
  spaceId = await createSpaceRow('PEA', [{ userId, role: 'viewer' }]);
  // AI: last close 99 on 09-29; MSFT: last close 248 on 09-30 (USD at 1.1711, long division).
  await bars(ref.ai.listingId, 'EUR', [
    ['2026-08-28', '90'],
    ['2026-09-29', '99'],
  ]);
  await bars(ref.msft.listingId, 'USD', [
    ['2026-08-28', '201.17'],
    ['2026-09-30', '248'],
  ]);
  await upsertFxRates(
    getDb(),
    [
      { date: '2026-08-28', currency: 'USD', ratePerEur: '1.1373' },
      { date: '2026-09-30', currency: 'USD', ratePerEur: '1.1711' },
    ],
    { source: 'fake', fetchedAt: NOW },
  );
  await createPositionRow(spaceId, ref.ai, '10');
  await createPositionRow(spaceId, ref.msft, '7');
});

const summary = async (period = '1m') =>
  (await rpc('dashboard.summary', { spaceId, period }, { cookie }))
    .json as unknown as DashboardSummaryOutput;
const history = async (period = '1m', fxMode = 'historical') =>
  (await rpc('dashboard.history', { spaceId, period, fxMode }, { cookie }))
    .json as unknown as DashboardHistoryOutput;

const recompute = () => recomputeListingMetrics(getDb(), { now: NOW, config: testConfig });
const d = (v: string | null | undefined) => new Decimal(v as string);

describe('D23 over the real RPC handler', () => {
  it('a same-day quote above the last close: chart end = headline end = total, total - change = start', async () => {
    // AI quote 105 today (Paris 12:00 of 09-30, no close yet for that day): D21 end price 105.
    await upsertQuotes(
      getDb(),
      [
        {
          listingId: ref.ai.listingId,
          price: '105',
          currency: 'EUR',
          asOf: new Date('2026-09-30T10:00:00Z'),
        },
      ],
      { source: 'fake', fetchedAt: NOW },
    );
    await recompute();
    const s = await summary();
    const h = await history();
    expect(s.isComplete).toBe(true);
    // 10 x 105 + 7 x 248 / 1.1711 = 1050 + 1482.2...: the last chart point is exactly this.
    expect(h.points.at(-1)?.date).toBe('2026-09-30');
    expect(h.points.at(-1)?.value).toBe(s.total.amount);
    expect(h.headline?.endValue.amount).toBe(s.total.amount);
    expect(s.change?.endValue.amount).toBe(s.total.amount);
    expect(s.change).toEqual(h.headline);
    expect(s.change?.toDate).toBe('2026-09-30');
    expect(d(s.total.amount).minus(d(s.change?.change.amount)).toFixed()).toBe(
      d(s.change?.startValue.amount).toFixed(),
    );
    // Without the quote the end price would have been the close: the terminal point differs.
    expect(s.total.amount).not.toBe(
      new Decimal(990)
        .plus(new Decimal(7 * 248).div('1.1711'))
        .toDecimalPlaces(8)
        .toFixed(),
    );
  });

  it('`current` FX mode: the chart also ends on the total (same end price, same rate)', async () => {
    await recompute();
    const s = await summary('1y');
    const cur = await history('1y', 'current');
    expect(cur.points.at(-1)?.value).toBe(s.total.amount);
    expect(cur.points.every((p) => p.fxRates.length === 0)).toBe(true);
    expect(cur.currentFxRates?.[0]).toMatchObject({ currency: 'USD', isStale: false });
    expect(cur.seriesEnd).toBe('2026-09-30');
    expect(cur.isStale).toBe(false);
  });

  it('a position with closes but no metrics row: partial total and no change (never another set)', async () => {
    await recompute();
    await getDb().execute(
      sql`delete from listing_metrics where listing_id = ${ref.msft.listingId}`,
    );
    const s = await summary();
    expect(s.isComplete).toBe(false);
    expect(s.missing.map((m) => m.reason)).toEqual(['price_missing']);
    expect(s.total.amount).toBe('990'); // AI only
    expect(s.change).toBeNull();
  });

  it('FX 8 days before the as-of date: partial total, no change', async () => {
    await recompute();
    await getDb().execute(
      sql`update fx_daily set rate_date = '2026-09-22' where rate_date = '2026-09-30'`,
    );
    const s = await summary();
    expect(s.isComplete).toBe(false);
    expect(s.missing.map((m) => m.reason)).toEqual(['fx_missing']);
    expect(s.change).toBeNull();
  });
});
