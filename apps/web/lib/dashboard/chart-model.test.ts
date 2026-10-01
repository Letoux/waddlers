import { describe, expect, it } from 'vitest';
import type { DashboardHistoryOutput } from '@waddlers/contracts';
import { chartSummary, sampleForTable, spanDays, toChartData } from './chart-model';

const pt = (date: string, value: string | null) => ({
  date,
  value,
  evolutionPct: null,
  dataDate: value ? date : null,
  fxRates: [],
});

describe('chart model', () => {
  it('keeps gap days as null, never 0', () => {
    const data = toChartData([pt('2026-09-01', '100'), pt('2026-09-02', null)]);
    expect(data.map((d) => d.value)).toEqual([100, null]);
    expect(spanDays(data)).toBe(1);
    expect(spanDays([])).toBe(0);
  });

  it('samples evenly and keeps the ends', () => {
    const pts = Array.from({ length: 100 }, (_, i) =>
      pt(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, String(i)),
    );
    const s = sampleForTable(pts, 10);
    expect(s).toHaveLength(10);
    expect(s[0]).toBe(pts[0]);
    expect(s[9]).toBe(pts[99]);
    expect(sampleForTable(pts.slice(0, 5), 10)).toHaveLength(5);
  });

  it('summarises for screen readers, and says so when empty', () => {
    const history = {
      points: [pt('2026-09-01', '100'), pt('2026-09-02', null), pt('2026-09-03', '120')],
      headline: { changePct: '20' },
    } as unknown as DashboardHistoryOutput;
    const text = chartSummary(history).replace(/[\u202f\u00a0]/g, ' ');
    expect(text).toContain('1 septembre 2026');
    expect(text).toContain('+20,0 %');
    expect(text).toContain('Minimum 100 €');
    expect(chartSummary({ points: [], headline: null } as unknown as DashboardHistoryOutput)).toBe(
      'Aucune valeur à afficher sur cette période.',
    );
  });
});
