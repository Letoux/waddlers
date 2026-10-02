import type {
  DashboardPeriod,
  FxCell,
  MoneyCell,
  PerfCell,
  TableCell,
  TableColumnId,
  TableValues,
} from '@waddlers/contracts';
import { TABLE_COLUMNS_BY_ID } from '@waddlers/contracts';
import { Decimal, diffDays, eurPerUnit, normalizeCurrency, parseDecimal } from '@waddlers/domain';
import { STALE_AFTER_DAYS, wire } from '../dashboard/compute';
import { FX_TOLERANCE_DAYS } from '../market-data/config';
import { METRIC_PERIODS } from '../db/schema';

type MetricPeriod = (typeof METRIC_PERIODS)[number];

export interface PerfSource {
  value: string | null;
  baseDate: string | null;
  reason: string | null;
}

/** What the table query reads per position (one row per position; `metrics` null = no row yet). */
export interface TableRowData {
  quantity: string | null;
  selectionReason: string | null;
  instrumentName: string;
  instrumentType: 'stock' | 'etf';
  /** Already NULL for an ETF (specs 24), see `sectorExpr`. */
  sector: string | null;
  description: string | null;
  symbol: string;
  exchangeName: string;
  /** Raw listing currency (GBX stays pence). */
  currency: string;
  metrics: {
    asOfDate: string | null;
    price: string | null;
    priceCurrency: string;
    /** D25: computed in SQL with the dashboard's current rule (table-fx.ts), full precision. */
    priceEur: string | null;
    /** quantity x priceEur in SQL (full precision); null for a watchlist entry or without a EUR price. */
    trackedValueEur: string | null;
    fxRatePerEur: string | null;
    fxRateDate: string | null;
    perf: Record<MetricPeriod, PerfSource>;
  } | null;
}

const decimal = (value: string | null): string | null => wire(parseDecimal(value));
const isOld = (date: string | null, today: string, days: number) =>
  date !== null && diffDays(date, today) > days;

/** Why there is no EUR price (the dashboard's `missing` reasons: price_missing, price_invalid, currency_invalid, fx_missing). */
function priceEurReason(m: NonNullable<TableRowData['metrics']>): string {
  const price = parseDecimal(m.price);
  if (price === null) return 'price_missing';
  if (!price.gt(0)) return 'price_invalid';
  return normalizeCurrency(m.priceCurrency) === null ? 'currency_invalid' : 'fx_missing';
}

function priceCells(row: TableRowData, today: string) {
  const m = row.metrics;
  const asOf = m?.asOfDate ?? null;
  const priceStale = isOld(asOf, today, STALE_AFTER_DAYS);
  const fxStale = isOld(m?.fxRateDate ?? null, today, FX_TOLERANCE_DAYS);
  const price: MoneyCell = {
    kind: 'money',
    amount: decimal(m?.price ?? null),
    currency: m?.priceCurrency ?? row.currency,
    asOf,
    isStale: priceStale,
    reason: m === null ? 'metrics_missing' : m.price === null ? 'price_missing' : null,
  };
  const eur = parseDecimal(m?.priceEur ?? null);
  const eurWire = decimal(m?.priceEur ?? null);
  // A positive price that rounds to 0 at wire scale is "too small to show", never a displayed 0.
  const roundsToZero =
    eur !== null && eur.gt(0) && eurWire !== null && new Decimal(eurWire).isZero();
  const priceEur: MoneyCell = {
    kind: 'money',
    amount: roundsToZero ? null : eurWire,
    currency: 'EUR',
    asOf,
    isStale: priceStale || fxStale,
    reason:
      m === null
        ? 'metrics_missing'
        : roundsToZero
          ? 'rounds_to_zero'
          : m.priceEur === null
            ? priceEurReason(m)
            : null,
  };
  return { price, priceEur, fxStale };
}

/** Specs 34 direction (EUR for 1 unit). EUR is exactly 1 and needs no rate; a missing rate is null, never 1. */
function fxCell(row: TableRowData, today: string): FxCell {
  const m = row.metrics;
  const currency = m?.priceCurrency ?? row.currency;
  const normalized = normalizeCurrency(currency);
  const base = { kind: 'fx' as const, currency, rateDate: m?.fxRateDate ?? null };
  const isStale = isOld(base.rateDate, today, FX_TOLERANCE_DAYS);
  if (normalized === null) return { ...base, eurPerUnit: null, isStale };
  if (normalized.currency === 'EUR')
    return { ...base, eurPerUnit: '1', rateDate: null, isStale: false };
  const rate = parseDecimal(m?.fxRatePerEur ?? null);
  const inverse =
    rate === null ? null : eurPerUnit(currency, new Map([[normalized.currency, rate]]));
  return { ...base, eurPerUnit: wire(inverse), isStale };
}

function perfCell(row: TableRowData, period: MetricPeriod, today: string): PerfCell {
  const m = row.metrics;
  const asOf = m?.asOfDate ?? null;
  const p = m?.perf[period];
  return {
    kind: 'perf',
    value: decimal(p?.value ?? null),
    baseDate: p?.baseDate ?? null,
    reason: m === null ? 'metrics_missing' : (p?.reason ?? null),
    asOf,
    isStale: isOld(asOf, today, STALE_AFTER_DAYS),
  };
}

/**
 * Quantity x EUR price (D25: computed in SQL, the dashboard's rule). Null for a watchlist entry
 * (`watchlist`) or without a EUR price (its reason); 0 is a real 0. A null amount is never "stale".
 */
function trackedValue(row: TableRowData, priceEur: MoneyCell): MoneyCell {
  if (parseDecimal(row.quantity) === null)
    return { ...priceEur, amount: null, isStale: false, reason: 'watchlist' };
  const amount = decimal(row.metrics?.trackedValueEur ?? null);
  if (amount === null) return { ...priceEur, amount: null, isStale: false };
  return { ...priceEur, amount, reason: null };
}

const PERF_COLUMN: Partial<Record<TableColumnId, MetricPeriod>> = {
  perf_1w: '1w',
  perf_1m: '1m',
  perf_6m: '6m',
  perf_1y: '1y',
  perf_5y: '5y',
  perf_max: 'max',
};

/**
 * `values` of one row for the requested columns. Pending (S8) columns are always `null`, never
 * computed. `perf_period` resolves to the requested period; nothing is converted to 0.
 */
export function buildValues(
  row: TableRowData,
  columns: readonly TableColumnId[],
  period: DashboardPeriod,
  today: string,
): TableValues {
  const { price, priceEur } = priceCells(row, today);
  const out: TableValues = {};
  for (const id of columns) {
    const def = TABLE_COLUMNS_BY_ID.get(id);
    if (def?.availability !== 'available') {
      out[id] = null;
      continue;
    }
    // `row` columns (quantity) have no entry in `values`: the row field is the single source.
    if (def.cell === 'row') continue;
    const cell: TableCell = (() => {
      switch (id) {
        case 'name':
          return row.instrumentName;
        case 'symbol':
          return row.symbol;
        case 'instrument_type':
          return row.instrumentType;
        case 'exchange':
          return row.exchangeName;
        case 'selection_reason':
          return row.selectionReason;
        case 'currency':
          return row.currency;
        case 'sector':
          return row.sector;
        case 'description':
          return row.description;
        case 'price':
          return price;
        case 'fx_rate':
          return fxCell(row, today);
        case 'price_eur':
          return priceEur;
        case 'price_date':
          return row.metrics?.asOfDate ?? null;
        case 'perf_period':
          return perfCell(row, period, today);
        case 'tracked_value_eur':
          return trackedValue(row, priceEur);
        default: {
          const p = PERF_COLUMN[id];
          return p === undefined ? null : perfCell(row, p, today);
        }
      }
    })();
    out[id] = cell;
  }
  return out;
}
