import type { Decimal } from './decimal';

export interface MoverInput {
  id: string;
  name: string;
  /** Listing code, passed through for display. */
  symbol?: string;
  /** Period performance %; `null` = unavailable (excluded). */
  performance: Decimal | null;
}

export interface Movers<T extends MoverInput> {
  gainers: T[];
  losers: T[];
}

export const DEFAULT_MOVERS_LIMIT = 5;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Tie-break: case-insensitive name, then exact name, then id (code-point order, locale-independent). */
function tieBreak(a: MoverInput, b: MoverInput): number {
  return (
    compareText(a.name.toLowerCase(), b.name.toLowerCase()) ||
    compareText(a.name, b.name) ||
    compareText(a.id, b.id)
  );
}

/**
 * Gainers: performance > 0, descending. Losers: performance < 0, ascending (worst first).
 * A performance of exactly 0 and unavailable (`null`) values appear in neither list.
 * Ties are resolved deterministically by name then id.
 */
export function computeMovers<T extends MoverInput>(
  items: readonly T[],
  limit: number = DEFAULT_MOVERS_LIMIT,
): Movers<T> {
  const measured = items.filter(
    (i): i is T & { performance: Decimal } => i.performance !== null && i.performance.isFinite(),
  );
  const gainers = measured
    .filter((i) => i.performance.gt(0))
    .sort((a, b) => b.performance.cmp(a.performance) || tieBreak(a, b))
    .slice(0, limit);
  const losers = measured
    .filter((i) => i.performance.lt(0))
    .sort((a, b) => a.performance.cmp(b.performance) || tieBreak(a, b))
    .slice(0, limit);
  return { gainers, losers };
}
