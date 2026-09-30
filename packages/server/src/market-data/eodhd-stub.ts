import {
  NotConfiguredError,
  type HistoryBatch,
  type MarketDataProvider,
  type ProviderResult,
  type QuoteBatch,
  type SearchHit,
} from './types';

/**
 * Placeholder for the EODHD adapter (D1). It is NOT implemented on purpose: the plan/coverage
 * check with the user must happen first. Every method throws `NotConfiguredError`, which the
 * call guard turns into a non-retryable `not_configured` failure, so the service reports
 * unavailable data instead of inventing any.
 */
export class EodhdStubProvider implements MarketDataProvider {
  readonly name = 'eodhd';

  getQuotes(): Promise<ProviderResult<QuoteBatch>> {
    throw new NotConfiguredError('eodhd');
  }

  getDailyHistory(): Promise<ProviderResult<HistoryBatch>> {
    throw new NotConfiguredError('eodhd');
  }

  search(): Promise<ProviderResult<SearchHit[]>> {
    throw new NotConfiguredError('eodhd');
  }
}
