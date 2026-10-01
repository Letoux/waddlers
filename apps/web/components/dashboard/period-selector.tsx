'use client';

import type { DashboardPeriod } from '@waddlers/contracts';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PERIOD_OPTIONS, parsePeriodParam } from '@/lib/dashboard/period';

/** Global period selector (specs 11). Controlled: the URL is the source of truth. */
export function PeriodSelector({
  value,
  onChange,
}: {
  value: DashboardPeriod;
  onChange: (period: DashboardPeriod) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        const next = parsePeriodParam(v);
        if (next) onChange(next);
      }}
    >
      <SelectTrigger aria-label="Période" data-testid="period-selector" className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PERIOD_OPTIONS.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
