import type { AppliedFxRate, DashboardHistoryOutput } from '@waddlers/contracts';
import { daysBetween, formatEur, formatLongDate, formatSignedPct } from './format';

type Point = DashboardHistoryOutput['points'][number];

/** Chart datum: `value` is `null` on a gap day (rendered as a gap, never 0). */
export type ChartDatum = { date: string; value: number | null; point: Point };

export function toChartData(points: Point[]): ChartDatum[] {
  return points.map((point) => {
    const n = point.value === null ? null : Number(point.value);
    return { date: point.date, value: n !== null && Number.isFinite(n) ? n : null, point };
  });
}

export function spanDays(data: ChartDatum[]): number {
  const first = data[0];
  const last = data[data.length - 1];
  return first && last ? daysBetween(first.date, last.date) : 0;
}

/** Text alternative of the plot for assistive technology. */
export function chartSummary(history: DashboardHistoryOutput): string {
  const valued = history.points.filter((p) => p.value !== null);
  const first = valued[0];
  const last = valued[valued.length - 1];
  if (!first || !last) return 'Aucune valeur à afficher sur cette période.';
  const nums = valued.map((p) => Number(p.value));
  const min = valued[nums.indexOf(Math.min(...nums))];
  const max = valued[nums.indexOf(Math.max(...nums))];
  return (
    `Du ${formatLongDate(first.date)} au ${formatLongDate(last.date)} : ` +
    `de ${formatEur(first.value)} à ${formatEur(last.value)} ` +
    `(${formatSignedPct(history.headline?.changePct)}). ` +
    `Minimum ${formatEur(min?.value)} le ${formatLongDate(min?.date)}, ` +
    `maximum ${formatEur(max?.value)} le ${formatLongDate(max?.date)}.`
  );
}

/** At most `max` evenly spaced points (first and last kept) for the screen-reader table. */
export function sampleForTable(points: Point[], max = 12): Point[] {
  if (points.length <= max) return points;
  const out: Point[] = [];
  for (let i = 0; i < max; i++) {
    const p = points[Math.round((i * (points.length - 1)) / (max - 1))];
    if (p) out.push(p);
  }
  return out;
}

/**
 * Rates shown in a point's tooltip (D22): the point's own historical rates; in `current` mode the
 * API sends the single set of current rates once (`currentFxRates`) instead of per point.
 */
export function tooltipRates(point: Point, currentRates: AppliedFxRate[] | null): AppliedFxRate[] {
  return point.fxRates.length > 0 ? point.fxRates : (currentRates ?? []);
}
