import { describe, expect, it } from 'vitest';
import { countLabel, lastPage, noMatchMessage, noResultsMessage, rangeLabel } from './pagination';

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

describe('pagination with a configured page size', () => {
  it('range and last page follow the size', () => {
    expect(rangeLabel(2, 25, 60, 25)).toBe('26–50 sur 60');
    expect(rangeLabel(1, 60, 60, 200)).toBe('1–60 sur 60');
    expect(lastPage(60, 25)).toBe(3);
    expect(lastPage(60, 200)).toBe(1);
  });
});

describe('noResultsMessage', () => {
  it('names the search, the filters or both', () => {
    expect(noResultsMessage('zzz', false)).toBe('Aucun titre ne correspond à « zzz ».');
    expect(noResultsMessage('', true)).toBe('Aucun résultat pour ces filtres.');
    expect(noResultsMessage('zzz', true)).toBe('Aucun résultat pour « zzz » avec ces filtres.');
  });
});
