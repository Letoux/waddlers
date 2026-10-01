import type { AppliedFxRate } from '@waddlers/contracts';
import { tooltipRates, type ChartDatum } from '@/lib/dashboard/chart-model';
import {
  formatEur,
  formatLongDate,
  formatSignedPct,
  fxRateLine,
  UNAVAILABLE,
} from '@/lib/dashboard/format';
import { ChangeFigure } from './change-figure';

type TooltipProps = { active?: boolean; payload?: ReadonlyArray<{ payload?: ChartDatum }> };

/** Specs 13 tooltip (date, value, evolution) plus the FX rates applied to the point (D22). */
export function ChartTooltip({
  active,
  payload,
  currentRates,
}: TooltipProps & { currentRates: AppliedFxRate[] | null }) {
  const datum = payload?.[0]?.payload;
  if (!active || !datum) return null;
  const { point } = datum;
  const lines = tooltipRates(point, currentRates).map(fxRateLine);
  const notes = [...new Set(lines.flatMap((l) => (l.note ? [l.note] : [])))];
  return (
    <div
      data-testid="chart-tooltip"
      className="grid max-w-64 gap-2 rounded-md border bg-card p-3 text-sm text-card-foreground shadow-md"
    >
      <p className="font-medium">{formatLongDate(point.date)}</p>
      <div>
        <p className="text-xs text-muted-foreground">Valeur</p>
        <p className="tabular-nums">
          {point.value === null ? UNAVAILABLE : formatEur(point.value)}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Évolution</p>
        <ChangeFigure raw={point.evolutionPct} text={formatSignedPct(point.evolutionPct)} />
      </div>
      {lines.length > 0 && (
        <div data-testid="tooltip-fx">
          <p className="text-xs text-muted-foreground">Taux de change appliqués</p>
          {lines.map((l) => (
            <p key={l.text} className="tabular-nums">
              {l.text}
            </p>
          ))}
          {notes.map((n) => (
            <p key={n} className="text-xs text-muted-foreground">
              {n}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
