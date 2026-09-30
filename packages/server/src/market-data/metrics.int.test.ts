import { Decimal, PERIODS, computePerformance, convert, parseDecimal } from '@waddlers/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { listingMetrics } from '../db/schema';
import { ensureReferenceData } from '../../test/space-fixtures';
import { releaseTestEnv, useTestEnv } from '../../test/auth-harness';
import { resetMarketTables, testConfig } from '../../test/market-fixtures';
import { recomputeListingMetrics } from './metrics';
import { readBars, recordSuccess, upsertBars, upsertFxRates, upsertQuotes } from './repository';
import { addDays } from '@waddlers/domain';

beforeAll(useTestEnv);
afterAll(releaseTestEnv);

const NOW = new Date('2026-09-30T12:00:00Z');
let ids: Awaited<ReturnType<typeof ensureReferenceData>>;

beforeEach(async () => {
  await resetMarketTables();
  ids = await ensureReferenceData();
});

/** Every weekday from `from` to `to` with a smooth deterministic close. */
async function seedBars(
  listingId: string,
  currency: string,
  from: string,
  to: string,
  base: number,
) {
  const bars = [];
  let i = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    bars.push({ date: d, close: (base + i * 0.37).toFixed(4), adjClose: null });
    i += 1;
  }
  await upsertBars(getDb(), { id: listingId, currency }, bars, { source: 'fake', fetchedAt: NOW });
  return bars;
}

const metrics = async (listingId: string) =>
  (await getDb().select().from(listingMetrics).where(eq(listingMetrics.listingId, listingId)))[0]!;
const recompute = (listingIds?: string[]) =>
  recomputeListingMetrics(getDb(), {
    now: NOW,
    config: testConfig,
    ...(listingIds ? { listingIds } : {}),
  });

describe('recomputeListingMetrics vs the domain functions', () => {
  it('EUR listing: price, basis and every period equal computePerformance (rounded to 8 dp once)', async () => {
    await seedBars(ids.ai.listingId, 'EUR', '2020-01-02', '2026-09-29', 80);
    await recordSuccess(getDb(), ids.ai.listingId, 'history', NOW, {
      historyCompleteFrom: '2020-01-02',
    });
    await upsertQuotes(
      getDb(),
      [
        {
          listingId: ids.ai.listingId,
          price: '183.4567',
          currency: 'EUR',
          asOf: new Date('2026-09-30T09:45:00Z'),
        },
      ],
      { source: 'fake', fetchedAt: NOW },
    );
    await recompute([ids.ai.listingId]);
    const row = await metrics(ids.ai.listingId);
    expect(row).toMatchObject({
      price: '183.45670000',
      priceBasis: 'quote',
      asOfDate: '2026-09-30',
      priceEur: '183.45670000',
    });
    expect(row.priceEurReason).toBeNull();

    const series = (await readBars(getDb(), ids.ai.listingId)).map((b) => ({
      date: b.date,
      close: parseDecimal(b.close),
    }));
    const keys = {
      '1w': 'perf1w',
      '1m': 'perf1m',
      '6m': 'perf6m',
      '1y': 'perf1y',
      '5y': 'perf5y',
      max: 'perfMax',
    } as const;
    for (const period of PERIODS) {
      const expected = computePerformance({
        series,
        period,
        asOf: '2026-09-30',
        end: new Decimal('183.4567'),
        historyCompleteFrom: '2020-01-02',
      });
      if (expected.value === null) throw new Error(`domain says ${period} unavailable`);
      expect(new Decimal(row[keys[period]]!).eq(expected.value.toDecimalPlaces(8))).toBe(true);
      expect(row[`${keys[period]}BaseDate` as 'perf1wBaseDate']).toBe(expected.baseDate);
    }
  });

  it('GBX listing: price_eur = pence / 100 / GBP-per-EUR, using the rate of the price date', async () => {
    await seedBars(ids.shel.listingId, 'GBX', '2026-09-01', '2026-09-29', 2400);
    await upsertQuotes(
      getDb(),
      [
        {
          listingId: ids.shel.listingId,
          price: '2450.5',
          currency: 'GBX',
          asOf: new Date('2026-09-30T10:00:00Z'),
        },
      ],
      { source: 'fake', fetchedAt: NOW },
    );
    await upsertFxRates(
      getDb(),
      [
        { date: '2026-09-29', currency: 'GBP', ratePerEur: '0.86' },
        { date: '2026-09-30', currency: 'GBP', ratePerEur: '0.87' },
      ],
      { source: 'fake', fetchedAt: NOW },
    );
    await recompute([ids.shel.listingId]);
    const row = await metrics(ids.shel.listingId);
    expect(row.priceCurrency).toBe('GBX');
    expect(row.price).toBe('2450.50000000');
    // Quote dated 2026-09-30 in London -> the 09-30 rate (0.87): 24.505 / 0.87 = 28.1666666...
    expect(row.fxRateDate).toBe('2026-09-30');
    expect(row.fxRatePerEur).toBe('0.8700000000');
    expect(row.priceEur).toBe('28.16666667');
    const domain = convert(
      new Decimal('2450.5'),
      'GBX',
      'EUR',
      new Map([['GBP', new Decimal('0.87')]]),
    );
    expect(row.priceEur).toBe(domain!.toDecimalPlaces(8).toFixed(8));
  });

  it('missing FX: price_eur is NULL with a reason (never rate 1), local price and perf remain', async () => {
    await seedBars(ids.msft.listingId, 'USD', '2026-08-01', '2026-09-29', 400);
    await recompute([ids.msft.listingId]);
    const row = await metrics(ids.msft.listingId);
    expect(row.price).not.toBeNull();
    expect(row).toMatchObject({
      priceBasis: 'close',
      priceEur: null,
      priceEurReason: 'rate_missing',
      fxRatePerEur: null,
    });
    expect(row.perf1w).not.toBeNull(); // local-currency performance does not need FX (D4)
  });

  it('a rate older than the tolerance is not carried forward', async () => {
    await seedBars(ids.msft.listingId, 'USD', '2026-08-01', '2026-09-29', 400);
    await upsertFxRates(getDb(), [{ date: '2026-09-10', currency: 'USD', ratePerEur: '1.1' }], {
      source: 'fake',
      fetchedAt: NOW,
    });
    await recompute([ids.msft.listingId]);
    expect((await metrics(ids.msft.listingId)).priceEurReason).toBe('rate_missing');
    await upsertFxRates(getDb(), [{ date: '2026-09-25', currency: 'USD', ratePerEur: '1.1' }], {
      source: 'fake',
      fetchedAt: NOW,
    });
    await recompute([ids.msft.listingId]);
    const ok = await metrics(ids.msft.listingId);
    expect(ok.priceEurReason).toBeNull();
    expect(ok.fxRateDate).toBe('2026-09-25');
  });

  it('max without history_complete_from: NULL perf with a reason, other periods still computed', async () => {
    await seedBars(ids.ai.listingId, 'EUR', '2025-01-02', '2026-09-29', 80);
    await recompute([ids.ai.listingId]);
    const row = await metrics(ids.ai.listingId);
    expect(row).toMatchObject({
      perfMax: null,
      perfMaxReason: 'history_completeness_unknown',
      perfMaxBaseDate: null,
    });
    expect(row.perf1y).not.toBeNull();
  });

  it('a listing with no price data still gets a row: all NULL, each with a reason', async () => {
    await recompute([ids.cw8.listingId]);
    const row = await metrics(ids.cw8.listingId);
    expect(row).toMatchObject({
      price: null,
      priceBasis: null,
      priceEur: null,
      priceEurReason: 'price_missing',
    });
    expect(row.perf1wReason).toBe('end_missing');
    expect(row.perf5yReason).toBe('end_missing');
  });

  it('is idempotent: same inputs give the same values (only computed_at moves)', async () => {
    await seedBars(ids.ai.listingId, 'EUR', '2025-01-02', '2026-09-29', 80);
    await recompute([ids.ai.listingId]);
    const a = await metrics(ids.ai.listingId);
    await recomputeListingMetrics(getDb(), {
      now: new Date(NOW.getTime() + 1000),
      config: testConfig,
      listingIds: [ids.ai.listingId],
    });
    const b = await metrics(ids.ai.listingId);
    expect({ ...b, computedAt: null }).toEqual({ ...a, computedAt: null });
    expect(b.computedAt.getTime()).toBe(NOW.getTime() + 1000);
  });

  it('closes stored in another currency than the listing are never mixed in', async () => {
    await seedBars(ids.ai.listingId, 'USD', '2026-08-01', '2026-09-29', 80);
    await recompute([ids.ai.listingId]);
    expect((await metrics(ids.ai.listingId)).price).toBeNull();
  });
});
