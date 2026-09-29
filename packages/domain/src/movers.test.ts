import { describe, expect, it } from 'vitest';
import { Decimal } from './decimal';
import { computeMovers, type MoverInput } from './movers';

const m = (id: string, name: string, perf: string | null): MoverInput => ({
  id,
  name,
  performance: perf === null ? null : new Decimal(perf),
});
const ids = (xs: MoverInput[]) => xs.map((x) => x.id);

describe('computeMovers (specs §14)', () => {
  it('splits gainers (desc) and losers (worst first)', () => {
    const r = computeMovers([
      m('a', 'A', '5'),
      m('b', 'B', '-3'),
      m('c', 'C', '12.5'),
      m('d', 'D', '-10'),
      m('e', 'E', '0.01'),
    ]);
    expect(ids(r.gainers)).toEqual(['c', 'a', 'e']);
    expect(ids(r.losers)).toEqual(['d', 'b']);
  });

  it('excludes null and exactly-zero performances from both lists', () => {
    const r = computeMovers([m('n', 'N', null), m('z', 'Z', '0'), m('p', 'P', '1')]);
    expect(ids(r.gainers)).toEqual(['p']);
    expect(r.losers).toEqual([]);
  });

  it('returns empty lists for empty input', () => {
    expect(computeMovers([])).toEqual({ gainers: [], losers: [] });
  });

  it('limits to 5 by default and honours a custom limit', () => {
    const items = Array.from({ length: 8 }, (_, i) => m(`g${i}`, `G${i}`, String(i + 1)));
    expect(ids(computeMovers(items).gainers)).toEqual(['g7', 'g6', 'g5', 'g4', 'g3']);
    expect(computeMovers(items, 2).gainers).toHaveLength(2);
    const losers = Array.from({ length: 8 }, (_, i) => m(`l${i}`, `L${i}`, String(-(i + 1))));
    expect(ids(computeMovers(losers).losers)).toEqual(['l7', 'l6', 'l5', 'l4', 'l3']);
  });

  it('breaks ties by name (case-insensitive) then id, independent of input order', () => {
    const items = [
      m('3', 'beta', '5'),
      m('2', 'Alpha', '5'),
      m('1', 'Alpha', '5'),
      m('4', 'alpha', '5'),
    ];
    const expected = ['1', '2', '4', '3'];
    expect(ids(computeMovers(items).gainers)).toEqual(expected);
    expect(ids(computeMovers([...items].reverse()).gainers)).toEqual(expected);
    const losers = items.map((i) => ({ ...i, performance: new Decimal(-5) }));
    expect(ids(computeMovers(losers).losers)).toEqual(expected);
  });

  it('compares decimals exactly, not as floats', () => {
    const r = computeMovers([m('a', 'A', '0.30000000000000004'), m('b', 'B', '0.3')]);
    expect(ids(r.gainers)).toEqual(['a', 'b']);
  });

  it('preserves extra fields and does not mutate the input', () => {
    const items = [
      { ...m('a', 'A', '1'), symbol: 'AAA' },
      { ...m('b', 'B', '2'), symbol: 'BBB' },
    ];
    const snapshot = [...items];
    const r = computeMovers(items);
    expect(r.gainers[0]?.symbol).toBe('BBB');
    expect(items).toEqual(snapshot);
  });
});

describe('computeMovers input hardening', () => {
  it('excludes NaN and Infinity performances', () => {
    const r = computeMovers([
      m('n', 'N', 'NaN'),
      m('i', 'I', 'Infinity'),
      m('x', 'X', '-Infinity'),
      m('a', 'A', '1'),
    ]);
    expect(ids(r.gainers)).toEqual(['a']);
    expect(r.losers).toEqual([]);
  });

  it('supports limit 0 and rejects invalid limits', () => {
    expect(computeMovers([m('a', 'A', '1'), m('b', 'B', '-1')], 0)).toEqual({
      gainers: [],
      losers: [],
    });
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => computeMovers([], bad)).toThrow(RangeError);
    }
  });
});
