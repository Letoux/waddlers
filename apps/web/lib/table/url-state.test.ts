import { describe, expect, it } from 'vitest';
import {
  applyTableUrlPatch,
  nextSort,
  pageOffset,
  parsePageParam,
  parseSortParam,
  parseTableUrlState,
  searchForApi,
} from './url-state';

const params = (s: string) => new URLSearchParams(s);

describe('parseSortParam', () => {
  it('accepts a sortable column and a direction', () => {
    expect(parseSortParam('perf_period:desc')).toEqual({
      columnId: 'perf_period',
      direction: 'desc',
    });
    expect(parseSortParam('price_eur:asc')).toEqual({ columnId: 'price_eur', direction: 'asc' });
  });
  it.each([
    'price:asc', // not sortable (mixed currencies)
    'market_cap_eur:asc', // pending S8
    'name:up',
    'name',
    ':asc',
    "name';drop table:asc",
    '',
    null,
    undefined,
  ])('rejects %s', (raw) => {
    expect(parseSortParam(raw)).toBeNull();
  });
});

describe('parsePageParam', () => {
  it('is a 1-based positive integer', () => {
    expect(parsePageParam('3')).toBe(3);
    expect(parsePageParam('1')).toBe(1);
  });
  it.each(['0', '-2', '1.5', 'abc', '', '007', '123456', null, undefined])(
    'falls back for %s',
    (raw) => {
      expect(parsePageParam(raw)).toBe(1);
    },
  );
  it('maps a page to an offset of 50 rows', () => {
    expect(pageOffset(1)).toBe(0);
    expect(pageOffset(3)).toBe(100);
  });
});

describe('parseTableUrlState', () => {
  it('reads q, tri and page together, ignoring invalid parts', () => {
    expect(parseTableUrlState(params('q=lvmh&tri=symbol:asc&page=2&periode=1y'))).toEqual({
      q: 'lvmh',
      sort: { columnId: 'symbol', direction: 'asc' },
      page: 2,
    });
    expect(parseTableUrlState(params('tri=bogus:asc&page=x'))).toEqual({
      q: '',
      sort: null,
      page: 1,
    });
  });
  it('cuts an over-long search and drops NUL', () => {
    const q = parseTableUrlState(params(`q=${'a'.repeat(300)}`)).q;
    expect(q).toHaveLength(100);
    expect(parseTableUrlState(params('q=a%00b')).q).toBe('ab');
  });
});

describe('searchForApi', () => {
  it('trims and turns blank into undefined', () => {
    expect(searchForApi('  usd ')).toBe('usd');
    expect(searchForApi('   ')).toBeUndefined();
  });
});

describe('nextSort', () => {
  it('cycles asc, desc, none on one column', () => {
    const a = nextSort(null, 'name');
    expect(a).toEqual({ columnId: 'name', direction: 'asc' });
    const d = nextSort(a, 'name');
    expect(d).toEqual({ columnId: 'name', direction: 'desc' });
    expect(nextSort(d, 'name')).toBeNull();
  });
  it('starts a new column at asc', () => {
    expect(nextSort({ columnId: 'name', direction: 'desc' }, 'price_eur')).toEqual({
      columnId: 'price_eur',
      direction: 'asc',
    });
  });
});

describe('applyTableUrlPatch', () => {
  it('sets and clears q and tri, keeping the period', () => {
    expect(applyTableUrlPatch('?periode=1y', { q: 'lvmh' })).toBe('?periode=1y&q=lvmh');
    expect(applyTableUrlPatch('?periode=1y&q=lvmh', { q: '  ' })).toBe('?periode=1y');
    expect(applyTableUrlPatch('', { sort: { columnId: 'perf_period', direction: 'desc' } })).toBe(
      '?tri=perf_period%3Adesc',
    );
    expect(applyTableUrlPatch('?tri=name%3Aasc', { sort: null })).toBe('');
  });
  it('drops the page when the search or the sort changes, or on request', () => {
    expect(applyTableUrlPatch('?page=3', { q: 'x' })).toBe('?q=x');
    expect(applyTableUrlPatch('?page=3&tri=name%3Aasc', { sort: null })).toBe('');
    expect(applyTableUrlPatch('?page=3&periode=1y', {}, true)).toBe('?periode=1y');
  });
  it('writes a page above 1 and omits page 1', () => {
    expect(applyTableUrlPatch('?q=a', { page: 2 })).toBe('?q=a&page=2');
    expect(applyTableUrlPatch('?q=a&page=2', { page: 1 })).toBe('?q=a');
  });
});
