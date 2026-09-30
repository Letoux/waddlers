import type { Database } from '../db/create';
import type { MarketDataEnv } from '../env';
import { marketDataConfigFromEnv, type MarketDataConfig } from './config';
import { EcbFxProvider } from './ecb-fx';
import { EodhdStubProvider } from './eodhd-stub';
import { FakeMarketDataProvider } from './fake-provider';
import { FakeFxProvider } from './fx-fake';
import { CallGuard, guardFxProvider, guardMarketDataProvider } from './guard';
import { recomputeListingMetrics } from './metrics';
import { DbUsageStore } from './repository';
import { MarketDataService } from './service';
import {
  silentLogger,
  type Clock,
  type FxProvider,
  type MarketDataProvider,
  type MarketLogger,
} from './types';

export interface MarketDataRuntime {
  service: MarketDataService;
  config: MarketDataConfig;
  /** Guarded providers (concurrency, timeout, retry, quota, redaction). */
  provider: MarketDataProvider;
  fx: FxProvider;
  recomputeMetrics(listingIds?: readonly string[]): Promise<{ computed: number }>;
  clock: Clock;
  logger: MarketLogger;
}

export interface RuntimeOverrides {
  clock?: Clock;
  logger?: MarketLogger;
  /** Replace the raw (unguarded) providers, e.g. with a fixture provider in tests. */
  provider?: MarketDataProvider;
  fx?: FxProvider;
  config?: Partial<MarketDataConfig>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  fetch?: typeof fetch;
}

/** Wires providers -> guard -> service -> metrics for the worker, the CLI and (later) the web app. */
export function createMarketDataRuntime(
  db: Database,
  env: MarketDataEnv,
  overrides: RuntimeOverrides = {},
): MarketDataRuntime {
  const clock = overrides.clock ?? (() => new Date());
  const logger = overrides.logger ?? silentLogger;
  const config: MarketDataConfig = { ...marketDataConfigFromEnv(env), ...overrides.config };
  const usage = new DbUsageStore(db);
  const secrets = [env.EODHD_API_TOKEN];

  const rawProvider: MarketDataProvider =
    overrides.provider ??
    (env.MARKET_DATA_PROVIDER === 'eodhd'
      ? new EodhdStubProvider()
      : new FakeMarketDataProvider({ clock }));
  const rawFx: FxProvider =
    overrides.fx ??
    (env.FX_PROVIDER === 'ecb'
      ? new EcbFxProvider({ clock, ...(overrides.fetch ? { fetch: overrides.fetch } : {}) })
      : new FakeFxProvider({ clock }));

  const guardOptions = {
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    baseDelayMs: config.retryBaseDelayMs,
    maxDelayMs: config.retryMaxDelayMs,
    dailyBudget: config.dailyQuota,
    usage,
    secrets,
    logger,
    clock,
    ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
    ...(overrides.random ? { random: overrides.random } : {}),
  };
  const provider = guardMarketDataProvider(
    rawProvider,
    new CallGuard({ ...guardOptions, provider: rawProvider.name }),
  );
  const fx = guardFxProvider(
    rawFx,
    new CallGuard({ ...guardOptions, provider: rawFx.name, usageKey: `fx_${rawFx.name}` }),
  );

  const recomputeMetrics = (listingIds?: readonly string[]) =>
    recomputeListingMetrics(db, {
      ...(listingIds ? { listingIds } : {}),
      now: clock(),
      config,
    });
  const service = new MarketDataService({
    db,
    provider,
    fx,
    config,
    clock,
    logger,
    onListingsUpdated: async (ids) => {
      await recomputeMetrics(ids);
    },
  });
  return { service, config, provider, fx, recomputeMetrics, clock, logger };
}
