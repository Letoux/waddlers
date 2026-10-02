'use client';

import {
  IN_FILTER_COLUMN_IDS,
  TABLE_COLUMNS_BY_ID,
  type DashboardPeriod,
  type Filter,
  type InFilter,
  type InFilterColumnId,
  type PositionsFacetsOutput,
} from '@waddlers/contracts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { mergeFacetOptions, toggleInValue } from '@/lib/table/filter-form';
import { RangeFiltersForm } from './range-filters-form';
import { ResponsivePanel } from './responsive-panel';

type FacetsState = {
  data: PositionsFacetsOutput | undefined;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
};

function InSection({
  columnId,
  filters,
  facets,
  onChange,
}: {
  columnId: InFilterColumnId;
  filters: readonly Filter[];
  facets: FacetsState;
  onChange: (filters: Filter[]) => void;
}) {
  const def = TABLE_COLUMNS_BY_ID.get(columnId);
  const current = filters.find((f): f is InFilter => f.kind === 'in' && f.columnId === columnId);
  // Active values stay listed (checked, 'absent') even when the facets no longer return them.
  const options = mergeFacetOptions(columnId, facets.data?.[columnId] ?? [], current?.values ?? []);
  return (
    <div role="group" aria-labelledby={`in-${columnId}`} className="grid gap-1.5">
      <p id={`in-${columnId}`} className="mb-1 text-sm font-medium">
        {def?.label ?? columnId}
      </p>
      {facets.isPending && <p className="text-xs text-muted-foreground">Chargement…</p>}
      {facets.isError && (
        <p className="text-xs text-muted-foreground">
          Choix indisponibles.{' '}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={facets.refetch}
          >
            Réessayer
          </Button>
        </p>
      )}
      {facets.data?.truncated[columnId] && (
        <p className="text-xs text-muted-foreground">
          Liste tronquée : seules les premières valeurs sont proposées.
        </p>
      )}
      {facets.data && options.length === 0 && (
        <p className="text-xs text-muted-foreground">Aucune valeur dans cet espace.</p>
      )}
      <div className="grid max-h-40 gap-1.5 overflow-y-auto">
        {options.map((option) => {
          const id = `filter-${columnId}-${option.value}`;
          return (
            <div key={option.value} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={current?.values.includes(option.value) ?? false}
                onCheckedChange={(v) =>
                  onChange(toggleInValue(filters, columnId, option.value, v === true))
                }
              />
              <Label htmlFor={id} className="flex-1 text-sm font-normal">
                {option.label}
                <span
                  className="ml-1 text-xs text-muted-foreground"
                  aria-label={
                    option.count === 0
                      ? 'absent de l’espace'
                      : `${option.count} titre${option.count > 1 ? 's' : ''} dans l’espace`
                  }
                >
                  {option.count === 0 ? '(absent)' : `(${option.count})`}
                </span>
              </Label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** "Filtres" panel (specs 21): checkbox lists from the facets, then the numeric ranges. */
export function FiltersPanel({
  filters,
  facets,
  period,
  onChange,
}: {
  filters: readonly Filter[];
  facets: FacetsState;
  period: DashboardPeriod;
  onChange: (filters: Filter[]) => void;
}) {
  const betweenKey = JSON.stringify(filters.filter((f) => f.kind === 'between'));
  return (
    <ResponsivePanel
      label="Filtres"
      title="Filtres du tableau"
      description="Les filtres se combinent (ET) et sont enregistrés pour cet espace."
      badge={filters.length > 0 ? String(filters.length) : undefined}
      testId="filters-button"
    >
      <div className="grid gap-5" data-testid="filters-panel">
        <p className="text-xs text-muted-foreground">
          Les nombres entre parenthèses sont les titres de l’espace, sans tenir compte des autres
          filtres.
        </p>
        {IN_FILTER_COLUMN_IDS.map((id) => (
          <InSection key={id} columnId={id} filters={filters} facets={facets} onChange={onChange} />
        ))}
        <RangeFiltersForm
          key={`${betweenKey}${period}`}
          filters={filters}
          period={period}
          onApply={onChange}
        />
        <p className="text-xs text-muted-foreground">
          Filtres sur les données fondamentales (capitalisation, dette, dividendes…) : bientôt
          disponible.
        </p>
      </div>
    </ResponsivePanel>
  );
}
