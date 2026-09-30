import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { marketDataEnvSchema } from '../env';
import { fxDaily, marketDataFetchState, priceDaily, providerUsage } from '../db/schema';
import { ensureReferenceData } from '../../test/space-fixtures';
import { releaseTestEnv, useTestEnv } from '../../test/auth-harness';
import {
  HOUR,
  SpyFx,
  SpyProvider,
  TestClock,
  makeService,
  refFor,
  resetMarketTables,
} from '../../test/market-fixtures';
import { readBars } from './repository';
import { createMarketDataRuntime } from './runtime';
import { fail } from './types';

beforeAll(useTestEnv);
afterAll(releaseTestEnv);

const BARS: [string, string][] = [
  ['2026-09-21', '100'],
  ['2026-09-22', '101'],
  ['2026-09-23', '102'],
  ['2026-09-24', '103'],
  ['2026-09-25', '104'],
  ['2026-09-28', '105'],
  ['2026-09-29', '106'],
];
let clock: TestClock;
let listingId: string;
let provider: SpyProvider;

beforeEach(async () => {
  await resetMarketTables();
  listingId = (await ensureReferenceData()).ai.listingId;
  clock = new TestClock(new Date('2026-09-30T10:00:00Z').getTime());
  provider = new SpyProvider({ clock: clock.now, bars: BARS });
});

const fetchState = async () =>
  (
    await getDb()
      .select()
      .from(marketDataFetchState)
      .where(eq(marketDataFetchState.listingId, listingId))
  )[0];

describe('history refresh', () => {
  it('first pull is a full backfill and sets history_complete_from = first stored close', async () => {
    const svc = makeService(provider, clock);
    expect(await svc.refreshHistory(await refFor(listingId))).toBe('refreshed');
    expect(provider.historyCalls[0]).toMatchObject({ from: '1970-01-01', to: '2026-09-30' });
    expect((await readBars(getDb(), listingId)).map((b) => b.date)).toHaveLength(7);
    expect((await fetchState())?.historyCompleteFrom).toBe('2026-09-21');
  });

  it('no history_complete_from when the provider did not reach the start of the series', async () => {
    provider.options.reachedStart = false;
    await makeService(provider, clock).refreshHistory(await refFor(listingId));
    expect((await fetchState())?.historyCompleteFrom).toBeNull();
  });

  it('within the TTL nothing is fetched; after it, the last 5 days are re-pulled idempotently', async () => {
    const svc = makeService(provider, clock);
    const ref = await refFor(listingId);
    await svc.refreshHistory(ref);
    clock.advance(1 * HOUR);
    expect(await svc.refreshHistory(ref)).toBe('skipped_fresh');
    expect(provider.historyCalls).toHaveLength(1);

    const before = await readBars(getDb(), listingId);
    clock.advance(12 * HOUR);
    // A late correction of an old overlap day and a new day appear at the provider.
    provider.options.bars = [
      ...BARS.slice(0, 5),
      ['2026-09-28', '105.5'],
      ['2026-09-29', '106'],
      ['2026-09-30', '107'],
    ];
    expect(await svc.refreshHistory(ref)).toBe('refreshed');
    expect(provider.historyCalls[1]).toMatchObject({ from: '2026-09-24', to: '2026-10-01' }); // last bar 09-29 - 5d; to = Paris-local date
    const after = await readBars(getDb(), listingId);
    expect(after).toHaveLength(before.length + 1);
    expect(after.find((b) => b.date === '2026-09-28')?.close).toBe('105.50000000');
    expect(after.find((b) => b.date === '2026-09-21')?.fetchedAt).toEqual(before[0]!.fetchedAt); // outside overlap: untouched
    // Repeating with the same data changes nothing but timestamps.
    clock.advance(13 * HOUR);
    await svc.refreshHistory(ref);
    const again = await readBars(getDb(), listingId);
    expect(again.map((b) => [b.date, b.close])).toEqual(after.map((b) => [b.date, b.close]));
    expect((await fetchState())?.historyCompleteFrom).toBe('2026-09-21');
  });

  it('a failed pull keeps the bars, does not touch fetched_at, and schedules a backoff', async () => {
    const svc = makeService(provider, clock);
    const ref = await refFor(listingId);
    await svc.refreshHistory(ref);
    const before = await readBars(getDb(), listingId);
    clock.advance(13 * HOUR);
    provider.options.failWith = 'network';
    expect(await svc.refreshHistory(ref)).toBe('failed');
    expect(await readBars(getDb(), listingId)).toEqual(before);
    expect((await fetchState())?.failureCount).toBe(1);
    const served = await svc.getDailyHistory(listingId);
    await svc.idle();
    expect(served.freshness).toBe('stale');
    expect(served.data?.bars).toHaveLength(7);
  });

  it('an empty full backfill is a failure (not_found), never an empty "success"', async () => {
    provider.options.bars = [];
    expect(await makeService(provider, clock).refreshHistory(await refFor(listingId))).toBe(
      'failed',
    );
    expect((await fetchState())?.lastErrorCode).toBe('not_found');
  });

  it('never stores a bar dated after the exchange-local today', async () => {
    provider.options.bars = [...BARS, ['2026-10-05', '999']];
    await makeService(provider, clock).refreshHistory(await refFor(listingId));
    expect((await readBars(getDb(), listingId)).some((b) => b.date === '2026-10-05')).toBe(false);
  });
});

describe('price_daily constraints', () => {
  it.each(['0', '-1', 'NaN'])('the database rejects close = %s', async (close) => {
    await expect(
      getDb().insert(priceDaily).values({
        listingId,
        tradeDate: '2026-09-29',
        close,
        currency: 'EUR',
        source: 'fake',
        fetchedAt: new Date(),
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

describe('FX refresh', () => {
  const rates = [
    { date: '2026-09-28', currency: 'USD', ratePerEur: '1.1' },
    { date: '2026-09-29', currency: 'USD', ratePerEur: '1.2' },
  ];

  it('stores EUR-based rates, is fresh within the TTL and repeats safely', async () => {
    const fx = new SpyFx(rates);
    const svc = makeService(provider, clock, fx);
    expect(await svc.refreshFx({ needFrom: '2026-09-01' })).toBe('refreshed');
    expect(await getDb().select().from(fxDaily)).toHaveLength(2);
    expect(await svc.refreshFx({ needFrom: '2026-09-01' })).toBe('skipped_fresh');
    expect(fx.calls).toHaveLength(1);
    clock.advance(13 * HOUR);
    expect(await svc.refreshFx({ needFrom: '2026-09-01' })).toBe('refreshed');
    expect(fx.calls[1]?.from).toBe('2026-09-24'); // incremental: latest 09-29 - 5d
    expect(await getDb().select().from(fxDaily)).toHaveLength(2);
    const served = await svc.getLatestFx();
    expect(served).toMatchObject({ freshness: 'fresh', source: 'fake' });
    expect(served.data?.rates).toEqual([
      { currency: 'USD', date: '2026-09-29', ratePerEur: '1.2000000000' },
    ]);
  });

  it('an FX outage never invents a rate', async () => {
    const svc = makeService(provider, clock, {
      name: 'fake',
      getDailyRates: async () => fail('fake', 'network', 'down'),
    });
    expect(await svc.refreshFx()).toBe('failed');
    expect(await getDb().select().from(fxDaily)).toHaveLength(0);
    expect((await svc.getLatestFx()).freshness).toBe('unavailable');
  });
});

describe('daily quota (provider_usage) through the guarded runtime', () => {
  it('refuses calls over budget, counts per provider and UTC day, and does not back off the listing', async () => {
    const env = marketDataEnvSchema.parse({});
    const runtime = createMarketDataRuntime(getDb(), env, {
      clock: clock.now,
      provider,
      fx: new SpyFx(),
      config: { dailyQuota: 2, maxAttempts: 1, blockingFetchMs: 100 },
    });
    const ref = await refFor(listingId);
    const outcomes = [];
    for (let i = 0; i < 4; i += 1) {
      outcomes.push((await runtime.service.refreshQuotes([ref], { maxAgeMs: 0 })).get(ref.id));
    }
    expect(outcomes).toEqual(['refreshed', 'refreshed', 'failed', 'failed']);
    expect(provider.quoteCalls).toHaveLength(2);
    const [usage] = await getDb().select().from(providerUsage);
    expect(usage).toMatchObject({ provider: 'fake', day: '2026-09-30', calls: 2 });
    // quota exhaustion is not the listing's fault: no failure streak recorded
    expect((await fetchState())?.failureCount).toBe(0);

    clock.advance(24 * HOUR); // next UTC day: budget resets
    expect((await runtime.service.refreshQuotes([ref], { maxAgeMs: 0 })).get(ref.id)).toBe(
      'refreshed',
    );
  });
});
