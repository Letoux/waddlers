import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from './client';
import { fxDaily, listingMetrics, marketDataFetchState, quoteLatest } from './schema';
import { ensureReferenceData } from '../../test/space-fixtures';
import { releaseTestEnv, useTestEnv } from '../../test/auth-harness';
import { resetMarketTables } from '../../test/market-fixtures';

beforeAll(useTestEnv);
afterAll(releaseTestEnv);

let listingId: string;
beforeEach(async () => {
  await resetMarketTables();
  listingId = (await ensureReferenceData()).ai.listingId;
});

const violation = { cause: { code: '23514' } };
const now = new Date('2026-09-30T10:00:00Z');

describe('migration 0004 (market data)', () => {
  it('created every market-data table, cascading from listings', async () => {
    const rows = await getDb().execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = new Set(rows.map((r) => r.table_name));
    for (const t of [
      'price_daily',
      'quote_latest',
      'fx_daily',
      'market_data_fetch_state',
      'provider_usage',
      'listing_metrics',
    ]) {
      expect(names.has(t)).toBe(true);
    }
  });

  it.each(['0', '-1', 'NaN'])('quote_latest rejects price %s', async (price) => {
    await expect(
      getDb()
        .insert(quoteLatest)
        .values({ listingId, price, currency: 'EUR', asOf: now, source: 'fake', fetchedAt: now }),
    ).rejects.toMatchObject(violation);
  });

  it('fx_daily rejects a zero rate and EUR itself', async () => {
    const row = {
      rateDate: '2026-09-29',
      currency: 'USD',
      ratePerEur: '0',
      source: 'fake',
      fetchedAt: now,
    };
    await expect(getDb().insert(fxDaily).values(row)).rejects.toMatchObject(violation);
    await expect(
      getDb()
        .insert(fxDaily)
        .values({ ...row, ratePerEur: '1', currency: 'EUR' }),
    ).rejects.toMatchObject(violation);
  });

  it('fetch state: a single FX row despite the NULL listing_id, and scope is enforced', async () => {
    const fx = { kind: 'fx' as const, listingId: null };
    await getDb().insert(marketDataFetchState).values(fx);
    await expect(getDb().insert(marketDataFetchState).values(fx)).rejects.toMatchObject({
      cause: { code: '23505' },
    });
    await expect(
      getDb().insert(marketDataFetchState).values({ kind: 'quote', listingId: null }),
    ).rejects.toMatchObject(violation);
    await expect(
      getDb().insert(marketDataFetchState).values({ kind: 'fx', listingId }),
    ).rejects.toMatchObject(violation);
  });

  it('listing_metrics forbids a value without base date and a NULL without a reason', async () => {
    const base = { listingId, computedAt: now, priceCurrency: 'EUR' };
    await expect(
      getDb()
        .insert(listingMetrics)
        .values({ ...base, perf1w: '5' }),
    ).rejects.toMatchObject(violation);
    await expect(
      getDb()
        .insert(listingMetrics)
        .values({
          ...base,
          priceEurReason: null,
          price: '1',
          priceBasis: 'close',
          asOfDate: '2026-09-29',
        }),
    ).rejects.toMatchObject(violation);
  });
});
