import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/client';
import {
  exchanges,
  listingMetrics,
  marketDataFetchState,
  priceDaily,
  quoteLatest,
  sessions,
  users,
} from '../db/schema';
import { purgeAllExpiredSessions } from '../auth/sessions';
import { marketDataEnvSchema } from '../env';
import { createPositionRow, createSpaceRow, ensureReferenceData } from '../../test/space-fixtures';
import { releaseTestEnv, useTestEnv } from '../../test/auth-harness';
import { TestClock, resetMarketTables } from '../../test/market-fixtures';
import { refreshHeldQuotes, refreshMarket, runNightly } from './jobs';
import { upsertQuotes } from './repository';
import { FakeMarketDataProvider } from './fake-provider';
import { FakeFxProvider } from './fx-fake';
import { createMarketDataRuntime } from './runtime';
import { startWorker } from './scheduler';
import { silentLogger } from './types';

beforeAll(useTestEnv);
afterAll(releaseTestEnv);

let clock: TestClock;
let ids: Awaited<ReturnType<typeof ensureReferenceData>>;
let provider: FakeMarketDataProvider;

function runtime() {
  provider = new FakeMarketDataProvider({ clock: clock.now });
  return createMarketDataRuntime(getDb(), marketDataEnvSchema.parse({}), {
    clock: clock.now,
    provider,
    fx: new FakeFxProvider({ clock: clock.now }),
    config: { blockingFetchMs: 2000 },
  });
}

beforeEach(async () => {
  await resetMarketTables();
  ids = await ensureReferenceData();
  clock = new TestClock(new Date('2026-09-30T13:00:00Z').getTime()); // Paris/London open, NY open at 13:30Z
  const space = await createSpaceRow('PEA');
  await createPositionRow(space, ids.ai, '2');
  await createPositionRow(space, ids.shel, '3');
});

const quoteIds = async () =>
  (await getDb().select({ id: quoteLatest.listingId }).from(quoteLatest)).map((r) => r.id).sort();

describe('refreshHeldQuotes', () => {
  it('refreshes held listings only (unheld MSFT / CW8 are never requested)', async () => {
    const rt = runtime();
    const res = await refreshHeldQuotes({ db: getDb(), runtime: rt });
    expect(res).toMatchObject({ held: 2, inWindow: 2, outcomes: { refreshed: 2 } });
    expect(await quoteIds()).toEqual([ids.ai.listingId, ids.shel.listingId].sort());
    expect(provider.calls.quotes).toBe(1); // one batched provider call
    // metrics were recomputed for the refreshed listings by the service hook
    expect(await getDb().select().from(listingMetrics)).toHaveLength(2);
  });

  it('skips exchanges outside their window and repeats safely (fresh quotes are not refetched)', async () => {
    const rt = runtime();
    clock.set('2026-09-30T18:00:00Z'); // Paris/London closed (beyond close + grace)
    expect(await refreshHeldQuotes({ db: getDb(), runtime: rt })).toMatchObject({
      held: 2,
      inWindow: 0,
    });
    expect(provider.calls.quotes).toBe(0);

    clock.set('2026-09-30T13:00:00Z');
    await refreshHeldQuotes({ db: getDb(), runtime: rt });
    clock.advance(60_000);
    const again = await refreshHeldQuotes({ db: getDb(), runtime: rt });
    expect(again.outcomes).toMatchObject({ skipped_fresh: 2, refreshed: 0 });
    expect(provider.calls.quotes).toBe(1);
  });

  it('does not refresh on a weekend', async () => {
    clock.set('2026-10-03T13:00:00Z'); // Saturday
    const res = await refreshHeldQuotes({ db: getDb(), runtime: runtime() });
    expect(res.inWindow).toBe(0);
  });
});

describe('runNightly (end to end with the fake providers)', () => {
  it('backfills history and FX, computes metrics for held listings and purges expired sessions', async () => {
    const [user] = await getDb()
      .insert(users)
      .values({ username: 'nightly', passwordHash: 'x' })
      .returning();
    // The purge uses the database clock: expiries are relative to the real time.
    const session = (hash: string, offsetMs: number) => ({
      userId: user!.id,
      tokenHash: hash.repeat(64).slice(0, 64),
      expiresAt: new Date(Date.now() + offsetMs),
    });
    await getDb()
      .insert(sessions)
      .values([
        session('a', -86_400_000),
        session('b', -60_000),
        session('c', 3_600_000),
        session('d', 30 * 86_400_000),
      ]);

    const rt = runtime();
    const result = await runNightly({ db: getDb(), runtime: rt });
    expect(result.history).toMatchObject({ refreshed: 2, failed: 0 });
    expect(result.fx).toBe('refreshed');
    expect(result.metrics).toBe(2);
    expect(result.purgedSessions).toBe(2);
    expect((await getDb().select().from(sessions)).map((s) => s.tokenHash[0]).sort()).toEqual([
      'c',
      'd',
    ]);

    const held = [ids.ai.listingId, ids.shel.listingId];
    for (const id of held) {
      const bars = await getDb().select().from(priceDaily).where(eq(priceDaily.listingId, id));
      expect(bars.length).toBeGreaterThan(1000);
      const [state] = await getDb()
        .select()
        .from(marketDataFetchState)
        .where(eq(marketDataFetchState.listingId, id));
      expect(state?.historyCompleteFrom).toBe(bars.map((b) => b.tradeDate).sort()[0]);
    }
    // Unheld listings got nothing.
    expect(
      await getDb().select().from(priceDaily).where(eq(priceDaily.listingId, ids.msft.listingId)),
    ).toHaveLength(0);

    const rows = await getDb().select().from(listingMetrics);
    expect(rows).toHaveLength(2);
    const shel = rows.find((r) => r.listingId === ids.shel.listingId)!;
    expect(shel.priceCurrency).toBe('GBX');
    expect(shel.priceEur).not.toBeNull();
    expect(shel.perfMax).not.toBeNull(); // history_complete_from known after the full backfill
    expect(shel.perf1y).not.toBeNull();

    // A second run within the TTL is a no-op for providers.
    const historyCalls = provider.calls.history;
    const again = await runNightly({ db: getDb(), runtime: rt });
    expect(again.history).toMatchObject({ skipped_fresh: 2 });
    expect(again.fx).toBe('skipped_fresh');
    expect(provider.calls.history).toBe(historyCalls);
  });

  it('a provider outage leaves metrics with NULLs and reasons, not zeros', async () => {
    const rt = runtime();
    provider.setFailure({ mode: 'error', code: 'upstream_error' });
    const result = await runNightly({ db: getDb(), runtime: rt });
    expect(result.history).toMatchObject({ failed: 2 });
    const rows = await getDb().select().from(listingMetrics);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.price).toBeNull();
      expect(r.perf1w).toBeNull();
      expect(r.perf1wReason).toBe('end_missing');
    }
  });
});

describe('runNightly really pulls (review P2-2, P2-3)', () => {
  it('a history/FX refresh 5 h earlier does not make the nightly skip (12 h TTL)', async () => {
    const rt = runtime();
    await refreshMarket({ db: getDb(), runtime: rt }, { scopes: ['history', 'fx'] });
    const calls = provider.calls.history;
    clock.advance(5 * 3_600_000);
    const result = await runNightly({ db: getDb(), runtime: rt });
    expect(result.history).toMatchObject({ refreshed: 2, skipped_fresh: 0 });
    expect(result.fx).toBe('refreshed');
    expect(provider.calls.history).toBe(calls + 2);
  });

  it('a listing whose metrics cannot be computed does not stop the others nor the session purge', async () => {
    const [user] = await getDb()
      .insert(users)
      .values({ username: 'isolated', passwordHash: 'x' })
      .returning();
    await getDb()
      .insert(sessions)
      .values({
        userId: user!.id,
        tokenHash: 'e'.repeat(64),
        expiresAt: new Date(Date.now() - 60_000),
      });
    // A quote plus an unusable exchange timezone makes SHEL's end-price date impossible to compute.
    await getDb()
      .update(exchanges)
      .set({ timezone: 'Not/A_Zone' })
      .where(eq(exchanges.mic, 'XLON'));
    const rt = runtime();
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
      { source: 'fake', fetchedAt: clock.now() },
    );
    const result = await runNightly({ db: getDb(), runtime: rt });
    expect(result.metrics).toBe(1);
    expect(result.metricsFailed).toBe(1);
    expect(result.purgedSessions).toBe(1);
    expect((await getDb().select().from(listingMetrics)).map((r) => r.listingId)).toEqual([
      ids.ai.listingId,
    ]);
  });
});

describe('refreshMarket (operator command)', () => {
  it('forces past the TTL for a single listing but honours the backoff', async () => {
    const rt = runtime();
    await refreshMarket(
      { db: getDb(), runtime: rt },
      { scopes: ['quotes'], listing: { symbol: 'AI', mic: 'XPAR' } },
    );
    const report = await refreshMarket(
      { db: getDb(), runtime: rt },
      { scopes: ['quotes'], listing: { symbol: 'AI', mic: 'XPAR' } },
    );
    expect(report.quotes?.refreshed).toBe(1); // maxAge 0: not skipped as fresh
    provider.setFailure({ mode: 'error', code: 'network' });
    await refreshMarket(
      { db: getDb(), runtime: rt },
      { scopes: ['quotes'], listing: { symbol: 'AI', mic: 'XPAR' } },
    );
    const blocked = await refreshMarket(
      { db: getDb(), runtime: rt },
      { scopes: ['quotes'], listing: { symbol: 'AI', mic: 'XPAR' } },
    );
    expect(blocked.quotes?.skipped_backoff).toBe(1);
  });

  it('rejects an unknown listing', async () => {
    await expect(
      refreshMarket(
        { db: getDb(), runtime: runtime() },
        { scopes: ['quotes'], listing: { symbol: 'NOPE', mic: 'XPAR' } },
      ),
    ).rejects.toThrow('Unknown listing');
  });
});

describe('purgeAllExpiredSessions', () => {
  it('removes only expired sessions and is idempotent', async () => {
    const [user] = await getDb()
      .insert(users)
      .values({ username: 'purge', passwordHash: 'x' })
      .returning();
    // The purge uses the database clock (now()), so expiries are relative to the real time.
    const mk = (c: string, offsetMs: number) => ({
      userId: user!.id,
      tokenHash: c.repeat(64),
      expiresAt: new Date(Date.now() + offsetMs),
    });
    await getDb()
      .insert(sessions)
      .values([mk('1', -3_600_000), mk('2', 3_600_000), mk('3', 30 * 86_400_000)]);
    expect(await purgeAllExpiredSessions(getDb())).toBe(1);
    expect(await purgeAllExpiredSessions(getDb())).toBe(0);
    expect(
      await getDb()
        .select({ n: sql<number>`count(*)::int` })
        .from(sessions),
    ).toEqual([{ n: 2 }]);
  });
});

describe('startWorker', () => {
  it('runs nightly then quotes on start and stop() waits for the running job', async () => {
    const rt = runtime();
    const timers: { fn: () => void; ms: number }[] = [];
    const worker = startWorker({
      ctx: { db: getDb(), runtime: rt },
      logger: silentLogger,
      setTimer: ((fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimer: (() => {}) as typeof clearTimeout,
    });
    // Catch-up on start: nightly first, then the first quote tick.
    for (let i = 0; i < 200 && provider.calls.quotes === 0; i += 1)
      await new Promise((r) => setTimeout(r, 50));
    await worker.stop();
    expect(provider.calls.history).toBe(2);
    expect(await getDb().select().from(listingMetrics)).toHaveLength(2);
    // Next nightly is scheduled at 03:30 UTC tomorrow (14.5 h from 13:00).
    expect(timers.some((t) => t.ms === 14.5 * 3_600_000)).toBe(true);
    expect(worker.lock.isRunning('nightly')).toBe(false);
    expect(worker.lock.isRunning('quotes')).toBe(false);
  });

  it('a nightly timer firing while the nightly still runs is skipped: no overlapping runs', async () => {
    const rt = runtime();
    let active = 0;
    let peak = 0;
    const original = provider.getDailyHistory.bind(provider);
    provider.getDailyHistory = async (...args) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      try {
        return await original(...args);
      } finally {
        active -= 1;
      }
    };
    const warnings: string[] = [];
    const timers: (() => void)[] = [];
    const worker = startWorker({
      ctx: { db: getDb(), runtime: rt },
      logger: { info() {}, warn: (m) => warnings.push(m), error() {} },
      setTimer: ((fn: () => void) => {
        timers.push(fn);
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimer: (() => {}) as typeof clearTimeout,
    });
    for (let i = 0; i < 100 && !worker.lock.isRunning('nightly'); i += 1)
      await new Promise((r) => setTimeout(r, 5));
    expect(worker.lock.isRunning('nightly')).toBe(true);
    timers[0]!(); // the scheduled 03:30 tick fires while the catch-up nightly is still running
    await new Promise((r) => setTimeout(r, 20));
    await worker.stop();
    expect(warnings).toContain('worker job skipped: previous run still in progress');
    expect(peak).toBe(1);
  });

  it('stop() right after start aborts between listings and returns with no job left running', async () => {
    const rt = runtime();
    const worker = startWorker({ ctx: { db: getDb(), runtime: rt }, logger: silentLogger });
    await worker.stop();
    expect(worker.lock.isRunning('nightly')).toBe(false);
    expect(provider.calls.quotes).toBe(0); // no new tick is scheduled after stop
  });
});
