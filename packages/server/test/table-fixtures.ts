import { randomUUID } from 'node:crypto';
import { getDb } from '../src/db/client';
import {
  exchanges,
  instruments,
  listingMetrics,
  listings,
  spacePositions,
  type InstrumentType,
} from '../src/db/schema';

/** Direct (hand-written) rows for the table tests: no provider, no recompute, exact values. */

export const PERIOD_KEYS = ['1w', '1m', '6m', '1y', '5y', 'max'] as const;
type PeriodKey = (typeof PERIOD_KEYS)[number];
const SUFFIX: Record<PeriodKey, string> = {
  '1w': '1w',
  '1m': '1m',
  '6m': '6m',
  '1y': '1y',
  '5y': '5y',
  max: 'Max',
};

export interface MetricsSpec {
  asOfDate?: string | null;
  price?: string | null;
  priceCurrency?: string;
  priceEur?: string | null;
  priceEurReason?: string;
  fxRatePerEur?: string | null;
  fxRateDate?: string | null;
  /** Percent per period; absent or null = unavailable with a reason. */
  perf?: Partial<Record<PeriodKey, string | null>>;
  computedAt?: Date;
}

export interface EntrySpec {
  name: string;
  symbol: string;
  isin?: string;
  sector?: string | null;
  description?: string | null;
  type?: InstrumentType;
  mic?: string;
  currency?: string;
  /** `undefined` = 1, `null` = watchlist entry. */
  quantity?: string | null;
  reason?: string | null;
  /** `false` = no listing_metrics row at all. */
  metrics?: false | MetricsSpec;
}

export const TEST_EXCHANGES = [
  { mic: 'XPAR', name: 'Euronext Paris', timezone: 'Europe/Paris', country: 'FR' },
  { mic: 'XNAS', name: 'Nasdaq', timezone: 'America/New_York', country: 'US' },
  { mic: 'XLON', name: 'London Stock Exchange', timezone: 'Europe/London', country: 'GB' },
] as const;

export async function ensureExchanges(): Promise<void> {
  await getDb()
    .insert(exchanges)
    .values([...TEST_EXCHANGES])
    .onConflictDoNothing();
}

function metricsRow(listingId: string, m: MetricsSpec, currency: string, now: Date) {
  const price = m.price === undefined ? '100' : m.price;
  const row: Record<string, unknown> = {
    listingId,
    computedAt: m.computedAt ?? now,
    asOfDate: price === null ? null : (m.asOfDate ?? '2026-09-30'),
    price,
    priceCurrency: m.priceCurrency ?? currency,
    priceBasis: price === null ? null : 'close',
    priceEur: m.priceEur === undefined ? price : m.priceEur,
    priceEurReason: null,
    fxRatePerEur: m.fxRatePerEur ?? null,
    fxRateDate: m.fxRateDate ?? null,
  };
  if (row.priceEur === null) row.priceEurReason = m.priceEurReason ?? 'price_missing';
  for (const p of PERIOD_KEYS) {
    const value = m.perf?.[p] ?? null;
    row[`perf${SUFFIX[p]}`] = value;
    row[`perf${SUFFIX[p]}BaseDate`] = value === null ? null : '2025-09-30';
    row[`perf${SUFFIX[p]}Reason`] = value === null ? 'history_too_short' : null;
  }
  return row as typeof listingMetrics.$inferInsert;
}

/** isin for generated rows: 2 letters + 9 base-36 digits + check digit placeholder (format only). */
export const fakeIsin = (n: number) => `ZZ${n.toString(36).toUpperCase().padStart(9, '0')}0`;

/** Inserts the entries into the space (chunked); returns the position ids in input order. */
export async function seedEntries(
  spaceId: string,
  specs: readonly EntrySpec[],
  now: Date = new Date('2026-09-30T12:00:00Z'),
): Promise<string[]> {
  const db = getDb();
  const positionIds: string[] = [];
  for (let from = 0; from < specs.length; from += 500) {
    const chunk = specs.slice(from, from + 500).map((s) => ({
      s,
      instrumentId: randomUUID(),
      listingId: randomUUID(),
      positionId: randomUUID(),
    }));
    await db.insert(instruments).values(
      chunk.map(({ s, instrumentId }) => ({
        id: instrumentId,
        type: s.type ?? 'stock',
        name: s.name,
        isin: s.isin ?? null,
        sector: s.sector ?? null,
        description: s.description ?? null,
      })),
    );
    await db.insert(listings).values(
      chunk.map(({ s, instrumentId, listingId }) => ({
        id: listingId,
        instrumentId,
        exchangeMic: s.mic ?? 'XPAR',
        symbol: s.symbol,
        currency: s.currency ?? 'EUR',
      })),
    );
    const metrics = chunk.flatMap(({ s, listingId }) =>
      s.metrics === false ? [] : [metricsRow(listingId, s.metrics ?? {}, s.currency ?? 'EUR', now)],
    );
    if (metrics.length > 0) await db.insert(listingMetrics).values(metrics);
    await db.insert(spacePositions).values(
      chunk.map(({ s, instrumentId, listingId, positionId }) => ({
        id: positionId,
        spaceId,
        instrumentId,
        listingId,
        quantity: s.quantity === undefined ? '1' : s.quantity,
        selectionReason: s.reason ?? null,
      })),
    );
    positionIds.push(...chunk.map((c) => c.positionId));
  }
  return positionIds;
}

const perf = (
  a: string | null,
  b: string | null,
  c: string | null,
  d: string | null,
  e: string | null,
  f: string | null,
) => ({ '1w': a, '1m': b, '6m': c, '1y': d, '5y': e, max: f }) as const;

/**
 * Eight entries with ties (price 50, perf 1y 10.5, sector, currency), nulls (watchlist, no price,
 * ETF without sector, no metrics row at all) and one stale price. Hand-picked, not random.
 */
export const SORT_DATASET: EntrySpec[] = [
  {
    name: 'Alpha',
    symbol: 'AAA',
    isin: 'FR0000120073',
    sector: 'Energie',
    mic: 'XPAR',
    quantity: '10',
    reason: 'Place principale',
    metrics: {
      price: '50',
      perf: perf('1', '2', '3', '10.5', '20', '30'),
      computedAt: new Date('2026-09-30T08:00:00Z'),
    },
  },
  {
    name: 'bravo',
    symbol: 'BBB',
    sector: 'Energie',
    mic: 'XPAR',
    quantity: '5',
    reason: 'Place principale',
    metrics: { price: '50', perf: perf('-1', '0', '4', '10.5', '21', '31') },
  },
  {
    name: 'Charlie',
    symbol: 'CCC',
    sector: 'Finance',
    mic: 'XNAS',
    currency: 'USD',
    quantity: '2',
    metrics: {
      price: '200',
      priceEur: '160',
      fxRatePerEur: '1.25',
      fxRateDate: '2026-09-30',
      perf: perf('5', '5', '-5', '-3.2', '8', '9'),
    },
  },
  {
    name: 'delta',
    symbol: 'DDD',
    type: 'etf',
    sector: 'Finance',
    mic: 'XPAR',
    quantity: null,
    metrics: { price: '10', perf: perf('0.5', '1.5', null, null, null, null) },
  },
  {
    name: 'Echo',
    symbol: 'EEE',
    sector: 'Finance',
    mic: 'XLON',
    currency: 'GBX',
    quantity: '100',
    metrics: {
      price: '2000',
      priceEur: '25',
      fxRatePerEur: '0.8',
      fxRateDate: '2026-09-30',
      perf: perf('2', '-2', '2', '40', '50', '60'),
    },
  },
  {
    name: 'foxtrot',
    symbol: 'FFF',
    sector: 'Technologie',
    mic: 'XNAS',
    currency: 'USD',
    quantity: '0',
    metrics: { price: null },
  },
  { name: 'Golf', symbol: 'GGG', mic: 'XPAR', quantity: '3', metrics: false },
  {
    name: 'hotel',
    symbol: 'HHH',
    sector: 'Technologie',
    mic: 'XPAR',
    quantity: '7.5',
    reason: 'Seule place',
    metrics: {
      price: '80',
      asOfDate: '2026-09-01',
      perf: perf('3', '6', '9', '10.5', '12', '15'),
      computedAt: new Date('2026-09-30T11:00:00Z'),
    },
  },
];

const SECTORS = [
  'Energie',
  'Finance',
  'Technologie',
  'Santé',
  'Industrie',
  'Consommation',
  'Immobilier',
  'Services publics',
  'Matériaux',
  'Télécoms',
];
const CURRENCIES = [
  ['XPAR', 'EUR'],
  ['XNAS', 'USD'],
  ['XLON', 'GBX'],
] as const;

/** Deterministic pseudo-random generator (LCG): same data on every run. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * N generated entries for scale tests: about 7 % ETFs, 5 % watchlist, 10 % without a price,
 * 15 % without some performance, spread over three exchanges and ten sectors. `tag` keeps
 * symbols and ISINs unique across several generated spaces.
 */
export function generateEntries(n: number, tag: number): EntrySpec[] {
  const rnd = lcg(1000 + tag);
  const pct = () => (rnd() * 120 - 40).toFixed(2);
  return Array.from({ length: n }, (_, i) => {
    const [mic, currency] = CURRENCIES[Math.floor(rnd() * CURRENCIES.length)]!;
    const priced = rnd() > 0.1;
    const price = (rnd() * 500 + 1).toFixed(2);
    const p = (): string | null => (rnd() > 0.15 ? pct() : null);
    return {
      name: `Societe ${tag}-${i} ${SECTORS[i % SECTORS.length]}`,
      symbol: `T${tag}X${i}`,
      isin: fakeIsin(tag * 100_000 + i),
      sector: SECTORS[Math.floor(rnd() * SECTORS.length)]!,
      type: rnd() < 0.07 ? ('etf' as const) : ('stock' as const),
      mic,
      currency,
      quantity: rnd() < 0.05 ? null : (rnd() * 1000).toFixed(2),
      reason: i % 3 === 0 ? 'Place principale' : null,
      metrics: priced
        ? {
            price,
            priceEur: currency === 'EUR' ? price : (Number(price) * 0.8).toFixed(2),
            perf: { '1w': p(), '1m': p(), '6m': p(), '1y': p(), '5y': p(), max: p() },
          }
        : { price: null },
    } satisfies EntrySpec;
  });
}
