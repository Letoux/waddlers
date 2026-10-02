import type { PositionsListOutput } from '@waddlers/contracts';

type Row = PositionsListOutput['rows'][number];

/** Test-only builder of a `positions.list` answer (page-level metadata isolated in one place). */
export function listOutput(rows: Row[], values?: (row: Row) => Row['values']): PositionsListOutput {
  return {
    rows: rows.map((r) => ({ ...r, values: values ? values(r) : r.values })),
    total: rows.length,
    hasMore: false,
    period: '1m',
    computedAt: null,
    oldestComputedAt: null,
  };
}
