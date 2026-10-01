import type { DashboardPeriod, FxCell, MoneyCell, PerfCell } from '@waddlers/contracts';
import { describe, expect, it } from 'vitest';
import { buildValues, type TableRowData } from './table-cells';

const TODAY = '2026-09-30';
const noPerf = { value: null, baseDate: null, reason: 'history_too_short' };

function row(
  over: Partial<TableRowData> = {},
  metrics?: Partial<NonNullable<TableRowData['metrics']>>,
) {
  const base: TableRowData = {
    quantity: '10',
    selectionReason: null,
    instrumentName: 'Air Liquide',
    instrumentType: 'stock',
    sector: null,
    description: null,
    symbol: 'AI',
    exchangeName: 'Euronext Paris',
    currency: 'EUR',
    metrics: {
      asOfDate: '2026-09-30',
      price: '100',
      priceCurrency: 'EUR',
      priceEur: '100',
      priceEurReason: null,
      fxRatePerEur: null,
      fxRateDate: null,
      perf: { '1w': noPerf, '1m': noPerf, '6m': noPerf, '1y': noPerf, '5y': noPerf, max: noPerf },
      ...metrics,
    },
  };
  return { ...base, ...over };
}
const get = <T>(
  r: TableRowData,
  id: Parameters<typeof buildValues>[1][number],
  period: DashboardPeriod = '1m',
) => buildValues(r, [id], period, TODAY)[id] as T;

describe('price cells', () => {
  it('GBX: local price stays in pence, EUR price comes from the stored conversion, rate is EUR per unit', () => {
    const r = row(
      { currency: 'GBX' },
      {
        price: '2000',
        priceCurrency: 'GBX',
        priceEur: '25',
        fxRatePerEur: '0.8',
        fxRateDate: '2026-09-30',
      },
    );
    expect(get<MoneyCell>(r, 'price')).toMatchObject({ amount: '2000', currency: 'GBX' });
    expect(get<MoneyCell>(r, 'price_eur')).toMatchObject({ amount: '25', currency: 'EUR' });
    // 1 GBX = 1 / 0.8 / 100 EUR
    expect(get<FxCell>(r, 'fx_rate')).toMatchObject({
      eurPerUnit: '0.0125',
      rateDate: '2026-09-30',
    });
  });

  it('USD rate direction (1 USD = 0.8 EUR) and EUR is exactly 1 without a rate date', () => {
    const usd = row(
      { currency: 'USD' },
      { priceCurrency: 'USD', fxRatePerEur: '1.25', fxRateDate: '2026-09-29' },
    );
    expect(get<FxCell>(usd, 'fx_rate')).toMatchObject({
      eurPerUnit: '0.8',
      rateDate: '2026-09-29',
    });
    expect(get<FxCell>(row(), 'fx_rate')).toMatchObject({
      eurPerUnit: '1',
      rateDate: null,
      isStale: false,
    });
  });

  it('a missing rate is null, never 1', () => {
    const r = row(
      { currency: 'USD' },
      { priceCurrency: 'USD', priceEur: null, priceEurReason: 'rate_missing' },
    );
    expect(get<FxCell>(r, 'fx_rate').eurPerUnit).toBeNull();
    expect(get<MoneyCell>(r, 'price_eur')).toMatchObject({ amount: null, reason: 'rate_missing' });
  });

  it('staleness: price older than 5 days, rate older than 7 days (boundaries 5/6 and 7/8)', () => {
    const at = (asOfDate: string, fxRateDate: string | null = null) =>
      row(
        { currency: 'USD' },
        { priceCurrency: 'USD', asOfDate, fxRateDate, fxRatePerEur: '1.25' },
      );
    expect(get<MoneyCell>(at('2026-09-25'), 'price').isStale).toBe(false); // 5 days
    expect(get<MoneyCell>(at('2026-09-24'), 'price').isStale).toBe(true); // 6 days
    expect(get<MoneyCell>(at('2026-09-30', '2026-09-23'), 'price_eur').isStale).toBe(false); // fx 7
    expect(get<MoneyCell>(at('2026-09-30', '2026-09-22'), 'price_eur').isStale).toBe(true); // fx 8
    expect(get<MoneyCell>(at('2026-09-30', '2026-09-22'), 'price').isStale).toBe(false);
    expect(get<PerfCell>(at('2026-09-24'), 'perf_1y').isStale).toBe(true);
  });

  it('no metrics row: null with a reason, not stale, nothing invented', () => {
    const r = row({ metrics: null });
    expect(get<MoneyCell>(r, 'price')).toMatchObject({
      amount: null,
      reason: 'metrics_missing',
      isStale: false,
    });
    expect(get<PerfCell>(r, 'perf_1y')).toMatchObject({ value: null, reason: 'metrics_missing' });
    expect(get(r, 'price_date')).toBeNull();
  });
});

describe('perf and tracked value', () => {
  const perf = { value: '12.34560000', baseDate: '2025-09-30', reason: null };

  it('perf_period resolves to the requested period and carries base date and reason', () => {
    const r = row(
      {},
      { perf: { '1w': noPerf, '1m': noPerf, '6m': noPerf, '1y': perf, '5y': noPerf, max: noPerf } },
    );
    expect(get<PerfCell>(r, 'perf_period', '1y')).toMatchObject({
      value: '12.3456',
      baseDate: '2025-09-30',
      reason: null,
    });
    expect(get<PerfCell>(r, 'perf_period', '1m')).toMatchObject({
      value: null,
      reason: 'history_too_short',
    });
    expect(get<PerfCell>(r, 'perf_1y').value).toBe('12.3456');
  });

  it('tracked value = quantity x EUR price; watchlist and missing price are null with a reason', () => {
    expect(
      get<MoneyCell>(row({ quantity: '10.5' }, { priceEur: '99.99' }), 'tracked_value_eur'),
    ).toMatchObject({
      amount: '1049.895',
      currency: 'EUR',
    });
    expect(get<MoneyCell>(row({ quantity: null }), 'tracked_value_eur')).toMatchObject({
      amount: null,
      reason: 'watchlist',
    });
    expect(
      get<MoneyCell>(
        row({}, { priceEur: null, priceEurReason: 'rate_missing' }),
        'tracked_value_eur',
      ),
    ).toMatchObject({ amount: null, reason: 'rate_missing' });
    // a real zero quantity is a real zero value, not a missing one
    expect(get<MoneyCell>(row({ quantity: '0.00000000' }), 'tracked_value_eur').amount).toBe('0');
  });

  it('quantity is canonical and null stays null (watchlist, never 0)', () => {
    expect(get(row({ quantity: '12.50000000' }), 'quantity')).toBe('12.5');
    expect(get(row({ quantity: null }), 'quantity')).toBeNull();
  });
});

describe('text cells', () => {
  it('ETF has no sector (specs 24): the query hands null, the cell keeps it null', () => {
    const etf = row({ instrumentType: 'etf', sector: null });
    expect(get(etf, 'sector')).toBeNull();
    expect(get(etf, 'instrument_type')).toBe('etf');
  });
});
