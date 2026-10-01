'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import type { DashboardPeriod } from '@waddlers/contracts';
import { Card, CardContent } from '@/components/ui/card';
import { PERIOD_PARAM, resolvePeriod, withPeriodSearch } from '@/lib/dashboard/period';
import { EMPTY_SPACE_MESSAGE } from './block-states';
import { HistoryChart } from './history-chart';
import { Movers } from './movers';
import { PeriodSelector } from './period-selector';
import { ValueCard } from './value-card';

/**
 * Dashboard body. The period lives in the URL (`?periode=`, validated, default 1m) and drives
 * the value card, the chart and the movers; one history entry is replaced, not pushed, per change
 * (history.replaceState is integrated with `useSearchParams`, so no server round trip happens).
 */
export function Dashboard({ spaceId, positionCount }: { spaceId: string; positionCount: number }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const period = resolvePeriod(searchParams.get(PERIOD_PARAM));

  const setPeriod = useCallback(
    (next: DashboardPeriod) => {
      const search = withPeriodSearch(window.location.search, next);
      window.history.replaceState(null, '', `${pathname}${search}`);
    },
    [pathname],
  );

  if (positionCount === 0) {
    return (
      <Card>
        <CardContent>
          <p className="text-sm text-muted-foreground" data-testid="empty-space">
            {EMPTY_SPACE_MESSAGE}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground" aria-hidden>
          Période
        </span>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>
      <ValueCard spaceId={spaceId} period={period} />
      <HistoryChart spaceId={spaceId} period={period} />
      <Movers spaceId={spaceId} period={period} />
    </div>
  );
}
