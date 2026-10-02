/**
 * Reason codes carried by a table cell whose value is `null` (S6). Single source of truth for the
 * backend emitters and the UI label map (a new code must be labelled: the frontend map is typed
 * over these). The performance codes mirror `UnavailableReason` of `@waddlers/domain`
 * (this package cannot import it: browser-safe contract).
 */
export const PRICE_EUR_REASONS = [
  'metrics_missing',
  'price_missing',
  'price_invalid',
  'currency_invalid',
  'fx_missing',
  'rounds_to_zero',
] as const;

/** Tracked value only (no quantity). */
export const TRACKED_VALUE_REASONS = ['watchlist'] as const;

export const PERF_REASONS = [
  'empty_series',
  'history_starts_after_target',
  'gap_exceeds_tolerance',
  'end_missing',
  'end_invalid',
  'history_completeness_unknown',
  'history_gap_at_start',
  'insufficient_history',
] as const;

export const TABLE_REASONS = [
  ...PRICE_EUR_REASONS,
  ...TRACKED_VALUE_REASONS,
  ...PERF_REASONS,
] as const;
export type TableReason = (typeof TABLE_REASONS)[number];
