import { normalizeCurrency, type CurrencyCode } from './currency';
import { Decimal } from './decimal';

/**
 * EUR-based FX rates, ECB convention (D2): `rates.get('USD') = 1.17` means
 * `1 EUR = 1.17 USD`. EUR is implicit (1) and must not be listed. Rates are
 * quoted for MAJOR currencies only; minor units (GBX, ZAc) are handled by
 * normalization, never stored as rates.
 */
export type FxRates = ReadonlyMap<CurrencyCode, Decimal>;

export type FxUnavailableReason = 'currency_invalid' | 'rate_missing';

export type ConversionResult =
  { ok: true; amount: Decimal } | { ok: false; reason: FxUnavailableReason };

/** Units of `currency` per 1 EUR, or null when unknown / non-positive (never 1). */
function perEur(currency: CurrencyCode, rates: FxRates): Decimal | null {
  if (currency === 'EUR') return new Decimal(1);
  const rate = rates.get(currency);
  if (rate === undefined || !rate.isFinite() || !rate.gt(0)) return null;
  return rate;
}

/**
 * Converts `amount` (in `from`) to `to`.
 * Direction: EUR-amount = amount / rate[from]; result = EUR-amount * rate[to].
 * e.g. 250 USD -> EUR at 1 EUR = 1.25 USD  =>  200 EUR;  100 EUR -> USD => 125 USD.
 * Minor units are normalized on both sides (GBX -> GBP is /100; EUR -> GBX is x100).
 * Same currency after normalization is an exact identity and needs no rate.
 * A missing/invalid rate is a failure result, never an implicit 1.
 */
export function convertAmount(
  amount: Decimal,
  from: CurrencyCode,
  to: CurrencyCode,
  rates: FxRates,
): ConversionResult {
  const f = normalizeCurrency(from);
  const t = normalizeCurrency(to);
  if (!f || !t) return { ok: false, reason: 'currency_invalid' };
  const major = amount.div(f.divisor);
  if (f.currency === t.currency) return { ok: true, amount: major.times(t.divisor) };
  const rateFrom = perEur(f.currency, rates);
  const rateTo = perEur(t.currency, rates);
  if (rateFrom === null || rateTo === null) return { ok: false, reason: 'rate_missing' };
  return { ok: true, amount: major.div(rateFrom).times(rateTo).times(t.divisor) };
}

/** Nullable convenience wrapper: `null` amount or any failure -> `null`. */
export function convert(
  amount: Decimal | null,
  from: CurrencyCode,
  to: CurrencyCode,
  rates: FxRates,
): Decimal | null {
  if (amount === null) return null;
  const result = convertAmount(amount, from, to, rates);
  return result.ok ? result.amount : null;
}
