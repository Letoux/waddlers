'use client';

import { useState } from 'react';
import {
  BETWEEN_FILTER_COLUMN_IDS,
  TABLE_COLUMNS_BY_ID,
  type BetweenFilter,
  type BetweenFilterColumnId,
  type DashboardPeriod,
  type Filter,
} from '@waddlers/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  boundToText,
  buildBetweenFilter,
  filterColumnName,
  upsertFilter,
} from '@/lib/table/filter-form';

type Draft = { min: string; max: string };
type Errors = Partial<Record<BetweenFilterColumnId, string>>;

const unitOf = (id: BetweenFilterColumnId) => {
  const unit = TABLE_COLUMNS_BY_ID.get(id)?.unit;
  return unit === 'percent' ? '%' : unit === 'eur' ? '€' : '';
};

function initialDrafts(filters: readonly Filter[]) {
  const drafts = {} as Record<BetweenFilterColumnId, Draft>;
  for (const id of BETWEEN_FILTER_COLUMN_IDS) {
    const f = filters.find((x): x is BetweenFilter => x.kind === 'between' && x.columnId === id);
    drafts[id] = { min: boundToText(f?.min), max: boundToText(f?.max) };
  }
  return drafts;
}

/**
 * Min/max inputs of the `between` filters (performances in %, prices and values in EUR). Typed
 * with the French comma; applied together by "Appliquer" (Enter works too); a column with both
 * bounds empty has no filter. Nothing is applied while a bound is invalid or min > max.
 * The parent remounts this form (`key`) when the filters change elsewhere (chip, "Tout effacer").
 */
export function RangeFiltersForm({
  filters,
  period,
  onApply,
}: {
  filters: readonly Filter[];
  period: DashboardPeriod;
  onApply: (filters: Filter[]) => void;
}) {
  const [drafts, setDrafts] = useState(() => initialDrafts(filters));
  const [errors, setErrors] = useState<Errors>({});

  const apply = () => {
    let next: Filter[] = [...filters];
    const found: Errors = {};
    for (const id of BETWEEN_FILTER_COLUMN_IDS) {
      const d = drafts[id];
      const result = buildBetweenFilter(id, d.min, d.max);
      if (!result.ok) found[id] = result.minError ?? result.maxError ?? result.rangeError ?? '';
      else next = upsertFilter(next, id, result.filter);
    }
    setErrors(found);
    if (Object.keys(found).length === 0) onApply(next);
  };

  return (
    <form
      className="grid gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      {BETWEEN_FILTER_COLUMN_IDS.map((id) => {
        const name = filterColumnName(id, period);
        const unit = unitOf(id);
        const error = errors[id];
        const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
          setDrafts((d) => ({ ...d, [id]: { ...d[id], [key]: e.target.value } }));
        return (
          <div key={id} role="group" aria-labelledby={`range-${id}`} className="grid gap-1">
            <p id={`range-${id}`} className="mb-1 text-sm">
              {name}
              {unit && <span className="text-muted-foreground"> ({unit})</span>}
            </p>
            <div className="flex gap-2">
              <Input
                inputMode="decimal"
                autoComplete="off"
                placeholder="Min"
                aria-label={`Minimum ${name}`}
                aria-invalid={!!error}
                value={drafts[id].min}
                onChange={set('min')}
              />
              <Input
                inputMode="decimal"
                autoComplete="off"
                placeholder="Max"
                aria-label={`Maximum ${name}`}
                aria-invalid={!!error}
                value={drafts[id].max}
                onChange={set('max')}
              />
            </div>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        );
      })}
      <Button type="submit" size="sm" className="w-fit">
        Appliquer
      </Button>
    </form>
  );
}
