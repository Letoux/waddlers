import type { Money, CurrencyCode } from './currency';
import { Decimal } from './decimal';
import { convertAmount, type FxRates } from './fx';

export interface ValuationPosition {
  id: string;
  /** `null` = watchlist entry (D9): excluded from the value, not "missing". */
  quantity: Decimal | null;
  /** Current price in the listing's local currency (may be a minor unit such as GBX). */
  price: Money | null;
}

export type ValuationMissingReason =
  'quantity_invalid' | 'price_missing' | 'price_invalid' | 'currency_invalid' | 'fx_missing';

export interface PositionValue {
  positionId: string;
  /** Value in the reference currency; `null` when not computable. Never 0 for "unknown". */
  value: Decimal | null;
  /** Present iff `value` is null for a reason other than being a watchlist entry. */
  reason?: ValuationMissingReason;
  /** True for watchlist entries (null quantity); `value` is null and no reason is reported. */
  excluded: boolean;
}

export interface SpaceValue {
  /**
   * Sum of the positions that could be valued, in `currency`. `null` when no position
   * could be valued (empty space, watchlist only, or everything missing) — an
   * empty sum is not shown as 0.
   */
  total: Decimal | null;
  currency: CurrencyCode;
  /** False when at least one held position could not be valued (partial total, D5). */
  isComplete: boolean;
  missing: { positionId: string; reason: ValuationMissingReason }[];
  rows: PositionValue[];
}

/**
 * Space value = Σ quantity × price × fx(local -> reference) (specs §32, D5, D9).
 * Reference currency is EUR for the MVP (D7). Rows keep input order.
 * Price <= 0 is treated as invalid data, quantity < 0 as invalid; quantity 0 is a
 * legitimate value of 0.
 */
export function computeSpaceValue(
  positions: readonly ValuationPosition[],
  rates: FxRates,
  referenceCurrency: CurrencyCode = 'EUR',
): SpaceValue {
  const rows: PositionValue[] = [];
  const missing: SpaceValue['missing'] = [];
  let total: Decimal | null = null;

  const fail = (positionId: string, reason: ValuationMissingReason): void => {
    rows.push({ positionId, value: null, reason, excluded: false });
    missing.push({ positionId, reason });
  };

  for (const position of positions) {
    const { id, quantity, price } = position;
    if (quantity === null) {
      rows.push({ positionId: id, value: null, excluded: true });
      continue;
    }
    if (!quantity.isFinite() || quantity.isNegative()) {
      fail(id, 'quantity_invalid');
      continue;
    }
    if (price === null || price.amount === null) {
      fail(id, 'price_missing');
      continue;
    }
    if (!price.amount.isFinite() || !price.amount.gt(0)) {
      fail(id, 'price_invalid');
      continue;
    }
    const converted = convertAmount(price.amount, price.currency, referenceCurrency, rates);
    if (!converted.ok) {
      fail(id, converted.reason === 'currency_invalid' ? 'currency_invalid' : 'fx_missing');
      continue;
    }
    const value = quantity.times(converted.amount);
    rows.push({ positionId: id, value, excluded: false });
    total = total === null ? value : total.plus(value);
  }

  return {
    total,
    currency: referenceCurrency,
    isComplete: missing.length === 0,
    missing,
    rows,
  };
}
