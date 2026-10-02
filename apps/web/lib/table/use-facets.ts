'use client';

import { useQuery } from '@tanstack/react-query';
import { orpc } from '@/lib/orpc';
import { dashboardRetryDelay, shouldRetryDashboardQuery } from '@/lib/query-retry';

/**
 * Choices of the `in` filters (specs 21): PostgreSQL only, cheap, ignores search and filters.
 * Own in-flight cap of 4 (typed 429): same retry policy as the dashboard and the table.
 */
export function usePositionsFacets(spaceId: string) {
  return useQuery(
    orpc.positions.facets.queryOptions({
      input: { spaceId },
      staleTime: 60_000,
      retry: shouldRetryDashboardQuery,
      retryDelay: dashboardRetryDelay,
    }),
  );
}
