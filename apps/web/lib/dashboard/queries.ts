'use client';

import { useQuery } from '@tanstack/react-query';
import type { DashboardPeriod, FxMode } from '@waddlers/contracts';
import { orpc } from '@/lib/orpc';
import { dashboardRetryDelay, shouldRetryDashboardQuery } from '@/lib/query-retry';

/**
 * Dashboard server state (specs 28). oRPC builds each key from the procedure path and its input,
 * so the keys are `[..., { spaceId, period }]` (+ `fxMode` for the history) and a change of any of
 * them is a distinct cache entry. staleTime follows BACKEND.md: a return to the dashboard within
 * the window reads the cache and starts no request; a refetch only reads PostgreSQL.
 */
export const SUMMARY_STALE_MS = 60_000;
export const HISTORY_STALE_MS = 5 * 60_000;
export const MOVERS_STALE_MS = 5 * 60_000;

/**
 * Keep the previous answer while the next period / FX mode loads, so a quick change shows no
 * skeleton or error flash. Only within the same space: another space's figures are never shown
 * under this one (keys embed the space id, so a text search of the key is enough).
 */
export function keepWithinSpace(spaceId: string) {
  return <T>(
    previous: T | undefined,
    previousQuery: { queryKey: readonly unknown[] } | undefined,
  ): T | undefined =>
    previousQuery && JSON.stringify(previousQuery.queryKey).includes(JSON.stringify(spaceId))
      ? previous
      : undefined;
}

/** Heavy, per-user limited procedures: a 429 is retried (see `shouldRetryDashboardQuery`). */
const LIMITED = { retry: shouldRetryDashboardQuery, retryDelay: dashboardRetryDelay } as const;

export function useSummary(spaceId: string, period: DashboardPeriod) {
  return useQuery(
    orpc.dashboard.summary.queryOptions({
      input: { spaceId, period },
      staleTime: SUMMARY_STALE_MS,
      placeholderData: keepWithinSpace(spaceId),
      ...LIMITED,
    }),
  );
}

export function useHistory(spaceId: string, period: DashboardPeriod, fxMode: FxMode) {
  return useQuery(
    orpc.dashboard.history.queryOptions({
      input: { spaceId, period, fxMode },
      staleTime: HISTORY_STALE_MS,
      placeholderData: keepWithinSpace(spaceId),
      ...LIMITED,
    }),
  );
}

export function useMovers(spaceId: string, period: DashboardPeriod) {
  return useQuery(
    orpc.dashboard.movers.queryOptions({
      input: { spaceId, period },
      staleTime: MOVERS_STALE_MS,
      placeholderData: keepWithinSpace(spaceId),
    }),
  );
}
