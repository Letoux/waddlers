import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeBars, normalizeQuote } from './bars';
import { EcbFxProvider, parseEcbXml } from './ecb-fx';
import { FakeMarketDataProvider } from './fake-provider';
import { FakeFxProvider } from './fx-fake';
import { toPlainDate, toPositiveDecimalString } from './normalize';
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
    expect(toPositiveDecimalString('123.456789012345678')).toBe('123.456789012345678');
    expect(toPositiveDecimalString(0.1)).toBe('0.1');
    expect(toPositiveDecimalString('1e-7')).not.toBeNull();
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
  ])('drops a row with %s (counted, never repaired to 0)', (_name, over) => {
    const r = normalizeBars([row(over), row({ date: '2026-09-11' })], range);
    expect('bars' in r && r.bars.map((b) => b.date)).toEqual(['2026-09-11']);
    expect('rejectedRows' in r && r.rejectedRows).toBe(1);
  });

  it('a bad adjusted_close only nulls that field, the close survives', () => {
    const r = normalizeBars([row({ adjusted_close: 0 })], range);
    expect('bars' in r && r.bars[0]).toEqual({ date: '2026-09-10', close: '10.5', adjClose: null });
  });

  it('drops duplicated dates after the first and sorts ascending', () => {
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
      ['2026-09-12', '10.5'],
    ]);
    expect('rejectedRows' in r && r.rejectedRows).toBe(1);
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
      '2026-09-28|USD|1.1378',
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
