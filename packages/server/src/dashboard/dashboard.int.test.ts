import type {
  DashboardHistoryOutput,
  DashboardMoversOutput,
  DashboardSummaryOutput,
} from '@waddlers/contracts';
import { sql } from 'drizzle-orm';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from '../admin';
import { getDb } from '../db/client';
import { instruments, listings } from '../db/schema';
import { recomputeListingMetrics } from '../market-data/metrics';
import { readBars, recordSuccess, upsertBars, upsertFxRates } from '../market-data/repository';
import { requireSpaceAccess } from '../spaces/access';
import { createApp, PASSWORD, releaseTestEnv, useTestEnv } from '../../test/auth-harness';
import { resetMarketTables, testConfig } from '../../test/market-fixtures';
import { createPositionRow, createSpaceRow, ensureReferenceData } from '../../test/space-fixtures';
import { readHeldCloses } from './repository';

const NOW = new Date('2026-09-30T12:00:00Z');
const { rpc, loginAs } = createApp({ now: () => NOW });

let ref: Awaited<ReturnType<typeof ensureReferenceData>>;
let userId: string;
let cookie: string;

beforeAll(useTestEnv);
afterAll(releaseTestEnv);

beforeEach(async () => {
  await resetMarketTables();
  userId = (await createUser(getDb(), { username: 'alice', password: PASSWORD })).id;
  cookie = await loginAs('alice');
  ref = await ensureReferenceData();
});

type Bars = [date: string, close: string][];
const DB_CURRENCY: Record<string, string> = { ai: 'EUR', shel: 'GBX', cw8: 'EUR', msft: 'USD' };

async function seedBars(listingId: string, currency: string, bars: Bars, completeFrom?: string) {
  await upsertBars(
    getDb(),
    { id: listingId, currency },
    bars.map(([date, close]) => ({ date, close, adjClose: null })),
    { source: 'fake', fetchedAt: NOW },
  );
  await recordSuccess(getDb(), listingId, 'history', NOW, {
    historyCompleteFrom: completeFrom ?? bars[0]![0],
  });
}

const seedFx = (rates: { currency: string; ratePerEur: string }[]) =>
  upsertFxRates(
    getDb(),
    ['2026-08-28', '2026-09-15', '2026-09-30'].flatMap((date) =>
      rates.map((r) => ({ date, ...r })),
    ),
    { source: 'fake', fetchedAt: NOW },
  );

const recompute = () => recomputeListingMetrics(getDb(), { now: NOW, config: testConfig });

/**
 * Hand-computed fixture (rates 1 EUR = 1.25 USD = 0.8 GBP):
 *   08-28: AI 10x90=900, MSFT 5x200/1.25=800, SHEL 200x20/0.8=5000 -> 6700
 *   09-15: 950 + 900 + 5625 -> 7475      09-30: 1000 + 1000 + 6250 -> 8250
 * CW8 is a watchlist entry (null quantity): 100 -> 80 (-20 %).
 */
async function standardSpace(extra: { name?: string } = {}) {
  const spaceId = await createSpaceRow(extra.name ?? 'PEA', [{ userId, role: 'viewer' }]);
  const data: Record<string, Bars> = {
    ai: [
      ['2026-08-28', '90'],
      ['2026-09-15', '95'],
      ['2026-09-30', '100'],
    ],
    msft: [
      ['2026-08-28', '200'],
      ['2026-09-15', '225'],
      ['2026-09-30', '250'],
    ],
    shel: [
      ['2026-08-28', '2000'],
      ['2026-09-15', '2250'],
      ['2026-09-30', '2500'],
    ],
    cw8: [
      ['2026-08-28', '100'],
      ['2026-09-30', '80'],
    ],
  };
  for (const key of ['ai', 'msft', 'shel', 'cw8'] as const) {
    await seedBars(ref[key].listingId, DB_CURRENCY[key]!, data[key]!);
  }
  await seedFx([
    { currency: 'USD', ratePerEur: '1.25' },
    { currency: 'GBP', ratePerEur: '0.8' },
  ]);
  const qty = { ai: '10', msft: '5', shel: '200', cw8: null } as const;
  const positions: Record<string, string> = {};
  for (const key of ['ai', 'msft', 'shel', 'cw8'] as const) {
    positions[key] = await createPositionRow(spaceId, ref[key], qty[key]);
  }
  await recompute();
  return { spaceId, positions };
}

const call = async <T>(proc: string, spaceId: string, period: string) => {
  const res = await rpc(`dashboard.${proc}`, { spaceId, period }, { cookie });
  return { status: res.status, body: res.json as unknown as T, raw: res.json };
};
const summary = async (spaceId: string, period = '1m') =>
  (await call<DashboardSummaryOutput>('summary', spaceId, period)).body;
const history = async (spaceId: string, period = '1m', fxMode?: string) => {
  const res = await rpc(
    'dashboard.history',
    { spaceId, period, ...(fxMode ? { fxMode } : {}) },
    { cookie },
  );
  return res.json as unknown as DashboardHistoryOutput;
};
const movers = async (spaceId: string, period = '1m') =>
  (await call<DashboardMoversOutput>('movers', spaceId, period)).body;

describe('dashboard.summary', () => {
  it('sums EUR, USD (FX) and GBX exactly; watchlist excluded; change equals the series endpoints', async () => {
    const { spaceId } = await standardSpace();
    const s = await summary(spaceId, '1m');
    expect(s.total).toEqual({ amount: '8250', currency: 'EUR' });
    expect(s.isComplete).toBe(true);
    expect(s.missing).toEqual([]);
    expect([s.heldCount, s.valuedCount, s.watchlistCount]).toEqual([3, 3, 1]);
    expect(s.change).toEqual({
      fromDate: '2026-08-30',
      baseDate: '2026-08-28',
      toDate: '2026-09-30',
      startValue: { amount: '6700', currency: 'EUR' },
      endValue: { amount: '8250', currency: 'EUR' },
      change: { amount: '1550', currency: 'EUR' },
      changePct: '23.13432836',
    });
    const h = await history(spaceId, '1m');
    expect(s.change).toEqual(h.headline);
    expect(s.freshness).toMatchObject({ asOf: '2026-09-30', isStale: false, stalePositions: [] });
    expect(s.fxRates.map((r) => r.currency)).toEqual(['GBP', 'USD']);
  });

  it('a missing FX rate gives a partial total with missing[], never 0', async () => {
    const { spaceId, positions } = await standardSpace();
    await getDb().execute(sql`delete from fx_daily where currency = 'USD'`);
    const s = await summary(spaceId);
    expect(s.total.amount).toBe('7250');
    expect(s.isComplete).toBe(false);
    expect(s.missing).toEqual([
      { positionId: positions.msft, name: 'Microsoft', reason: 'fx_missing' },
    ]);
    expect(s.valuedCount).toBe(2);
    const h = await history(spaceId);
    // D20: a day missing one position is null, never a partial sum: the chart is empty and says why.
    expect(h.points).toEqual([]);
    expect(h.headline).toBeNull();
    expect(h.leadingMissing.map((p) => p.name)).toContain('Microsoft');
    expect(s.change).toBeNull();
  });

  it('a position without any price is reported missing (price_missing)', async () => {
    const { spaceId } = await standardSpace();
    const [instrument] = await getDb()
      .insert(instruments)
      .values({ name: 'Ghost SA', isin: 'FR0000000001', type: 'stock' })
      .returning();
    const [listing] = await getDb()
      .insert(listings)
      .values({ instrumentId: instrument!.id, exchangeMic: 'XPAR', symbol: 'GHO', currency: 'EUR' })
      .returning();
    const ghost = await createPositionRow(
      spaceId,
      { instrumentId: instrument!.id, listingId: listing!.id },
      '4',
    );
    const s = await summary(spaceId);
    expect(s.total.amount).toBe('8250');
    expect(s.missing).toEqual([{ positionId: ghost, name: 'Ghost SA', reason: 'price_missing' }]);
    expect(s.isComplete).toBe(false);
  });

  it('flags a stale input in freshness (asOf = the oldest input date)', async () => {
    const spaceId = await createSpaceRow('Old', [{ userId, role: 'viewer' }]);
    await seedBars(ref.ai.listingId, 'EUR', [
      ['2026-09-10', '50'],
      ['2026-09-20', '52'],
    ]);
    await createPositionRow(spaceId, ref.ai, '2');
    await recompute();
    const s = await summary(spaceId, '1w');
    expect(s.total.amount).toBe('104');
    expect(s.freshness.asOf).toBe('2026-09-20');
    expect(s.freshness.isStale).toBe(true);
    expect(s.freshness.stalePositions).toEqual([
      expect.objectContaining({ name: 'Air Liquide', asOf: '2026-09-20' }),
    ]);
  });

  it('an empty space: null total, no change, no error', async () => {
    const spaceId = await createSpaceRow('Empty', [{ userId, role: 'viewer' }]);
    const s = await summary(spaceId, 'max');
    expect(s.total).toEqual({ amount: null, currency: 'EUR' });
    expect(s.change).toBeNull();
    expect([s.heldCount, s.valuedCount]).toEqual([0, 0]);
    expect((await history(spaceId, 'max')).points).toEqual([]);
    expect(await movers(spaceId, 'max')).toEqual({ period: 'max', gainers: [], losers: [] });
  });
});

describe('dashboard.history', () => {
  it('returns the exact series, the D6 label and endpoints equal to the headline', async () => {
    const { spaceId } = await standardSpace();
    const h = await history(spaceId, '1m');
    expect(h.basis).toBe('current_quantities_past_prices');
    expect(h.label).toBe('valeur des positions actuelles');
    expect(h.currency).toBe('EUR');
    expect(h.asOf).toBe('2026-09-30');
    expect(
      h.points.map((p) => ({
        date: p.date,
        value: p.value,
        evolutionPct: p.evolutionPct,
        dataDate: p.dataDate,
      })), // tooltip rates: see the D22 tests
    ).toEqual([
      { date: '2026-08-30', value: '6700', evolutionPct: '0', dataDate: '2026-08-28' },
      { date: '2026-09-15', value: '7475', evolutionPct: '11.56716418', dataDate: '2026-09-15' },
      { date: '2026-09-30', value: '8250', evolutionPct: '23.13432836', dataDate: '2026-09-30' },
    ]);
    expect(h.totalPoints).toBe(3);
    expect(h.headline?.startValue.amount).toBe(h.points[0]?.value);
    expect(h.headline?.endValue.amount).toBe(h.points[h.points.length - 1]?.value);
    expect(h.leadingMissing).toEqual([]);
    expect(h.invalidPositions).toEqual([]);
  });

  it.each([
    // period, first point, base date, start, end
    ['1w', '2026-09-23', '2026-09-15', '7475', '8250'],
    ['1m', '2026-08-30', '2026-08-28', '6700', '8250'],
    ['max', '2026-08-28', '2026-08-28', '6700', '8250'],
  ])('period %s starts at %s (base %s)', async (period, from, base, start, end) => {
    const { spaceId } = await standardSpace();
    const h = await history(spaceId, period);
    expect(h.headline).toMatchObject({
      fromDate: from,
      baseDate: base,
      toDate: '2026-09-30',
      startValue: { amount: start },
      endValue: { amount: end },
    });
  });

  it.each(['6m', '1y', '5y'])(
    'period %s: no data before the listings exist, so the series starts at the first complete day (D20)',
    async (period) => {
      const { spaceId } = await standardSpace();
      const h = await history(spaceId, period);
      expect(h.headline?.fromDate).toBe('2026-08-28');
      expect(h.headline?.baseDate).toBe('2026-08-28');
      expect(h.leadingMissing.map((p) => p.name).sort()).toEqual([
        'Air Liquide',
        'Microsoft',
        'Shell',
      ]);
    },
  );

  it('a recently listed position trims the start and is named in leadingMissing (D20)', async () => {
    const { spaceId } = await standardSpace();
    const [instrument] = await getDb()
      .insert(instruments)
      .values({ name: 'Newco', isin: 'FR0000000002', type: 'stock' })
      .returning();
    const [listing] = await getDb()
      .insert(listings)
      .values({ instrumentId: instrument!.id, exchangeMic: 'XPAR', symbol: 'NEW', currency: 'EUR' })
      .returning();
    const ref2 = { instrumentId: instrument!.id, listingId: listing!.id };
    await seedBars(listing!.id, 'EUR', [
      ['2026-09-29', '10'],
      ['2026-09-30', '12'],
    ]);
    // Closes and rates on 09-28 keep every older position within the 10-day forward-fill tolerance.
    for (const [key, close] of [
      ['ai', '96'],
      ['msft', '230'],
      ['shel', '2300'],
    ] as const) {
      await upsertBars(
        getDb(),
        { id: ref[key].listingId, currency: DB_CURRENCY[key]! },
        [{ date: '2026-09-28', close, adjClose: null }],
        { source: 'fake', fetchedAt: NOW },
      );
    }
    await upsertFxRates(
      getDb(),
      [
        { date: '2026-09-28', currency: 'USD', ratePerEur: '1.25' },
        { date: '2026-09-28', currency: 'GBP', ratePerEur: '0.8' },
      ],
      { source: 'fake', fetchedAt: NOW },
    );
    const newPos = await createPositionRow(spaceId, ref2, '2');
    await recompute();
    const h = await history(spaceId, '1m');
    expect(h.leadingMissing).toEqual([{ positionId: newPos, name: 'Newco' }]);
    expect(h.points.map((p) => [p.date, p.value])).toEqual([
      // 09-28 is null (Newco does not exist yet) and trimmed; 09-29: 960 + 920 + 5750 + 2x10.
      ['2026-09-29', '7650'],
      ['2026-09-30', '8274'],
    ]);
    expect(h.headline?.fromDate).toBe('2026-09-29');
    const s = await summary(spaceId, '1m');
    expect(s.leadingMissing).toEqual([{ positionId: newPos, name: 'Newco' }]);
    expect(s.total.amount).toBe('8274');
    expect(s.change?.change.amount).toBe('624');
  });
});

describe('dashboard.history FX modes (D22)', () => {
  it('defaults to historical: same-day rates per point (tooltip), no current-rate label', async () => {
    const { spaceId } = await standardSpace();
    const h = await history(spaceId, '1m');
    expect(h.fxMode).toBe('historical');
    expect(h.fxLabel).toBeNull();
    expect(h.currentFxRates).toBeNull();
    expect(h.points.map((p) => p.fxRates)).toEqual([
      [
        // Point 08-30 forward-fills the 08-28 rates; GBX is reported with its GBP rate.
        { currency: 'GBP', ratePerEur: '0.8', eurPerUnit: '1.25', rateDate: '2026-08-28' },
        { currency: 'USD', ratePerEur: '1.25', eurPerUnit: '0.8', rateDate: '2026-08-28' },
      ],
      [
        { currency: 'GBP', ratePerEur: '0.8', eurPerUnit: '1.25', rateDate: '2026-09-15' },
        { currency: 'USD', ratePerEur: '1.25', eurPerUnit: '0.8', rateDate: '2026-09-15' },
      ],
      [
        { currency: 'GBP', ratePerEur: '0.8', eurPerUnit: '1.25', rateDate: '2026-09-30' },
        { currency: 'USD', ratePerEur: '1.25', eurPerUnit: '0.8', rateDate: '2026-09-30' },
      ],
    ]);
    // An explicit historical mode is the same request as the default.
    expect(await history(spaceId, '1m', 'historical')).toEqual(h);
  });

  it('historical vs current on a USD position whose rate moved; headline follows the series in both', async () => {
    const { spaceId } = await standardSpace();
    // USD gets weaker for the euro investor: 1 EUR = 1.5 USD on the last day (was 1.25).
    await getDb().execute(
      sql`update fx_daily set rate_per_eur = 1.5 where currency = 'USD' and rate_date = '2026-09-30'`,
    );
    const hist = await history(spaceId, '1m', 'historical');
    // MSFT: 5 x 250 / 1.5 = 833.333... at the end, still 5 x 200 / 1.25 = 800 at the start.
    expect(hist.headline).toMatchObject({
      startValue: { amount: '6700' },
      endValue: { amount: '8083.33333333' },
      change: { amount: '1383.33333333' },
      changePct: '20.64676617',
    });
    const cur = await history(spaceId, '1m', 'current');
    expect(cur.fxMode).toBe('current');
    expect(cur.fxLabel).toBe('au taux de change actuel');
    expect(cur.currentFxRates).toEqual([
      { currency: 'GBP', ratePerEur: '0.8', eurPerUnit: '1.25', rateDate: '2026-09-30' },
      { currency: 'USD', ratePerEur: '1.5', eurPerUnit: '0.66666667', rateDate: '2026-09-30' },
    ]);
    // MSFT at 1.5 on every day: start 900 + 666.67 + 5000, end 1000 + 833.33 + 6250.
    expect(cur.headline).toMatchObject({
      startValue: { amount: '6566.66666667' },
      endValue: { amount: '8083.33333333' },
      change: { amount: '1516.66666667' },
      changePct: '23.0964467',
    });
    for (const h of [hist, cur]) {
      expect(h.headline?.startValue.amount).toBe(h.points[0]?.value);
      expect(h.headline?.endValue.amount).toBe(h.points[h.points.length - 1]?.value);
    }
    // Every current-mode point applies the SAME USD rate and reports its real date.
    for (const p of cur.points) {
      expect(p.fxRates.find((f) => f.currency === 'USD')).toMatchObject({
        ratePerEur: '1.5',
        rateDate: '2026-09-30',
      });
    }
    // The summary's current value is unaffected by the mode (latest rate).
    expect((await summary(spaceId, '1m')).total.amount).toBe('8083.33333333');
  });

  it('a missing historical rate is a null day in historical mode; current mode still has one', async () => {
    const { spaceId } = await standardSpace();
    await getDb().execute(
      sql`delete from fx_daily where currency = 'USD' and rate_date = '2026-08-28'`,
    );
    const hist = await history(spaceId, '1m', 'historical');
    expect(hist.headline?.fromDate).toBe('2026-09-15');
    expect(hist.leadingMissing.map((p) => p.name)).toEqual(['Microsoft']);
    const cur = await history(spaceId, '1m', 'current');
    expect(cur.headline?.fromDate).toBe('2026-08-30');
    expect(cur.leadingMissing).toEqual([]);
  });

  it('current mode with no current rate: empty series naming the position, never rate 1', async () => {
    const { spaceId } = await standardSpace();
    await getDb().execute(sql`delete from fx_daily where currency = 'USD'`);
    for (const mode of ['historical', 'current']) {
      const h = await history(spaceId, '1m', mode);
      expect(h.points, mode).toEqual([]);
      expect(h.headline, mode).toBeNull();
      expect(
        h.leadingMissing.map((p) => p.name),
        mode,
      ).toContain('Microsoft');
    }
    const cur = await history(spaceId, '1m', 'current');
    expect(cur.currentFxRates?.map((r) => r.currency)).toEqual(['GBP']);
  });

  it('rejects an unknown fxMode', async () => {
    const { spaceId } = await standardSpace();
    for (const bad of ['live', '', 'CURRENT']) {
      const res = await rpc(
        'dashboard.history',
        { spaceId, period: '1m', fxMode: bad },
        { cookie },
      );
      expect(res.status, bad).toBe(400);
      expect(res.json.code).toBe('BAD_REQUEST');
    }
  });

  it('summary exposes canonical rate strings (no trailing zeros from numeric(20,10))', async () => {
    const { spaceId } = await standardSpace();
    const s = await summary(spaceId);
    expect(s.fxRates).toEqual([
      { currency: 'GBP', ratePerEur: '0.8', date: '2026-09-30' },
      { currency: 'USD', ratePerEur: '1.25', date: '2026-09-30' },
    ]);
  });
});

describe('dashboard.movers', () => {
  it('ranks by period performance in local currency; ties by name; watchlist in, nulls out', async () => {
    const { spaceId, positions } = await standardSpace();
    const [instrument] = await getDb()
      .insert(instruments)
      .values({ name: 'Newco', isin: 'FR0000000003', type: 'stock' })
      .returning();
    const [listing] = await getDb()
      .insert(listings)
      .values({ instrumentId: instrument!.id, exchangeMic: 'XPAR', symbol: 'NEW', currency: 'EUR' })
      .returning();
    await seedBars(listing!.id, 'EUR', [
      ['2026-09-29', '10'],
      ['2026-09-30', '12'],
    ]);
    await createPositionRow(spaceId, { instrumentId: instrument!.id, listingId: listing!.id }, '1');
    await recompute();
    const m = await movers(spaceId, '1m');
    expect(m.gainers.map((r) => [r.name, r.performancePct])).toEqual([
      ['Microsoft', '25'],
      ['Shell', '25'],
      ['Air Liquide', '11.11111111'],
    ]);
    expect(m.gainers[0]).toMatchObject({
      positionId: positions.msft,
      symbol: 'MSFT',
      exchange: { mic: 'XNAS', name: 'Nasdaq' },
      baseDate: '2026-08-28',
      asOf: '2026-09-30',
      currency: 'USD',
    });
    expect(m.gainers[1]?.currency).toBe('GBX');
    // The watchlist entry (null quantity) is a mover; Newco (no 1m base) appears nowhere.
    expect(m.losers.map((r) => [r.name, r.performancePct])).toEqual([['World ETF', '-20']]);
    const names = [...m.gainers, ...m.losers].map((r) => r.name);
    expect(names).not.toContain('Newco');
  });

  it('uses the requested period (1w base is the 09-15 close)', async () => {
    const { spaceId } = await standardSpace();
    const m = await movers(spaceId, '1w');
    // AI 09-23 base carries the 09-15 close (95): 100/95 - 1.
    expect(m.gainers.find((r) => r.name === 'Air Liquide')?.performancePct).toBe('5.26315789');
  });
});

describe('validation and provider isolation', () => {
  it.each(['summary', 'history', 'movers'])(
    '%s rejects a period outside the six domain periods',
    async (proc) => {
      const { spaceId } = await standardSpace();
      for (const bad of ['2y', '', 'MAX', '1M']) {
        const res = await call(proc, spaceId, bad);
        expect(res.status, bad).toBe(400);
        expect(res.raw.code).toBe('BAD_REQUEST');
      }
      expect((await rpc(`dashboard.${proc}`, { spaceId }, { cookie })).status).toBe(400);
    },
  );

  it('never calls a provider or the network while serving the three procedures', async () => {
    const { spaceId } = await standardSpace();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      for (const period of ['1w', '1m', '6m', '1y', '5y', 'max']) {
        for (const proc of ['summary', 'history', 'movers']) {
          expect((await call(proc, spaceId, period)).status).toBe(200);
        }
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('the dashboard module has no import path to a provider or MarketDataService', () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = readFileSync(path.join(dir, file), 'utf8');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      expect(
        imports.filter((i) => /market-data|provider|eodhd|ecb|fetch/i.test(i)),
        file,
      ).toEqual([]);
    }
  });
});

describe('bounded, space-scoped reads', () => {
  it('reads only held listings of the space, inside the window, in the listing currency', async () => {
    const { spaceId } = await standardSpace();
    const authorized = await requireSpaceAccess({ db: getDb(), userId }, spaceId, 'viewer');
    const other = await createSpaceRow('Other', [{ userId, role: 'viewer' }]);
    await createPositionRow(other, ref.ai, '1');
    const rows = await readHeldCloses(getDb(), authorized, {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    // CW8 (watchlist) never appears; nothing before the window; 3 listings x 2 dates.
    expect(rows.map((r) => r.listingId)).not.toContain(ref.cw8.listingId);
    expect(rows.every((r) => r.date >= '2026-09-01')).toBe(true);
    expect(rows).toHaveLength(6);
    // A close stored in another currency than the listing's is ignored.
    await getDb().execute(
      sql`update price_daily set currency = 'USD' where listing_id = ${ref.ai.listingId}`,
    );
    const again = await readHeldCloses(getDb(), authorized, {
      from: null,
      to: '2026-09-30',
    });
    expect(again.map((r) => r.listingId)).not.toContain(ref.ai.listingId);
    expect((await readBars(getDb(), ref.ai.listingId)).length).toBe(3);
  });
});
