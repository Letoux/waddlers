'use client';

import { Search } from 'lucide-react';
import type { DashboardPeriod } from '@waddlers/contracts';
import { PeriodSelector } from '@/components/dashboard/period-selector';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { POSITIONS_SEARCH_MAX } from '@waddlers/contracts';
import { countLabel } from '@/lib/table/pagination';
import type { Density } from '@/lib/table/density';

/** Search, period, density and result count (specs 20, 11). The URL owns the values. */
export function TableToolbar({
  search,
  onSearch,
  period,
  onPeriod,
  density,
  onDensity,
  total,
}: {
  search: string;
  onSearch: (value: string) => void;
  period: DashboardPeriod;
  onPeriod: (period: DashboardPeriod) => void;
  density: Density;
  onDensity: (density: Density) => void;
  total: number | null;
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <div className="relative w-full max-w-sm min-w-0 flex-1 basis-56">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          name="q"
          aria-label="Rechercher un titre"
          placeholder="Nom, code, devise, place…"
          autoComplete="off"
          maxLength={POSITIONS_SEARCH_MAX}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="pl-8"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground" aria-hidden>
          Période
        </span>
        <PeriodSelector value={period} onChange={onPeriod} />
      </div>
      <div role="group" aria-label="Densité" className="flex gap-1">
        {(
          [
            ['comfortable', 'Confortable'],
            ['compact', 'Compacte'],
          ] as const
        ).map(([id, label]) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={density === id ? 'secondary' : 'ghost'}
            aria-pressed={density === id}
            onClick={() => onDensity(id)}
          >
            {label}
          </Button>
        ))}
      </div>
      <p
        className="ml-auto text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
        data-testid="result-count"
      >
        {total === null ? '' : countLabel(total)}
      </p>
    </div>
  );
}
