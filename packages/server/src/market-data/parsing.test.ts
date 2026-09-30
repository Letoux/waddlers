import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeBars, normalizeQuote } from './bars';
import { EcbFxProvider, parseEcbXml } from './ecb-fx';
import { FakeMarketDataProvider } from './fake-provider';
import { FakeFxProvider } from './fx-fake';
import { FX_LIMIT, toPlainDate, toPositiveDecimalString } from './normalize';
import type { ListingRef } from './types';

const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dirname, '__fixtures__', name), 'utf8');

const range = { from: '2026-09-01', to: '2026-09-30' };

describe('toPositiveDecimalString', () => {
  it.each([
    0,
    -1,
    Number.NaN,
    Infinity,
    '',
    '  ',
    'abc',
    'NaN',
    '0',
    '0.0',
    '-3.2',
    null,
    undefined,
    {},
    [],
  ])('rejects %j', (value) => {
    expect(toPositiveDecimalString(value)).toBeNull();
  });

  it('keeps decimal precision as a string and never goes through a float', () => {
    expect(toPositiveDecimalString('1234567890123456.12345678')).toBe('1234567890123456.12345678');
    expect(toPositiveDecimalString(0.1)).toBe('0.1');
    expect(toPositiveDecimalString('1e-7')).toBe('0.0000001');
  });

  it.each([
    ['1e-9 (rounds to 0 at scale 8)', '1e-9'],
    ['5e-9 (half-even would give 0)', '5e-9'],
    ['0.123456789 (9 decimals)', '0.123456789'],
    ['1e17 (17 integer digits)', '1e17'],
    ['16+1 integer digits', '12345678901234567'],
    ['exponent expanding far past the bounds', '1e999999999'],
    ['tiny exponent', '1e-999999999'],
    ['absurdly long literal', `1${'0'.repeat(200)}`],
  ])('price scale: rejects %s', (_name, value) => {
    expect(toPositiveDecimalString(value)).toBeNull();
    expect(toPositiveDecimalString(Number(value))).toBeNull();
  });

  it('price scale: accepts the extremes that fit numeric(24,8)', () => {
    expect(toPositiveDecimalString('9999999999999999.99999999')).toBe('9999999999999999.99999999');
    expect(toPositiveDecimalString('1e-8')).toBe('0.00000001');
    expect(toPositiveDecimalString('1e15')).toBe('1000000000000000');
  });

  it('FX scale numeric(20,10): 10 integer digits and 10 decimals', () => {
    expect(toPositiveDecimalString('1e11', FX_LIMIT)).toBeNull();
    expect(toPositiveDecimalString('6e-11', FX_LIMIT)).toBeNull();
    expect(toPositiveDecimalString('1e-10', FX_LIMIT)).toBe('0.0000000001');
    expect(toPositiveDecimalString('9999999999.9999999999', FX_LIMIT)).toBe(
      '9999999999.9999999999',
    );
    expect(toPositiveDecimalString('1.0887', FX_LIMIT)).toBe('1.0887');
  });

  it('rejects impossible dates', () => {
    expect(toPlainDate('2026-02-30')).toBeNull();
    expect(toPlainDate('2026-09-30')).toBe('2026-09-30');
    expect(toPlainDate(20260930)).toBeNull();
  });
});

describe('normalizeBars (field by field)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    date: '2026-09-10',
    close: '10.5',
    adjusted_close: '10.1',
    ...over,
  });

  it('accepts a valid row and keeps adjusted_close as informational only', () => {
    const r = normalizeBars([row()], range);
    expect(r).toEqual({
      bars: [{ date: '2026-09-10', close: '10.5', adjClose: '10.1' }],
      rejectedRows: 0,
    });
  });

  it.each([
    ['zero close', { close: 0 }],
    ['negative close', { close: -2 }],
    ['NaN close', { close: Number.NaN }],
    ['missing close', { close: undefined }],
    ['null close', { close: null }],
    ['text close', { close: 'N/A' }],
    ['missing date', { date: undefined }],
    ['impossible date', { date: '2026-02-30' }],
    ['before range', { date: '2026-08-31' }],
    ['after range', { date: '2026-10-01' }],
    ['a price that would round at the column scale', { close: '1.234567891' }],
    ['a price overflowing the column', { close: '1e17' }],
    ['a price rounding to 0', { close: '1e-9' }],
  ])('drops a row with %s (counted, never repaired to 0)', (_name, over) => {
    const r = normalizeBars([row(over), row({ date: '2026-09-11' })], range);
    expect('bars' in r && r.bars.map((b) => b.date)).toEqual(['2026-09-11']);
    expect('rejectedRows' in r && r.rejectedRows).toBe(1);
  });

  it('a bad adjusted_close only nulls that field, the close survives', () => {
    const r = normalizeBars([row({ adjusted_close: 0 })], range);
    expect('bars' in r && r.bars[0]).toEqual({ date: '2026-09-10', close: '10.5', adjClose: null });
  });

  it('duplicated dates: the LAST occurrence wins (DOMAIN.md), sorted ascending', () => {
    const r = normalizeBars(
      [
        row({ date: '2026-09-12' }),
        row({ date: '2026-09-10' }),
        row({ date: '2026-09-12', close: '99' }),
      ],
      range,
    );
    expect('bars' in r && r.bars.map((b) => [b.date, b.close])).toEqual([
      ['2026-09-10', '10.5'],
      ['2026-09-12', '99'],
    ]);
    expect('rejectedRows' in r && r.rejectedRows).toBe(1);
  });

  it('a later unusable duplicate drops the date entirely (no stale value survives)', () => {
    const r = normalizeBars(
      [row({ date: '2026-09-12' }), row({ date: '2026-09-12', close: 0 })],
      range,
    );
    expect(r).toEqual({ bars: [], rejectedRows: 2 });
  });

  it('flags a non-array payload as bad_payload', () => {
    expect(normalizeBars({ nope: true }, range)).toEqual({ error: 'bad_payload' });
    expect(normalizeBars(null, range)).toEqual({ error: 'bad_payload' });
  });
});

describe('normalizeQuote', () => {
  const l = { id: 'l1', currency: 'GBX' };
  const asOf = '2026-09-30T10:00:00Z';
  it('accepts a matching-currency positive quote', () => {
    expect(normalizeQuote(l, { price: '2450.5', currency: 'GBX', asOf })).toMatchObject({
      listingId: 'l1',
      price: '2450.5',
      currency: 'GBX',
    });
  });
  it.each([
    ['zero', { price: 0 }],
    ['NaN', { price: Number.NaN }],
    ['negative', { price: -1 }],
    ['missing', { price: undefined }],
    ['bad timestamp', { asOf: 'yesterday' }],
    ['missing timestamp', { asOf: undefined }],
    ['other currency', { currency: 'GBP' }],
  ])('rejects %s', (_n, over) => {
    expect(normalizeQuote(l, { price: '1', currency: 'GBX', asOf, ...over })).toBeNull();
  });
});

describe('FakeMarketDataProvider in malformed mode', () => {
  const listing: ListingRef = {
    id: '00000000-0000-4000-8000-000000000001',
    symbol: 'AI',
    mic: 'XPAR',
    currency: 'EUR',
    timezone: 'Europe/Paris',
    providerSymbol: null,
  };
  const clock = () => new Date('2026-09-30T12:00:00Z');

  it('rejects malformed history rows and never emits 0, negative or NaN closes', async () => {
    const p = new FakeMarketDataProvider({ clock, failure: { mode: 'malformed' } });
    const res = await p.getDailyHistory(listing, '2026-06-01', '2026-09-30');
    if (!res.ok) throw new Error('expected ok');
    expect(res.data.rejectedRows).toBeGreaterThan(0);
    expect(res.data.bars.length).toBeGreaterThan(20);
    for (const b of res.data.bars) expect(Number(b.close)).toBeGreaterThan(0);
    expect(res.asOf).toBeInstanceOf(Date);
    expect(res.source).toBe('fake');
  });

  it('rejects malformed quotes per listing and reports them', async () => {
    const p = new FakeMarketDataProvider({ clock, failure: { mode: 'malformed' } });
    const other = { ...listing, id: '00000000-0000-4000-8000-000000000002' };
    const res = await p.getQuotes([listing, other]);
    if (!res.ok) throw new Error('expected ok');
    expect(res.data.rejected.map((r) => r.listingId)).toEqual([listing.id]);
    expect(res.data.quotes.map((q) => q.listingId)).toEqual([other.id]);
  });

  it('is deterministic for the same listing and clock', async () => {
    const a = await new FakeMarketDataProvider({ clock }).getDailyHistory(
      listing,
      '2026-09-01',
      '2026-09-30',
    );
    const b = await new FakeMarketDataProvider({ clock }).getDailyHistory(
      listing,
      '2026-09-01',
      '2026-09-30',
    );
    expect(a).toEqual(b);
  });
});

describe('ECB parser', () => {
  it('parses the recorded 90-day document: EUR-based, per (date, currency)', () => {
    const batch = parseEcbXml(fixture('ecb-hist-90d.xml'), {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(batch.rejectedRows).toBe(0);
    expect(batch.rates.map((r) => r.date)).toContain('2026-09-29');
    const gbp = batch.rates.find((r) => r.currency === 'GBP' && r.date === '2026-09-29');
    // ECB quotes "1 EUR = 0.85718 GBP": the stored value is CCY per EUR, unchanged.
    expect(gbp?.ratePerEur).toBe('0.85718');
    expect(batch.rates.some((r) => r.currency === 'EUR')).toBe(false);
  });

  it('respects the requested range', () => {
    const batch = parseEcbXml(fixture('ecb-hist-90d.xml'), {
      from: '2026-09-29',
      to: '2026-09-29',
    });
    expect(new Set(batch.rates.map((r) => r.date))).toEqual(new Set(['2026-09-29']));
  });

  it('drops every bad row of the malformed fixture and keeps the good ones', () => {
    const batch = parseEcbXml(fixture('ecb-malformed.xml'), {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    const keys = batch.rates.map((r) => `${r.date}|${r.currency}|${r.ratePerEur}`);
    expect(keys).toEqual([
      '2026-09-28|USD|9.9999', // duplicate: the last occurrence wins
      '2026-09-29|CAD|1.6101',
      '2026-09-29|USD|1.1355',
    ]);
    // 0, negative, N/A, NaN, empty, lowercase code, EUR, bad date (2026-13-45), duplicate USD.
    expect(batch.rejectedRows).toBe(9);
  });

  it('EcbFxProvider maps HTTP failures to codes and a good body to a dated result', async () => {
    const xml = fixture('ecb-hist-90d.xml');
    const mk = (status: number, body = xml) =>
      new EcbFxProvider({
        clock: () => new Date('2026-09-30T12:00:00Z'),
        fetch: vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch,
      });
    const okRes = await mk(200).getDailyRates('2026-09-01', '2026-09-30');
    expect(okRes).toMatchObject({ ok: true, source: 'ecb' });
    if (okRes.ok) expect(okRes.asOf.toISOString()).toBe('2026-09-29T00:00:00.000Z');
    expect(await mk(429, '').getDailyRates('2026-09-01', '2026-09-30')).toMatchObject({
      code: 'rate_limited',
    });
    expect(await mk(503, '').getDailyRates('2026-09-01', '2026-09-30')).toMatchObject({
      code: 'upstream_error',
    });
    expect(await mk(200, '<html/>').getDailyRates('2026-09-01', '2026-09-30')).toMatchObject({
      code: 'bad_payload',
    });
  });

  it('picks the short file for recent ranges and the full history otherwise', async () => {
    const fetchSpy = vi.fn(async () => new Response(fixture('ecb-hist-90d.xml')));
    const p = new EcbFxProvider({
      clock: () => new Date('2026-09-30T12:00:00Z'),
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await p.getDailyRates('2026-09-01', '2026-09-30');
    await p.getDailyRates('2020-01-01', '2026-09-30');
    const urls = fetchSpy.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls[0]).toMatch(/eurofxref-hist-90d\.xml$/);
    expect(urls[1]).toMatch(/eurofxref-hist\.xml$/);
  });
});

describe('ECB parser hardening', () => {
  it('many unterminated openers stay fast (no quadratic backtracking)', () => {
    const opener = '<Cube time="2026-09-29">';
    const inputs = [
      opener.repeat(32_000),
      `${opener.repeat(32_000)}</Cube>`,
      '<Cube time="2026-09-29"'.repeat(32_000),
      `<Cube${' '.repeat(50_000)}time="x`.repeat(4),
    ];
    for (const xml of inputs) {
      const started = performance.now();
      parseEcbXml(xml, range);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });

  it('an FX rate that overflows or would round at numeric(20,10) drops that row only', () => {
    const xml = `<Cube><Cube time="2026-09-29">
      <Cube currency="USD" rate="1.1355"/><Cube currency="JPY" rate="1e11"/>
      <Cube currency="CHF" rate="6e-11"/><Cube currency="GBP" rate="0.12345678901"/></Cube></Cube>`;
    const batch = parseEcbXml(xml, range);
    expect(batch.rates.map((r) => r.currency)).toEqual(['USD']);
    expect(batch.rejectedRows).toBe(3);
  });

  it('duplicates: the last occurrence wins, an unusable last one drops the pair', () => {
    const day = (rates: string) => `<Cube time="2026-09-29">${rates}</Cube>`;
    const usd = (rate: string) => `<Cube currency="USD" rate="${rate}"/>`;
    const win = parseEcbXml(`<Cube>${day(usd('1.1') + usd('1.2'))}</Cube>`, range);
    expect(win.rates).toEqual([{ date: '2026-09-29', currency: 'USD', ratePerEur: '1.2' }]);
    expect(win.rejectedRows).toBe(1);
    const drop = parseEcbXml(`<Cube>${day(usd('1.1') + usd('N/A'))}</Cube>`, range);
    expect(drop).toEqual({ rates: [], rejectedRows: 2 });
  });

  const provider = (response: () => Response) =>
    new EcbFxProvider({
      clock: () => new Date('2026-09-30T12:00:00Z'),
      fetch: vi.fn(async () => response()) as unknown as typeof fetch,
    });

  it('rejects an oversize CHUNKED body without content-length and stops reading', async () => {
    let chunks = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        if (chunks > 64) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await provider(() => new Response(body)).getDailyRates('2026-09-01', '2026-09-30');
    expect(res).toMatchObject({ ok: false, code: 'bad_payload', message: 'response too large' });
    expect(chunks).toBeLessThan(15); // cancelled around the 8 MB cap, not read to the end
  });

  it('rejects a declared oversize body from content-length alone', async () => {
    const res = await provider(
      () => new Response('<Cube/>', { headers: { 'content-length': String(9 * 1024 * 1024) } }),
    ).getDailyRates('2026-09-01', '2026-09-30');
    expect(res).toMatchObject({ ok: false, code: 'bad_payload' });
  });
});

describe('FX direction (EUR-based)', () => {
  it('the fake FX provider reports units of currency per 1 EUR, never EUR itself', async () => {
    const fx = new FakeFxProvider({ clock: () => new Date('2026-09-30T12:00:00Z') });
    const res = await fx.getDailyRates('2026-09-28', '2026-09-30');
    if (!res.ok) throw new Error('expected ok');
    const usd = res.data.rates.find((r) => r.currency === 'USD')!;
    const jpy = res.data.rates.find((r) => r.currency === 'JPY')!;
    expect(Number(usd.ratePerEur)).toBeGreaterThan(0.5);
    expect(Number(usd.ratePerEur)).toBeLessThan(2);
    expect(Number(jpy.ratePerEur)).toBeGreaterThan(50); // 1 EUR buys ~165 JPY
    expect(res.data.rates.some((r) => r.currency === 'EUR')).toBe(false);
  });

  it('malformed mode drops bad rates and counts them', async () => {
    const fx = new FakeFxProvider({
      clock: () => new Date('2026-09-30T12:00:00Z'),
      failure: { mode: 'malformed' },
    });
    const res = await fx.getDailyRates('2026-09-01', '2026-09-30');
    if (!res.ok) throw new Error('expected ok');
    expect(res.data.rejectedRows).toBeGreaterThan(0);
    for (const r of res.data.rates) expect(Number(r.ratePerEur)).toBeGreaterThan(0);
  });
});
