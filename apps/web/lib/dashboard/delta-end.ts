import type { DashboardSummaryOutput } from '@waddlers/contracts';

/**
 * D23: the card delta must describe the same value as `total`. When the delta's real end date
 * (`change.toDate`) is older than the date of the prices behind the total, the UI says so
 * ("au <date>") instead of implying the delta reaches the total. Returns that date or `null`.
 *
 * `priceDate` is the as-of date of the total (`summary.freshness.oldestPriceDate`). The card delta
 * is always historical FX, even when the chart is in `current` mode.
 */
export function deltaEndNote(
  change: DashboardSummaryOutput['change'],
  priceDate: string | null,
): string | null {
  if (!change || !priceDate) return null;
  return change.toDate < priceDate ? change.toDate : null; // plain dates compare lexically
}
