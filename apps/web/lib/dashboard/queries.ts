'use client';

import { useQuery } from '@tanstack/react-query';
import type { DashboardPeriod, FxMode } from '@waddlers/contracts';
import { orpc } from '@/lib/orpc';

/**
 * Dashboard server state (specs 28). oRPC builds each key from the procedure path and its input,
 * so the keys are `[..., { spaceId, period }]` (+ `fxMode` for the history) and a change of any of
 * them is a distinct cache entry. staleTime follows BACKEND.md: a return to the dashboard within
 * the window reads the cache and starts no request; a refetch only reads PostgreSQL.
 */
export const SUMMARY_STALE_MS = 60_000;
export const HISTORY_STALE_MS = 5 * 60_000;
export const MOVERS_STALE_MS = 5 * 60_000;

export function useSummary(spaceId: string, period: DashboardPeriod) {
  return useQuery(
    orpc.dashboard.summary.queryOptions({
      input: { spaceId, period },
      staleTime: SUMMARY_STALE_MS,
    }),
  );
}

export function useHistory(spaceId: string, period: DashboardPeriod, fxMode: FxMode) {
  return useQuery(
    orpc.dashboard.history.queryOptions({
      input: { spaceId, period, fxMode },
      staleTime: HISTORY_STALE_MS,
    }),
  );
}

export function useMovers(spaceId: string, period: DashboardPeriod) {
  return useQuery(
    orpc.dashboard.movers.queryOptions({
      input: { spaceId, period },
      staleTime: MOVERS_STALE_MS,
    }),
  );
}
