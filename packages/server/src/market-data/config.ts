import type { MarketDataEnv } from '../env';

/** Runtime settings of the market-data layer, derived from validated env (all durations in ms). */
export interface MarketDataConfig {
  quoteTtlMs: number;
  historyTtlMs: number;
  fxTtlMs: number;
  /** Upper bound a request waits for a MISSING value before answering `unavailable`. */
  blockingFetchMs: number;
  /** Backoff after consecutive failures: base * 2^(failures-1), capped. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Incremental history re-pulls this many trailing days (late corrections). */
  incrementalOverlapDays: number;
  /** FX rate older than this (vs the price date) is treated as missing, never carried forward silently. */
  fxToleranceDays: number;
  dailyQuota: number;
  concurrency: number;
  timeoutMs: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function marketDataConfigFromEnv(env: MarketDataEnv): MarketDataConfig {
  return {
    quoteTtlMs: env.MARKET_DATA_QUOTE_TTL_MINUTES * MINUTE,
    historyTtlMs: env.MARKET_DATA_HISTORY_TTL_HOURS * HOUR,
    fxTtlMs: env.MARKET_DATA_FX_TTL_HOURS * HOUR,
    blockingFetchMs: 5000,
    backoffBaseMs: MINUTE,
    backoffMaxMs: 6 * HOUR,
    incrementalOverlapDays: 5,
    fxToleranceDays: 7,
    dailyQuota: env.MARKET_DATA_DAILY_QUOTA,
    concurrency: env.MARKET_DATA_CONCURRENCY,
    timeoutMs: env.MARKET_DATA_TIMEOUT_MS,
    maxAttempts: 3,
    retryBaseDelayMs: 500,
    retryMaxDelayMs: 8000,
  };
}

/** Exponential backoff for the n-th consecutive failure (n >= 1), capped. Deterministic. */
export function backoffMs(config: MarketDataConfig, failureCount: number): number {
  const n = Math.max(1, failureCount);
  return Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** Math.min(n - 1, 30));
}
