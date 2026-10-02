import { MINOR_UNITS, UNSUPPORTED_MINOR_UNITS } from '@waddlers/domain';
import { desc, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbExecutor } from '../db/create';
import { fxDaily, listingMetrics, spacePositions } from '../db/schema';
import { FX_TOLERANCE_DAYS } from '../market-data/config';

/**
 * D25: the table's EUR price and tracked value use EXACTLY the dashboard's current rule
 * (`computeCurrentValue` / `currentRates` in `dashboard/compute.ts`), expressed in SQL so that
 * sorting stays server-side:
 *   price_eur = end price (D21, `listing_metrics.price`) / minor-unit divisor / rate,
 *   rate      = newest `fx_daily` row of the MAJOR currency dated in [spaceAsOf - 7 d, spaceAsOf],
 *   spaceAsOf = newest end-price date of the space's HELD positions.
 * The window width is the dashboard's `FX_TOLERANCE_DAYS`; the minor-unit table is the domain's
 * `MINOR_UNITS` (also what `normalizeCurrency` reads). Full precision, no rounding here: the wire
 * rounding (8 decimals, half-even) happens once, in `table-cells.ts`, like the dashboard's.
 *
 * Everything runs in the caller's (REPEATABLE READ) transaction, so the rates, the reference date
 * and the rows of one page come from one snapshot.
 */

const m = listingMetrics;

/** Literal SQL for a constant of OUR code (currency codes of the domain table); refuses anything else. */
function literal(value: string): SQL {
  if (!/^[A-Za-z]{3}$/.test(value)) throw new Error('unexpected currency literal');
  return sql.raw(`'${value}'`);
}

/** Major currency of a raw currency column (`GBX` -> `GBP`); NULL for a missing/invalid code, like `normalizeCurrency`. */
export function majorCurrencyOf(column: AnyColumn): SQL {
  return sql`case ${column} ${sql.join(
    Object.entries(MINOR_UNITS).map(
      ([raw, [major]]) => sql`when ${literal(raw)} then ${literal(major as string)}`,
    ),
    sql` `,
  )} else (case when ${column} ~ '^[A-Z]{3}$' and ${column} not in (${sql.join(
    [...UNSUPPORTED_MINOR_UNITS].map(literal),
    sql`, `,
  )}) then ${column} end) end`;
}

/** Major currency of the PRICE currency (the one the rate is looked up for). */
export const priceMajorCurrency: SQL = majorCurrencyOf(m.priceCurrency);

/** Minor units in one major unit of the price currency (100 for GBX). */
export const priceDivisor: SQL = sql`case ${m.priceCurrency} ${sql.join(
  Object.entries(MINOR_UNITS).map(
    ([raw, [, divisor]]) => sql`when ${literal(raw)} then ${sql.raw(String(divisor))}::numeric`,
  ),
  sql` `,
)} else 1::numeric end`;

/**
 * Per major currency, the newest stored rate in the space's window (one row per currency). The
 * reference date is the newest end-price date of the HELD positions; a space without any held
 * priced position falls back to the newest over all its entries (a watchlist-only space has no
 * dashboard total to agree with, and its rows still need a date to pick a rate for).
 */
export function currentFxRates(db: DbExecutor, spaceId: string) {
  const sp = alias(spacePositions, 'fx_ref_sp');
  const lm = alias(listingMetrics, 'fx_ref_lm');
  const newestPriceDate = (heldOnly: boolean) =>
    db
      .select({ d: sql<string | null>`max(${lm.asOfDate})`.as('d') })
      .from(sp)
      .innerJoin(lm, sql`${lm.listingId} = ${sp.listingId}`)
      .where(
        heldOnly
          ? sql`${sp.spaceId} = ${spaceId} and ${sp.quantity} is not null`
          : sql`${sp.spaceId} = ${spaceId}`,
      );
  const ref = sql`coalesce(${newestPriceDate(true)}, ${newestPriceDate(false)})`;
  const days = sql.raw(String(FX_TOLERANCE_DAYS));
  return db
    .selectDistinctOn([fxDaily.currency], {
      currency: fxDaily.currency,
      ratePerEur: fxDaily.ratePerEur,
      rateDate: fxDaily.rateDate,
    })
    .from(fxDaily)
    .where(sql`${fxDaily.rateDate} <= ${ref} and ${fxDaily.rateDate} >= ${ref} - ${days}`)
    .orderBy(fxDaily.currency, desc(fxDaily.rateDate))
    .as('fx_current');
}

export type CurrentFxRates = ReturnType<typeof currentFxRates>;

/** Units of the price currency per 1 EUR: exactly 1 for EUR (no rate needed), the window's rate, or NULL. */
export function eurRate(fx: CurrentFxRates): SQL {
  return sql`case when ${priceMajorCurrency} = 'EUR' then 1::numeric else ${fx.ratePerEur} end`;
}

/** Price in EUR; NULL without a valid (> 0) price, a valid currency, or a rate. Never 0 for "unknown". */
export function priceEurSql(rate: SQL): SQL {
  return sql`case when ${m.price} > 0 and ${rate} > 0 then ${m.price} / ${priceDivisor} / ${rate} end`;
}
