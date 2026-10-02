import { describe, expect, it } from 'vitest';
import { countLabel, lastPage, noMatchMessage, rangeLabel } from './pagination';

describe('pagination labels', () => {
  it('range with a fr-FR thousands separator', () => {
    expect(rangeLabel(1, 50, 5000)).toBe(`1–50 sur 5${' '}000`);
    expect(rangeLabel(2, 10, 60)).toBe('51–60 sur 60');
    expect(rangeLabel(1, 0, 0)).toBe('0 sur 0');
  });
  it('last page', () => {
    expect(lastPage(0)).toBe(1);
    expect(lastPage(50)).toBe(1);
    expect(lastPage(51)).toBe(2);
    expect(lastPage(5000)).toBe(100);
  });
  it('count and no-match wording', () => {
    expect(countLabel(0)).toBe('0 titre');
    expect(countLabel(1)).toBe('1 titre');
    expect(countLabel(60)).toBe('60 titres');
    expect(noMatchMessage(' zzz ')).toBe('Aucun titre ne correspond à « zzz ».');
  });
});
