import { Decimal, PERIODS, computePerformance, convert, parseDecimal } from '@waddlers/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { getDb } from '../db/client';
import { exchanges, listingMetrics } from '../db/schema';
import { ensureReferenceData } from '../../test/space-fixtures';
import { releaseTestEnv, useTestEnv } from '../../test/auth-harness';
import { resetMarketTables, testConfig } from '../../test/market-fixtures';
import { computeMetricsValues, recomputeListingMetrics } from './metrics';
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

describe('D21: the official close for a date wins over a same-day quote', () => {
  const quote = (listingId: string, asOf: string) =>
    upsertQuotes(getDb(), [{ listingId, price: '999', currency: 'EUR', asOf: new Date(asOf) }], {
      source: 'fake',
      fetchedAt: NOW,
    });

  it('quote-only day -> quote; close for the same date -> close; newer quote date -> quote', async () => {
    await seedBars(ids.ai.listingId, 'EUR', '2026-09-01', '2026-09-29', 80);
    await quote(ids.ai.listingId, '2026-09-30T09:45:00Z'); // no 09-30 close yet
    await recompute([ids.ai.listingId]);
    expect(await metrics(ids.ai.listingId)).toMatchObject({
      priceBasis: 'quote',
      price: '999.00000000',
      asOfDate: '2026-09-30',
    });

    await seedBars(ids.ai.listingId, 'EUR', '2026-09-30', '2026-09-30', 90); // the close arrives
    await recompute([ids.ai.listingId]);
    const row = await metrics(ids.ai.listingId);
    expect(row).toMatchObject({ priceBasis: 'close', asOfDate: '2026-09-30', priceAsOf: null });
    expect(row.price).not.toBe('999.00000000');

    await quote(ids.ai.listingId, '2026-10-01T09:45:00Z'); // a newer day than the last close
    await recompute([ids.ai.listingId]);
    expect(await metrics(ids.ai.listingId)).toMatchObject({
      priceBasis: 'quote',
      asOfDate: '2026-10-01',
    });
  });
});

/** The database pads numerics to the column scale; compare numbers, not spellings. */
const canonical = (row: object) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? new Decimal(v).toFixed(8) : v,
    ]),
  );

describe('bounded reads equal the unbounded computation (review P2-6)', () => {
  it('long series, stale series and a gap at the 5y target give identical rows', async () => {
    const complete = { ai: '2016-01-04', cw8: '2018-03-01', msft: '2016-01-04' };
    await seedBars(ids.ai.listingId, 'EUR', complete.ai, '2026-09-29', 80); // ~10 years
    await seedBars(ids.cw8.listingId, 'EUR', complete.cw8, '2026-01-15', 50); // stale: last close months ago
    await seedBars(ids.msft.listingId, 'USD', complete.msft, '2021-06-30', 200); // gap around the 5y target
    await seedBars(ids.msft.listingId, 'USD', '2021-10-12', '2026-09-29', 300);
    for (const [key, from] of Object.entries(complete)) {
      await recordSuccess(getDb(), ids[key as keyof typeof ids].listingId, 'history', NOW, {
        historyCompleteFrom: from,
      });
    }
    await upsertQuotes(
      getDb(),
      [
        {
          listingId: ids.ai.listingId,
          price: '183.45',
          currency: 'EUR',
          asOf: new Date('2026-09-30T09:45:00Z'),
        },
      ],
      { source: 'fake', fetchedAt: NOW },
    );
    await recompute([ids.ai.listingId, ids.cw8.listingId, ids.msft.listingId]);

    const listingsMeta = [
      [ids.ai.listingId, 'EUR', 'Europe/Paris'],
      [ids.cw8.listingId, 'EUR', 'Europe/Paris'],
      [ids.msft.listingId, 'USD', 'America/New_York'],
    ] as const;
    const quotes = await import('./repository').then((r) =>
      r.readQuotes(
        getDb(),
        listingsMeta.map(([id]) => id),
      ),
    );
    for (const [id, currency, timezone] of listingsMeta) {
      const q = quotes.get(id);
      const unbounded = computeMetricsValues({
        currency,
        timezone,
        closes: await readBars(getDb(), id),
        quote: q ? { price: q.price, asOf: q.asOf } : null,
        historyCompleteFrom: Object.values(complete)[listingsMeta.findIndex(([x]) => x === id)]!,
        fxRate: () => null,
      });
      const { listingId, computedAt, ...stored } = await metrics(id);
      expect(listingId).toBe(id);
      expect(computedAt).toEqual(NOW);
      expect(canonical(stored)).toEqual(canonical(unbounded));
    }
    const msft = await metrics(ids.msft.listingId);
    expect(msft.perf5yReason).toBe('gap_exceeds_tolerance');
    expect((await metrics(ids.ai.listingId)).perf5y).not.toBeNull();
  });
});

describe('per-listing error isolation (review P2-3)', () => {
  it('one listing with an invalid exchange timezone fails alone; the others are computed', async () => {
    await seedBars(ids.ai.listingId, 'EUR', '2026-09-01', '2026-09-29', 80);
    await seedBars(ids.shel.listingId, 'GBX', '2026-09-01', '2026-09-29', 2400);
    await upsertQuotes(
      getDb(),
      [
        {
          listingId: ids.shel.listingId,
          price: '2450',
          currency: 'GBX',
          asOf: new Date('2026-09-30T10:00:00Z'),
        },
      ],
      { source: 'fake', fetchedAt: NOW },
    );
    await getDb()
      .update(exchanges)
      .set({ timezone: 'Not/A_Zone' })
      .where(eq(exchanges.mic, 'XLON'));
    // Exchanges are shared reference data: restore XLON so later test files are unaffected.
    onTestFinished(async () => {
      await getDb()
        .update(exchanges)
        .set({ timezone: 'Europe/London' })
        .where(eq(exchanges.mic, 'XLON'));
    });
    const errors: string[] = [];
    const res = await recomputeListingMetrics(getDb(), {
      now: NOW,
      config: testConfig,
      listingIds: [ids.ai.listingId, ids.shel.listingId],
      logger: { info() {}, warn() {}, error: (m) => errors.push(m) },
    });
    expect(res).toEqual({ computed: 1, failed: 1 });
    expect(errors).toEqual(['listing metrics failed']);
    expect((await metrics(ids.ai.listingId)).price).not.toBeNull();
    expect(await getDb().select().from(listingMetrics)).toHaveLength(1);
  });
});
