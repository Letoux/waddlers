import {
  DASHBOARD_PERIODS,
  dashboardPeriodSchema,
  type DashboardPeriod,
} from '@waddlers/contracts';

/** URL query parameter carrying the global period (specs 11). */
export const PERIOD_PARAM = 'periode';

/** Specs 11 shows no default; the month is the most useful glance. */
export const DEFAULT_PERIOD: DashboardPeriod = '1m';

/** Labels of specs 11 (Semaine, Mois, 6 mois, 1 an, 5 ans, Max). */
export const PERIOD_LABELS: Record<DashboardPeriod, string> = {
  '1w': 'Semaine',
  '1m': 'Mois',
  '6m': '6 mois',
  '1y': '1 an',
  '5y': '5 ans',
  max: 'Max',
};

export const PERIOD_OPTIONS = DASHBOARD_PERIODS.map((id) => ({ id, label: PERIOD_LABELS[id] }));

/** Strictly the contract enum; anything else (missing, repeated, unknown) is `null`. */
export function parsePeriodParam(
  raw: string | string[] | null | undefined,
): DashboardPeriod | null {
  if (typeof raw !== 'string') return null;
  const parsed = dashboardPeriodSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The period to use: the URL value when valid, else the default. */
export function resolvePeriod(raw: string | string[] | null | undefined): DashboardPeriod {
  return parsePeriodParam(raw) ?? DEFAULT_PERIOD;
}

/** `search` with the period set (or removed when it is the default-less `null`), keeping other params. */
export function withPeriodSearch(search: string, period: DashboardPeriod | null): string {
  const params = new URLSearchParams(search);
  if (period) params.set(PERIOD_PARAM, period);
  else params.delete(PERIOD_PARAM);
  const out = params.toString();
  return out ? `?${out}` : '';
}
