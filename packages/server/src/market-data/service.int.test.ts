import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { marketDataFetchState, providerUsage, quoteLatest } from '../db/schema';
import { DbUsageStore } from './repository';
import { ensureReferenceData } from '../../test/space-fixtures';
import { releaseTestEnv, useTestEnv } from '../../test/auth-harness';
import {
  HOUR,
  MIN,
  SpyProvider,
  TestClock,
  makeService,
  refFor,
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
      asOfDate: null,
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

describe('upsertQuotes never regresses (review P2-1)', () => {
  it('an older provider timestamp keeps price and as_of but records that a fetch happened', async () => {
    const svc = makeService(provider, clock);
    provider.options.price = '100';
    await svc.refreshQuotesById([listingId]);
    const first = await stored();
    expect(first?.asOf).toEqual(new Date(T0));

    clock.advance(20 * MIN);
    provider.options.price = '90';
    provider.options.quoteAsOf = new Date(new Date(T0).getTime() - HOUR);
    expect((await svc.refreshQuotesById([listingId])).get(listingId)).toBe('refreshed');
    const after = await stored();
    expect(after).toMatchObject({ price: '100.00000000', currency: 'EUR' });
    expect(after?.asOf).toEqual(new Date(T0));
    expect(after?.fetchedAt).toEqual(clock.now()); // freshness reflects the fetch, not the data time

    // A newer timestamp still moves forward.
    provider.options.price = '120';
    provider.options.quoteAsOf = new Date(clock.now().getTime());
    clock.advance(20 * MIN);
    await svc.refreshQuotesById([listingId]);
    expect(await stored()).toMatchObject({ price: '120.00000000' });
  });
});

describe('failure classification after a good provider call (audit P2-1, review P3-7)', () => {
  it('a deterministic persist error on quotes backs off with bad_payload', async () => {
    provider.options.source = 'BAD SOURCE!'; // violates quote_latest_source_format
    const svc = makeService(provider, clock);
    expect((await svc.refreshQuotesById([listingId])).get(listingId)).toBe('failed');
    const [state] = await getDb().select().from(marketDataFetchState);
    expect(state).toMatchObject({ failureCount: 1, lastErrorCode: 'bad_payload' });
    expect((await svc.refreshQuotesById([listingId])).get(listingId)).toBe('skipped_backoff');
    expect(provider.quoteCalls).toHaveLength(1);
  });

  it('a quote whose price would round at numeric(24,8) is dropped: failed, nothing stored', async () => {
    provider.options.price = '1e-9';
    expect((await makeService(provider, clock).refreshQuotesById([listingId])).get(listingId)).toBe(
      'failed',
    );
    expect(await stored()).toBeUndefined();
  });

  it('an UPSTREAM quota_exceeded backs off; the LOCAL quota refusal does not', async () => {
    const svc = makeService(provider, clock);
    provider.options.failWith = 'quota_exceeded';
    await svc.refreshQuotesById([listingId]);
    const [upstream] = await getDb().select().from(marketDataFetchState);
    expect(upstream).toMatchObject({ failureCount: 1, lastErrorCode: 'quota_exceeded' });

    await getDb().delete(marketDataFetchState);
    provider.options.failWith = 'local_quota';
    await svc.refreshQuotesById([listingId]);
    expect(await getDb().select().from(marketDataFetchState)).toHaveLength(0);
  });
});

describe('DbUsageStore.reserve under concurrency', () => {
  it('10 parallel reservations against a budget of 3 succeed exactly 3 times', async () => {
    const store = new DbUsageStore(getDb());
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.reserve('fake', '2026-09-30', 3)),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    const [usage] = await getDb().select().from(providerUsage);
    expect(usage).toMatchObject({ provider: 'fake', day: '2026-09-30', calls: 3 });
  });

  it('a zero budget refuses everything and counts nothing', async () => {
    const store = new DbUsageStore(getDb());
    expect(await store.reserve('fake', '2026-09-30', 0)).toBe(false);
    expect(await getDb().select().from(providerUsage)).toHaveLength(0);
  });
});

describe('partially overlapping in-flight quote batches', () => {
  it('the second caller joins the shared listing and fetches only its own new one', async () => {
    const ids = await ensureReferenceData();
    const [a, b, c] = [ids.ai.listingId, ids.shel.listingId, ids.cw8.listingId];
    provider.options.delayMs = 60;
    const svc = makeService(provider, clock);
    const refs = await Promise.all([a, b, c].map((id) => refFor(id)));
    const first = svc.refreshQuotes([refs[0]!, refs[1]!]);
    // Registration is synchronous: the second call sees A and B in flight.
    const second = svc.refreshQuotes([refs[1]!, refs[2]!]);
    const [o1, o2] = await Promise.all([first, second]);
    // Two provider calls (their order depends on DB read timing): {A, B} and only {C}.
    const calls = provider.quoteCalls
      .map((ids) => [...ids].sort())
      .sort((x, y) => y.length - x.length);
    expect(calls).toEqual([[a, b].sort(), [c]]);
    expect([...o1.values()]).toEqual(['refreshed', 'refreshed']);
    expect(o2.get(b)).toBe('refreshed'); // joined, not fetched twice
    expect(o2.get(c)).toBe('refreshed');
    expect((await getDb().select().from(quoteLatest)).map((q) => q.listingId).sort()).toEqual(
      [a, b, c].sort(),
    );
  });
});
