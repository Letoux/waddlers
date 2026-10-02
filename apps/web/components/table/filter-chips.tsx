import { X } from 'lucide-react';
import type { DashboardPeriod, Filter, PositionsFacetsOutput } from '@waddlers/contracts';
import { Button } from '@/components/ui/button';
import { chipLabel, FILTER_NOTE } from '@/lib/table/filter-form';

/** Active filters as removable chips, "Tout effacer" and the null-hiding note (specs 21). */
export function FilterChips({
  filters,
  facets,
  period,
  onRemove,
  onClear,
}: {
  filters: readonly Filter[];
  facets: PositionsFacetsOutput | undefined;
  period: DashboardPeriod;
  onRemove: (columnId: string) => void;
  onClear: () => void;
}) {
  if (filters.length === 0) return null;
  return (
    <div className="grid gap-1.5" data-testid="active-filters">
      <ul aria-label="Filtres actifs" className="flex flex-wrap items-center gap-2">
        {filters.map((filter) => {
          const label = chipLabel(filter, facets, period);
          return (
            <li
              key={filter.columnId}
              className="inline-flex items-center gap-1 rounded-full border bg-secondary py-0.5 pr-0.5 pl-3 text-xs"
              data-testid="filter-chip"
            >
              <span>{label}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 rounded-full"
                aria-label={`Retirer le filtre ${label}`}
                onClick={() => onRemove(filter.columnId)}
              >
                <X aria-hidden className="size-3" />
              </Button>
            </li>
          );
        })}
        <li>
          <Button type="button" variant="ghost" size="sm" onClick={onClear}>
            Tout effacer
          </Button>
        </li>
      </ul>
      <p className="text-xs text-muted-foreground" data-testid="filter-note">
        {FILTER_NOTE}
      </p>
    </div>
  );
}
