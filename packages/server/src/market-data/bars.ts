import { compareDates, type PlainDate } from '@waddlers/domain';
import { toDate, toPlainDate, toPositiveDecimalString } from './normalize';
import type { DailyBar, ProviderErrorCode, Quote } from './types';

/**
 * Row-level normalization shared by adapters. A row with an unusable date or close (missing,
 * zero, negative, NaN, out of the requested range, duplicated) is DROPPED and counted, never
 * repaired or defaulted; an unusable `adjClose` alone becomes null (it is informational).
 */
export function normalizeBars(
  rows: unknown,
  range: { from: PlainDate; to: PlainDate },
): { bars: DailyBar[]; rejectedRows: number } | { error: ProviderErrorCode } {
  if (!Array.isArray(rows)) return { error: 'bad_payload' };
  const byDate = new Map<PlainDate, DailyBar>();
  let rejectedRows = 0;
  for (const row of rows as unknown[]) {
    const record = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
    const date = toPlainDate(record.date);
    const close = toPositiveDecimalString(record.close);
    if (
      date === null ||
      close === null ||
      compareDates(date, range.from) < 0 ||
      compareDates(date, range.to) > 0 ||
      byDate.has(date)
    ) {
      rejectedRows += 1;
      continue;
    }
    byDate.set(date, { date, close, adjClose: toPositiveDecimalString(record.adjusted_close) });
  }
  const bars = [...byDate.values()].sort((a, b) => compareDates(a.date, b.date));
  return { bars, rejectedRows };
}

/** One raw quote -> Quote, or null when price/timestamp are unusable or the currency differs. */
export function normalizeQuote(
  listing: { id: string; currency: string },
  raw: { price?: unknown; currency?: unknown; asOf?: unknown },
): Quote | null {
  const price = toPositiveDecimalString(raw.price);
  const asOf = toDate(raw.asOf);
  // A quote in another currency than the listing's must never be stored as if it matched.
  if (price === null || asOf === null || raw.currency !== listing.currency) return null;
  return { listingId: listing.id, price, currency: listing.currency, asOf };
}
