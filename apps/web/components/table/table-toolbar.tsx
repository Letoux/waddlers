'use client';

import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { TABLE_PAGE_SIZES, type DashboardPeriod } from '@waddlers/contracts';
import { PeriodSelector } from '@/components/dashboard/period-selector';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { POSITIONS_SEARCH_MAX } from '@waddlers/contracts';
import { countLabel } from '@/lib/table/pagination';
import type { Density, PageSize } from '@/lib/table/config-state';

/**
 * Search and period (URL), column/filter panels, density and page size (saved config), and the
 * result count (specs 20, 11, 16, 21).
 */
export function TableToolbar({
  search,
  onSearch,
  period,
  onPeriod,
  density,
  onDensity,
  pageSize,
  onPageSize,
  panels,
  total,
}: {
  search: string;
  onSearch: (value: string) => void;
  period: DashboardPeriod;
  onPeriod: (period: DashboardPeriod) => void;
  density: Density;
  onDensity: (density: Density) => void;
  pageSize: PageSize;
  onPageSize: (size: PageSize) => void;
  /** The "Colonnes" and "Filtres" buttons. */
  panels: ReactNode;
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
      <div className="flex gap-2">{panels}</div>
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
      <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v) as PageSize)}>
        <SelectTrigger aria-label="Lignes par page" data-testid="page-size" className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TABLE_PAGE_SIZES.map((size) => (
            <SelectItem key={size} value={String(size)}>
              {size} lignes
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
