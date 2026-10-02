'use client';

import { useQuery } from '@tanstack/react-query';
import type { DashboardPeriod, TableColumnId, TableSort } from '@waddlers/contracts';
import { keepWithinSpace } from '@/lib/dashboard/queries';
import { orpc } from '@/lib/orpc';
import { dashboardRetryDelay, shouldRetryDashboardQuery } from '@/lib/query-retry';
import { pageOffset, PAGE_SIZE, searchForApi } from './url-state';

/** The worker refreshes quotes every 15 minutes; a refetch only reads PostgreSQL (BACKEND.md). */
export const POSITIONS_STALE_MS = 60_000;

export type TableQueryState = {
  spaceId: string;
  period: DashboardPeriod;
  /** Debounced search text (`''` = none). */
  search: string;
  sort: TableSort | null;
  /** 1-based. */
  page: number;
  columns: readonly TableColumnId[];
};

/**
 * Server-side table query: one cache entry per (space, period, search, sort, page, columns), so
 * returning to a combination within the staleTime starts no request. A 429 (should the backend
 * ever answer one) follows the dashboard policy.
 */
export function useTablePositions(state: TableQueryState) {
  const search = searchForApi(state.search);
  return useQuery(
    orpc.positions.list.queryOptions({
      input: {
        spaceId: state.spaceId,
        period: state.period,
        ...(search ? { search } : {}),
        ...(state.sort ? { sort: state.sort } : {}),
        page: { offset: pageOffset(state.page), limit: PAGE_SIZE },
        columns: [...state.columns],
      },
      staleTime: POSITIONS_STALE_MS,
      placeholderData: keepWithinSpace(state.spaceId),
      retry: shouldRetryDashboardQuery,
      retryDelay: dashboardRetryDelay,
    }),
  );
}
