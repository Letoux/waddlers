import type { AppliedFxRate } from '@waddlers/contracts';

/**
 * Display helpers for the dashboard (fr-FR). Inputs are the API's decimal strings; formatting is
 * display-only (no arithmetic on money). `null`/unparseable values render as `—`, never 0
 * (CLAUDE.md 5). Dates are exchange-local `YYYY-MM-DD`: they are formatted from their parts in UTC
 * so the browser timezone can never shift the day.
 */
export const UNAVAILABLE = '—';
const NBSP = ' ';

function toNumber(value: string | null | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const eur = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});
const eurSigned = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
  signDisplay: 'exceptZero',
});
const eurCompact = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const pct = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const pctSigned = new Intl.NumberFormat('fr-FR', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
  signDisplay: 'exceptZero',
});
const rate = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

/** "128 450 €". */
export function formatEur(amount: string | null | undefined): string {
  const n = toNumber(amount);
  return n === null ? UNAVAILABLE : eur.format(n);
}

/** "+12 430 €" / "−1 200 €" (zero has no sign). */
export function formatSignedEur(amount: string | null | undefined): string {
  const n = toNumber(amount);
  return n === null ? UNAVAILABLE : eurSigned.format(n);
}

/** Axis tick: "128 k €". */
export function formatEurCompact(n: number): string {
  return Number.isFinite(n) ? eurCompact.format(n) : UNAVAILABLE;
}

/** "10,7 %" (the API sends percent units, e.g. "10.7"). */
export function formatPct(value: string | null | undefined): string {
  const n = toNumber(value);
  return n === null ? UNAVAILABLE : `${pct.format(n)}${NBSP}%`;
}

/** "+10,7 %" / "−3,2 %". */
export function formatSignedPct(value: string | null | undefined): string {
  const n = toNumber(value);
  return n === null ? UNAVAILABLE : `${pctSigned.format(n)}${NBSP}%`;
}

/** Sign of a decimal string, for the gain/loss styling; `null` when unavailable. */
export function signOf(value: string | null | undefined): -1 | 0 | 1 | null {
  const n = toNumber(value);
  return n === null ? null : n > 0 ? 1 : n < 0 ? -1 : 0;
}

const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function plainDateToUtc(date: string): Date | null {
  const m = PLAIN_DATE.exec(date);
  if (!m) return null;
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(y, mo - 1, da));
  // Date.UTC rolls 2026-13-99 over: only a round-trip proves a real calendar date.
  return d.getUTCFullYear() === y && d.getUTCMonth() === mo - 1 && d.getUTCDate() === da ? d : null;
}

const longDate = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const numericDate = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});
const shortDate = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const monthYear = new Intl.DateTimeFormat('fr-FR', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "18 juin 2026". */
export function formatLongDate(date: string | null | undefined): string {
  const d = date ? plainDateToUtc(date) : null;
  return d ? longDate.format(d) : UNAVAILABLE;
}

/** "29/09/2026". */
export function formatNumericDate(date: string | null | undefined): string {
  const d = date ? plainDateToUtc(date) : null;
  return d ? numericDate.format(d) : UNAVAILABLE;
}

/** Axis tick: "29 sept." for spans up to about a year, "sept. 2024" beyond. */
export function formatAxisDate(date: string, spanDays: number): string {
  const d = plainDateToUtc(date);
  if (!d) return UNAVAILABLE;
  return spanDays > 400 ? monthYear.format(d) : shortDate.format(d);
}

/** Whole days between two plain dates (0 when either is invalid). */
export function daysBetween(from: string, to: string): number {
  const a = plainDateToUtc(from);
  const b = plainDateToUtc(to);
  return a && b ? Math.round((b.getTime() - a.getTime()) / 86_400_000) : 0;
}

export type FxLine = { text: string; note: string | null };

/** Minor units a listing can be quoted in (a rate is reported for the major currency). */
const MINOR_UNITS = new Set(['GBX', 'ZAC', 'ILA']);

/**
 * Specs 34 direction: "USD/EUR : 0,8807 (taux du 29/09/2026)" from `eurPerUnit`. The pence note
 * is shown only when a position is really quoted in a minor unit (`quotedCurrencies`).
 */
export function fxRateLine(r: AppliedFxRate): FxLine {
  const n = toNumber(r.eurPerUnit);
  const value = n === null ? UNAVAILABLE : rate.format(n);
  const minor = r.quotedCurrencies.filter((c) => MINOR_UNITS.has(c.toUpperCase()));
  const note =
    minor.length === 0
      ? null
      : minor.includes('GBX')
        ? 'Cours en GBX (pence), convertis via la livre (GBP).'
        : `Cours en ${minor.join(', ')} (unité mineure), convertis via ${r.currency}.`;
  return {
    text: `${r.currency}/EUR${NBSP}: ${value} (taux du ${formatNumericDate(r.rateDate)})`,
    note,
  };
}
