import { sql } from 'drizzle-orm';
import { getDb } from '../src/db/client';
import type { MarketDataConfig } from '../src/market-data/config';
import { MarketDataService } from '../src/market-data/service';
import {
  fail,
  ok,
  type FxProvider,
  type HistoryBatch,
  type ListingRef,
  type MarketDataProvider,
  type ProviderResult,
  type QuoteBatch,
} from '../src/market-data/types';
import { loadListingRefs } from '../src/market-data/repository';

/** Controllable clock: tests move time explicitly. */
export class TestClock {
  constructor(private ms: number) {}
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
  set(iso: string): void {
    this.ms = new Date(iso).getTime();
  }
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export const testConfig: MarketDataConfig = {
  quoteTtlMs: 15 * MIN,
  historyTtlMs: 12 * HOUR,
  fxTtlMs: 12 * HOUR,
  blockingFetchMs: 100,
  backoffBaseMs: MIN,
  backoffMaxMs: 6 * HOUR,
  incrementalOverlapDays: 5,
  fxToleranceDays: 7,
  dailyQuota: 1000,
  concurrency: 4,
  timeoutMs: 1000,
  maxAttempts: 1,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 1,
};

/** Wipes every market-data table (listings/exchanges cascade to the per-listing ones). */
export async function resetMarketTables(): Promise<void> {
  await getDb().execute(
    sql`truncate table users, spaces, instruments, exchanges, fx_daily, provider_usage, market_data_fetch_state cascade`,
  );
}

export interface SpyOptions {
  /** Price returned for every listing. */
  price?: string;
  delayMs?: number;
  /** When set, every call fails with this code. */
  failWith?: 'network' | 'upstream_error' | 'unauthorized';
  clock: () => Date;
  /** Bars returned by getDailyHistory: `[date, close]`. */
  bars?: [string, string][];
  reachedStart?: boolean;
}

/** Spy provider: records calls and answers deterministically (never a real network call). */
export class SpyProvider implements MarketDataProvider {
  readonly name = 'fake';
  readonly quoteCalls: string[][] = [];
  readonly historyCalls: { listingId: string; from: string; to: string }[] = [];
  constructor(public options: SpyOptions) {}

  private async pause(): Promise<void> {
    if (this.options.delayMs) await new Promise((r) => setTimeout(r, this.options.delayMs));
  }

  async getQuotes(listings: readonly ListingRef[]): Promise<ProviderResult<QuoteBatch>> {
    this.quoteCalls.push(listings.map((l) => l.id));
    await this.pause();
    if (this.options.failWith) return fail('fake', this.options.failWith, 'spy failure');
    const asOf = this.options.clock();
    return ok(
      'fake',
      {
        quotes: listings.map((l) => ({
          listingId: l.id,
          price: this.options.price ?? '100.5',
          currency: l.currency,
          asOf,
        })),
        rejected: [],
      },
      asOf,
    );
  }

  async getDailyHistory(
    listing: ListingRef,
    from: string,
    to: string,
  ): Promise<ProviderResult<HistoryBatch>> {
    this.historyCalls.push({ listingId: listing.id, from, to });
    await this.pause();
    if (this.options.failWith) return fail('fake', this.options.failWith, 'spy failure');
    const bars = (this.options.bars ?? [])
      .filter(([d]) => d >= from && d <= to)
      .map(([date, close]) => ({ date, close, adjClose: null }));
    return ok(
      'fake',
      { bars, rejectedRows: 0, reachedStart: this.options.reachedStart ?? true },
      this.options.clock(),
    );
  }
}

export class SpyFx implements FxProvider {
  readonly name = 'fake';
  calls: { from: string; to: string }[] = [];
  constructor(
    private readonly rates: { date: string; currency: string; ratePerEur: string }[] = [],
  ) {}
  async getDailyRates(from: string, to: string) {
    this.calls.push({ from, to });
    const rates = this.rates.filter((r) => r.date >= from && r.date <= to);
    return ok('fake', { rates, rejectedRows: 0 }, new Date());
  }
}

export function makeService(
  provider: MarketDataProvider,
  clock: TestClock,
  fx: FxProvider = new SpyFx(),
) {
  return new MarketDataService({
    db: getDb(),
    provider,
    fx,
    config: testConfig,
    clock: clock.now,
  });
}

export async function refFor(listingId: string, provider = 'fake'): Promise<ListingRef> {
  const [ref] = await loadListingRefs(getDb(), { provider, ids: [listingId] });
  return ref!;
}
