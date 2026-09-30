import type { PlainDate } from '@waddlers/domain';
import { redactSecrets, safeErrorMessage } from './redact';
import {
  NotConfiguredError,
  RETRYABLE_CODES,
  fail,
  silentLogger,
  type CallOptions,
  type Clock,
  type FxBatch,
  type FxProvider,
  type HistoryBatch,
  type ListingRef,
  type MarketDataProvider,
  type MarketLogger,
  type ProviderResult,
  type QuoteBatch,
  type SearchHit,
} from './types';

/** Persisted daily counter (`provider_usage`); in-memory fakes implement the same contract. */
export interface UsageStore {
  /**
   * Atomically counts one provider call for (provider, UTC day) and returns true, or returns
   * false WITHOUT counting when it would exceed `budget`.
   */
  reserve(provider: string, day: PlainDate, budget: number): Promise<boolean>;
}

export interface GuardOptions {
  /** Provider name reported in results and logs (matches the `source` it writes). */
  provider: string;
  /** Key of the persisted daily counter (`provider_usage.provider`); defaults to `provider`. */
  usageKey?: string;
  /** Simultaneous provider calls (semaphore). */
  concurrency: number;
  /** Per-attempt timeout. */
  timeoutMs: number;
  /** Total attempts including the first (retry only transient errors). */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Calls per UTC day; every attempt counts. */
  dailyBudget: number;
  usage: UsageStore;
  /** Secret values to scrub from messages, in addition to the pattern-based redaction. */
  secrets?: readonly (string | undefined)[];
  logger?: MarketLogger;
  clock?: Clock;
  /** Injected for tests; default is real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Returns a number in [0, 1); injected for deterministic tests. */
  random?: () => number;
}

class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      // The releasing task hands its slot over directly (active stays unchanged).
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wraps provider calls with: concurrency limit, per-attempt timeout, retry with full jitter for
 * TRANSIENT errors only, the persisted daily quota, and secret redaction. `run` never throws.
 */
export class CallGuard {
  private readonly semaphore: Semaphore;
  private readonly logger: MarketLogger;
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: GuardOptions) {
    this.semaphore = new Semaphore(Math.max(1, options.concurrency));
    this.logger = options.logger ?? silentLogger;
    this.clock = options.clock ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  async run<T>(
    operation: string,
    call: (options: CallOptions) => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    const { provider } = this.options;
    let last: ProviderResult<T> = fail(provider, 'network', 'no attempt made');
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      last = await this.semaphore.run(() => this.attempt(operation, call));
      if (last.ok || !RETRYABLE_CODES.has(last.code) || attempt === this.options.maxAttempts) break;
      // Full jitter: uniform in [0, min(max, base * 2^(attempt-1))].
      const ceiling = Math.min(
        this.options.maxDelayMs,
        this.options.baseDelayMs * 2 ** (attempt - 1),
      );
      await this.sleep(Math.floor(this.random() * ceiling));
    }
    if (!last.ok) {
      this.logger.warn('market-data provider call failed', {
        provider,
        operation,
        code: last.code,
        message: last.message,
      });
    }
    return last;
  }

  private async attempt<T>(
    operation: string,
    call: (options: CallOptions) => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    const { provider, secrets } = this.options;
    const day = this.clock().toISOString().slice(0, 10);
    if (!(await this.reserveQuota(day))) {
      return fail(provider, 'local_quota', 'daily provider quota exhausted');
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ProviderResult<T>>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(
          fail(provider, 'timeout', `${operation} timed out after ${this.options.timeoutMs} ms`),
        );
      }, this.options.timeoutMs);
    });
    try {
      const result = await Promise.race([call({ signal: controller.signal }), timeout]);
      // Adapters may echo URLs in messages: scrub again at the boundary.
      return result.ok ? result : { ...result, message: redactSecrets(result.message, secrets) };
    } catch (error) {
      if (error instanceof NotConfiguredError)
        return fail(provider, 'not_configured', error.message);
      // Adapters should not throw; if one does, classify as transient and never leak the text.
      return fail(provider, 'network', safeErrorMessage(error, secrets));
    } finally {
      clearTimeout(timer);
    }
  }

  private async reserveQuota(day: PlainDate): Promise<boolean> {
    try {
      return await this.options.usage.reserve(
        this.options.usageKey ?? this.options.provider,
        day,
        this.options.dailyBudget,
      );
    } catch {
      // Cannot prove we are within budget: refuse rather than risk overrunning a paid quota.
      return false;
    }
  }
}

/** Provider whose every call goes through the guard. */
export function guardMarketDataProvider(
  provider: MarketDataProvider,
  guard: CallGuard,
): MarketDataProvider {
  const guarded: MarketDataProvider = {
    name: provider.name,
    getQuotes: (listings: readonly ListingRef[]) =>
      guard.run<QuoteBatch>('getQuotes', (o) => provider.getQuotes(listings, o)),
    getDailyHistory: (listing: ListingRef, from: PlainDate, to: PlainDate) =>
      guard.run<HistoryBatch>('getDailyHistory', (o) =>
        provider.getDailyHistory(listing, from, to, o),
      ),
  };
  const search = provider.search?.bind(provider);
  if (search) {
    guarded.search = (query: string) => guard.run<SearchHit[]>('search', (o) => search(query, o));
  }
  return guarded;
}

export function guardFxProvider(provider: FxProvider, guard: CallGuard): FxProvider {
  return {
    name: provider.name,
    getDailyRates: (from: PlainDate, to: PlainDate) =>
      guard.run<FxBatch>('getDailyRates', (o) => provider.getDailyRates(from, to, o)),
  };
}
