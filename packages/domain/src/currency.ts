import { Decimal, decimalToString, parseDecimal } from './decimal';

/** ISO 4217 code (`EUR`) or a known minor-unit alias (`GBX`, `GBp`, `ZAc`). */
export type CurrencyCode = string;

export interface Money {
  amount: Decimal | null;
  currency: CurrencyCode;
}

/** Wire/DB shape: decimal string amount. */
export interface SerializedMoney {
  amount: string | null;
  currency: CurrencyCode;
}

/**
 * Minor-unit aliases: code -> [major currency, divisor].
 * Exact-case match: `GBp`/`ZAc` are provider spellings, not ISO codes.
 * Others (e.g. ILA, ZAC) are deliberately NOT guessed; they normalize to `null`
 * (invalid) until added here with a test.
 */
const MINOR_UNITS: Readonly<Record<string, readonly [string, number]>> = {
  GBX: ['GBP', 100],
  GBp: ['GBP', 100],
  ZAc: ['ZAR', 100],
};

/** Provider spellings of minor units we do not support yet: rejected so they are never read as a major currency (100x error). */
const UNSUPPORTED_MINOR_UNITS: ReadonlySet<string> = new Set(['ZAC', 'ILA']);

export interface NormalizedCurrency {
  /** Major ISO code. */
  currency: CurrencyCode;
  /** Minor units in one major unit (1 for a major currency, 100 for GBX). */
  divisor: Decimal;
  isMinorUnit: boolean;
}

/** `null` when the code is neither a 3-letter uppercase code nor a known alias. */
export function normalizeCurrency(code: string): NormalizedCurrency | null {
  const minor = Object.hasOwn(MINOR_UNITS, code) ? MINOR_UNITS[code] : undefined;
  if (minor) return { currency: minor[0], divisor: new Decimal(minor[1]), isMinorUnit: true };
  if (/^[A-Z]{3}$/.test(code) && !UNSUPPORTED_MINOR_UNITS.has(code)) {
    return { currency: code, divisor: new Decimal(1), isMinorUnit: false };
  }
  return null;
}

/**
 * Converts money quoted in a minor unit to its major currency
 * (`{123, GBX}` -> `{1.23, GBP}`). Major currencies are unchanged.
 * `null` for an invalid currency code. A null amount stays null.
 */
export function normalizeMoney(money: Money): Money | null {
  const n = normalizeCurrency(money.currency);
  if (!n) return null;
  return {
    amount: money.amount === null ? null : money.amount.div(n.divisor),
    currency: n.currency,
  };
}

export function moneyFromStrings(input: SerializedMoney): Money {
  return { amount: parseDecimal(input.amount), currency: input.currency };
}

export function moneyToStrings(money: Money): SerializedMoney {
  return { amount: decimalToString(money.amount), currency: money.currency };
}
