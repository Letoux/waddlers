import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { marketDataFetchState, quoteLatest } from '../db/schema';
import { ensureReferenceData } from '../../test/space-fixtures';
import { releaseTestEnv, useTestEnv } from '../../test/auth-harness';
import {
  HOUR,
  MIN,
  SpyProvider,
  TestClock,
  makeService,
  resetMarketTables,
} from '../../test/market-fixtures';

beforeAll(useTestEnv);
afterAll(releaseTestEnv);

const T0 = '2026-09-30T10:00:00Z';
let clock: TestClock;
let listingId: string;
let provider: SpyProvider;

beforeEach(async () => {
  await resetMarketTables();
  listingId = (await ensureReferenceData()).ai.listingId;
  clock = new TestClock(new Date(T0).getTime());
  provider = new SpyProvider({ clock: clock.now });
});

const stored = async () =>
  (await getDb().select().from(quoteLatest).where(eq(quoteLatest.listingId, listingId)))[0];

describe('getQuote: stale-while-revalidate', () => {
  it('missing value: one blocking fetch, then a cache hit makes 0 provider calls', async () => {
    const svc = makeService(provider, clock);
    const first = await svc.getQuote(listingId);
    expect(first).toMatchObject({
      freshness: 'fresh',
      source: 'fake',
      data: { price: '100.50000000', currency: 'EUR' },
    });
    expect(first.asOf).toEqual(new Date(T0));
    expect(provider.quoteCalls).toHaveLength(1);

    clock.advance(14 * MIN);
    const second = await svc.getQuote(listingId);
    expect(second.freshness).toBe('fresh');
    await svc.idle();
    expect(provider.quoteCalls).toHaveLength(1);
  });

  it('TTL expiry returns the stale value immediately and triggers exactly one refresh', async () => {
    const svc = makeService(provider, clock);
    await svc.getQuote(listingId);
    clock.advance(15 * MIN);
    provider.options.price = '110';
    const stale = await svc.getQuote(listingId);
    expect(stale).toMatchObject({ freshness: 'stale', data: { price: '100.50000000' } });
    await svc.idle();
    expect(provider.quoteCalls).toHaveLength(2);
    expect((await stored())?.price).toBe('110.00000000');
    expect((await svc.getQuote(listingId)).freshness).toBe('fresh');
    expect(provider.quoteCalls).toHaveLength(2);
  });

  it('N concurrent reads of a missing value make one provider call (single-flight)', async () => {
    provider.options.delayMs = 20;
    const svc = makeService(provider, clock);
    const results = await Promise.all(Array.from({ length: 10 }, () => svc.getQuote(listingId)));
    expect(provider.quoteCalls).toHaveLength(1);
    expect(results.every((r) => r.data?.price === '100.50000000')).toBe(true);
  });

  it('N concurrent reads of a stale value make one background refresh', async () => {
    const svc = makeService(provider, clock);
    await svc.getQuote(listingId);
    clock.advance(20 * MIN);
    provider.options.delayMs = 20;
    const results = await Promise.all(Array.from({ length: 10 }, () => svc.getQuote(listingId)));
    expect(results.every((r) => r.freshness === 'stale')).toBe(true);
    await svc.idle();
    expect(provider.quoteCalls).toHaveLength(2);
  });

  it('missing value + provider slower than the bound: unavailable, never 0', async () => {
    provider.options.delayMs = 400; // blockingFetchMs is 100 in the test config
    const svc = makeService(provider, clock);
    const res = await svc.getQuote(listingId);
    expect(res).toEqual({
      data: null,
      freshness: 'unavailable',
      asOf: null,
      source: null,
      fetchedAt: null,
    });
    await svc.idle(); // the fetch keeps running and persists for the next reader
    expect((await svc.getQuote(listingId)).freshness).toBe('fresh');
  });
});

describe('failures', () => {
  it('provider error on a stale value: stale data stays, fetched_at is NOT bumped', async () => {
    const svc = makeService(provider, clock);
    await svc.getQuote(listingId);
    const before = await stored();
    clock.advance(30 * MIN);
    provider.options.failWith = 'upstream_error';
    const res = await svc.getQuote(listingId);
    await svc.idle();
    expect(res).toMatchObject({ freshness: 'stale', data: { price: '100.50000000' } });
    const after = await stored();
    expect(after?.fetchedAt).toEqual(before?.fetchedAt);
    expect(after?.price).toBe(before?.price);
    expect((await svc.getQuote(listingId)).freshness).toBe('stale');
  });

  it('provider error on a missing value: null/unavailable, nothing stored', async () => {
    provider.options.failWith = 'network';
    const svc = makeService(provider, clock);
    const res = await svc.getQuote(listingId);
    expect(res).toMatchObject({ data: null, freshness: 'unavailable' });
    expect(await stored()).toBeUndefined();
  });

  it('backoff grows exponentially and next_retry_at is respected (no provider call inside it)', async () => {
    provider.options.failWith = 'upstream_error';
    const svc = makeService(provider, clock);
    const state = async () =>
      (
        await getDb()
          .select()
          .from(marketDataFetchState)
          .where(eq(marketDataFetchState.listingId, listingId))
      )[0]!;

    await svc.refreshQuotesById([listingId]);
    let s = await state();
    expect(s.failureCount).toBe(1);
    expect(s.nextRetryAt).toEqual(new Date(clock.now().getTime() + 1 * MIN));
    expect(s.lastErrorCode).toBe('upstream_error');

    // Inside the window: skipped, provider untouched, state unchanged.
    clock.advance(30_000);
    expect((await svc.refreshQuotesById([listingId])).get(listingId)).toBe('skipped_backoff');
    expect(provider.quoteCalls).toHaveLength(1);

    clock.advance(31_000); // past next_retry_at
    await svc.refreshQuotesById([listingId]);
    s = await state();
    expect(s.failureCount).toBe(2);
    expect(s.nextRetryAt).toEqual(new Date(clock.now().getTime() + 2 * MIN));

    clock.advance(3 * MIN);
    await svc.refreshQuotesById([listingId]);
    s = await state();
    expect(s.failureCount).toBe(3);
    expect(s.nextRetryAt).toEqual(new Date(clock.now().getTime() + 4 * MIN));
    expect(provider.quoteCalls).toHaveLength(3);
  });

  it('backoff is capped, and a success resets the streak', async () => {
    provider.options.failWith = 'network';
    const svc = makeService(provider, clock);
    for (let i = 0; i < 12; i += 1) {
      await svc.refreshQuotesById([listingId]);
      clock.advance(7 * HOUR);
    }
    const [s] = await getDb().select().from(marketDataFetchState);
    expect(s!.failureCount).toBe(12);
    const gap = s!.nextRetryAt!.getTime() - s!.lastAttemptAt!.getTime();
    expect(gap).toBe(6 * HOUR);

    delete provider.options.failWith;
    expect((await svc.refreshQuotesById([listingId])).get(listingId)).toBe('refreshed');
    const [after] = await getDb().select().from(marketDataFetchState);
    expect(after).toMatchObject({ failureCount: 0, nextRetryAt: null, lastErrorCode: null });
  });

  it('a quote in another currency than the listing is never stored', async () => {
    const svc = makeService(
      Object.assign(provider, {
        getQuotes: async () => ({
          ok: true as const,
          source: 'fake',
          asOf: clock.now(),
          data: {
            quotes: [{ listingId, price: '10', currency: 'USD', asOf: clock.now() }],
            rejected: [],
          },
        }),
      }),
      clock,
    );
    expect((await svc.refreshQuotesById([listingId])).get(listingId)).toBe('failed');
    expect(await stored()).toBeUndefined();
  });
});
