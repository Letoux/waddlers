import { z } from 'zod';

/**
 * Dashboard (S5) contract shapes. Conventions (docs/ai/BACKEND.md "Dashboard (S5)"):
 * - every number is a plain decimal string (no exponent), rounded half-even ONCE at the API
 *   boundary (money and percentages: 8 decimals); an unavailable value is `null`, never "0";
 * - money is `{ amount, currency }`, currency = the space reference currency (EUR, D7);
 * - dates are exchange-local calendar dates `YYYY-MM-DD` (never an instant re-interpreted by
 *   the browser's timezone).
 */

/** Same six ids as `PERIODS` in @waddlers/domain (a server test keeps both lists equal). */
export const DASHBOARD_PERIODS = ['1w', '1m', '6m', '1y', '5y', 'max'] as const;
export const dashboardPeriodSchema = z.enum(DASHBOARD_PERIODS);
export type DashboardPeriod = z.infer<typeof dashboardPeriodSchema>;

export const dashboardInputSchema = z.object({
  spaceId: z.uuid(),
  period: dashboardPeriodSchema,
});
export type DashboardInput = z.infer<typeof dashboardInputSchema>;

/**
 * D22 (2026-09-30): how the chart converts foreign-currency closes to EUR.
 * - `historical` (default): each point uses that day's stored rate, forward-filled within the FX tolerance;
 * - `current`: every point uses the latest stored rate per currency (label "au taux de change actuel").
 * A missing rate is never replaced by 1: the day is null / the position is missing.
 */
export const FX_MODES = ['historical', 'current'] as const;
export const fxModeSchema = z.enum(FX_MODES);
export type FxMode = z.infer<typeof fxModeSchema>;
export const DASHBOARD_FX_CURRENT_LABEL = 'au taux de change actuel';

export const dashboardHistoryInputSchema = dashboardInputSchema.extend({
  fxMode: fxModeSchema.default('historical'),
});
export type DashboardHistoryInput = z.input<typeof dashboardHistoryInputSchema>;

const plainDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimalString = z.string();

export const moneySchema = z.object({
  amount: decimalString.nullable(),
  currency: z.string(),
});
export type MoneyOutput = z.infer<typeof moneySchema>;

export const namedPositionSchema = z.object({ positionId: z.uuid(), name: z.string() });

export const valuationMissingReasonSchema = z.enum([
  'quantity_invalid',
  'price_missing',
  'price_invalid',
  'currency_invalid',
  'fx_missing',
]);

export const invalidPositionSchema = namedPositionSchema.extend({
  reason: z.literal('quantity_invalid'),
});

/** Period headline: first vs last COMPLETE point of the value series (D20). */
export const dashboardHeadlineSchema = z.object({
  /** Timeline date of the first complete point (may be after the period target). */
  fromDate: plainDate,
  /** Actual trading day behind the first point: label "depuis le ..." with this one. */
  baseDate: plainDate,
  toDate: plainDate,
  startValue: moneySchema,
  endValue: moneySchema,
  change: moneySchema,
  /** `null` when the start value is <= 0. */
  changePct: decimalString.nullable(),
});
export type DashboardHeadline = z.infer<typeof dashboardHeadlineSchema>;

export const dashboardFreshnessSchema = z.object({
  /** Oldest end-price date among the valued positions; `null` when nothing is valued. */
  asOf: plainDate.nullable(),
  /** Oldest FX rate date used; `null` when no conversion was needed. */
  fxAsOf: plainDate.nullable(),
  /** True when any input is older than the stale threshold (see BACKEND.md). Never "realtime". */
  isStale: z.boolean(),
  stalePositions: z.array(namedPositionSchema.extend({ asOf: plainDate })),
  staleFx: z.array(z.object({ currency: z.string(), date: plainDate })),
});

export const dashboardSummaryOutputSchema = z.object({
  period: dashboardPeriodSchema,
  /** Current value of the held positions; `amount` is null when no position could be valued. */
  total: moneySchema,
  /** False = partial total (D5): show `missing` as a warning. */
  isComplete: z.boolean(),
  missing: z.array(namedPositionSchema.extend({ reason: valuationMissingReasonSchema })),
  /** Positions with a quantity (watchlist entries excluded, D9). */
  heldCount: z.number().int().min(0),
  valuedCount: z.number().int().min(0),
  watchlistCount: z.number().int().min(0),
  /** Derived from the same series as `dashboard.history`; `null` with fewer than two complete points. */
  change: dashboardHeadlineSchema.nullable(),
  leadingMissing: z.array(namedPositionSchema),
  invalidPositions: z.array(invalidPositionSchema),
  freshness: dashboardFreshnessSchema,
  /** Rates used for the total, ECB convention: `1 EUR = ratePerEur <currency>`. */
  fxRates: z.array(z.object({ currency: z.string(), ratePerEur: decimalString, date: plainDate })),
});
export type DashboardSummaryOutput = z.infer<typeof dashboardSummaryOutputSchema>;

export const DASHBOARD_HISTORY_LABEL = 'valeur des positions actuelles';

/** An FX rate applied to a point, ECB direction (`1 EUR = ratePerEur <currency>`) plus the §34 display direction. */
export const appliedFxRateSchema = z.object({
  /** Major currency (a GBX position is reported with its GBP rate; the UI notes the minor unit). */
  currency: z.string(),
  ratePerEur: decimalString,
  /** EUR per 1 unit of the currency (specs 34: "USD/EUR : 0,85"), 8 decimals. Display only. */
  eurPerUnit: decimalString,
  /** Date of the stored rate actually applied (historical: forward-filled; current: the latest rate's date). */
  rateDate: plainDate,
});
export type AppliedFxRate = z.infer<typeof appliedFxRateSchema>;

export const dashboardHistoryPointSchema = z.object({
  date: plainDate,
  /** Null on a gap day (a counted position had no close/FX): render a gap, never 0. */
  value: decimalString.nullable(),
  /** % vs the headline start; null when the value or the headline is unavailable. */
  evolutionPct: decimalString.nullable(),
  /** Most recent actual close date behind the value; null on gap days. */
  dataDate: plainDate.nullable(),
  /** Tooltip rates: one per non-EUR currency held on that day (empty for an all-EUR space). */
  fxRates: z.array(appliedFxRateSchema),
});

export const dashboardHistoryOutputSchema = z.object({
  period: dashboardPeriodSchema,
  currency: z.string(),
  /** D6: current quantities x past prices, NOT a return history. */
  basis: z.literal('current_quantities_past_prices'),
  /** Chart label (D6): "valeur des positions actuelles", followed by "depuis le <headline.baseDate>". */
  label: z.literal(DASHBOARD_HISTORY_LABEL),
  /** D22: the mode the series was built with (echo of the input). */
  fxMode: fxModeSchema,
  /** "au taux de change actuel" in `current` mode, `null` in `historical` mode. */
  fxLabel: z.literal(DASHBOARD_FX_CURRENT_LABEL).nullable(),
  /** `current` mode only: the latest rate per currency used for every point (with its date); else `null`. */
  currentFxRates: z.array(appliedFxRateSchema).nullable(),
  /** At most 400 points, first and last always kept. */
  points: z.array(dashboardHistoryPointSchema),
  /** Points of the trimmed series before downsampling. */
  totalPoints: z.number().int().min(0),
  headline: dashboardHeadlineSchema.nullable(),
  /** Positions without data at the period start: "pas de donnée avant la création de X" (D20). */
  leadingMissing: z.array(namedPositionSchema),
  invalidPositions: z.array(invalidPositionSchema),
  /** Exchange-local date of the newest end price behind the series; null when there is no data. */
  asOf: plainDate.nullable(),
});
export type DashboardHistoryOutput = z.infer<typeof dashboardHistoryOutputSchema>;

export const moverSchema = z.object({
  positionId: z.uuid(),
  instrumentId: z.uuid(),
  name: z.string(),
  symbol: z.string(),
  exchange: z.object({ mic: z.string(), name: z.string() }),
  /** Period performance in percent, in the listing's LOCAL currency (D4). Never null in a mover. */
  performancePct: decimalString,
  /** Actual trading day of the base price. */
  baseDate: plainDate,
  /** End-price date used for the performance (staleness hint). */
  asOf: plainDate.nullable(),
  /** Raw listing currency the performance was computed in (may be a minor unit such as GBX). */
  currency: z.string(),
});
export type Mover = z.infer<typeof moverSchema>;

export const dashboardMoversOutputSchema = z.object({
  period: dashboardPeriodSchema,
  /** Top 5, best first. Watchlist entries included (D9). */
  gainers: z.array(moverSchema),
  /** Top 5, worst first. */
  losers: z.array(moverSchema),
});
export type DashboardMoversOutput = z.infer<typeof dashboardMoversOutputSchema>;
