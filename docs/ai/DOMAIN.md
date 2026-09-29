# Waddlers — domain module conventions (`packages/domain`, S4)

Pure TypeScript, no I/O, no React, no provider code. Money math uses **decimal.js** (isolated clone, 40 significant digits, ROUND_HALF_EVEN). Chosen over big.js because decimal.js works in significant digits (big.js divides at a fixed number of decimal places, which is wrong for both 0.0001-scale prices and large totals) and supports an isolated `clone` config; it is dependency-free. No float arithmetic on money anywhere.

## Decimals and money

- Wire/DB: decimal strings. `parseDecimal(str)` returns `null` for null, blank, `NaN`, exponent, thousands separators — never 0. `decimalToString` never emits exponent notation.
- `Money = { amount: Decimal | null, currency }`; `moneyFromStrings` / `moneyToStrings` convert at the boundary.

## Currencies and minor units

- `normalizeCurrency(code)` → `{ currency (major), divisor }` or `null`.
- Known minor units (exact case): `GBX`, `GBp` → GBP/100; `ZAc` → ZAR/100.
- `ZAC` and `ILA` are rejected (`null`) rather than guessed: reading them as a major currency would be a 100x error. Add explicitly with a test if the provider emits them.
- Any code not matching `^[A-Z]{3}$` is invalid.

## FX direction (D2, ECB)

- Rates are EUR-based: `rates.get('USD') = 1.25` means `1 EUR = 1.25 USD`. EUR is implicit and not listed. Rates are for major currencies only.
- `amount_EUR = amount / rate[from]`; `result = amount_EUR × rate[to]`. Cross rates go through EUR.
- Same currency after normalization is an exact identity (no rate needed); EUR→EUR too.
- Missing, zero, negative or non-finite rate → failure (`convertAmount`) / `null` (`convert`). Never 1.

## Dates and periods (§11, §31)

- Dates are exchange-local calendar `YYYY-MM-DD` strings (`PlainDate`), validated; arithmetic on integer day numbers, never UTC-derived from instants and independent of process TZ.
- Periods: `1w`, `1m`, `6m`, `1y`, `5y`, `max` (specs: 1 semaine, 1 mois, 6 mois, 12 mois, 60 mois, Max).
- Target base date from as-of: `1w` = −7 days; months are calendar months computed directly from as-of with end-of-month clamping (2026-03-31 − 1m = 2026-02-28; 2024-02-29 − 12m = 2023-02-28). `max` has no target.

## Base price and performance (§31, D3, D4, D14)

- Performance % = `(end / base − 1) × 100` (Decimal), in the listing's local currency (D4).
- **Callers must pass split-adjusted closes (D3).** The module cannot detect raw vs adjusted.
- Base = close on the nearest trading day on or before the target. Gap tolerance default 10 calendar days, inclusive, configurable (`toleranceDays`). Never looks forward.
- `max` requires `historyCompleteFrom`; base = first datapoint on/after it (and before as-of).
- Result: `{ value, baseDate }` or `{ value: null, baseDate|null, reason }`. Reasons: `empty_series`, `history_starts_after_target`, `gap_exceeds_tolerance`, `non_positive_base`, `end_missing`, `end_invalid` (end ≤ 0), `history_completeness_unknown`, `insufficient_history` (max with a single point at as-of). UI renders `—`.
- Series hygiene: null closes are ignored, input order irrelevant, duplicate dates: last occurrence wins.

## Space value (§12, §32, D5, D9)

- Σ quantity × price × fx(local → reference). Reference is EUR (D7).
- `quantity === null` (watchlist): excluded, not "missing". `quantity 0` is a real 0. Negative quantity, price ≤ 0 or invalid currency → row null with reason.
- Missing price/FX → row `null`; `total` is partial with `isComplete: false` and `missing: [{ positionId, reason }]`. Reasons: `quantity_invalid`, `price_missing`, `price_invalid`, `currency_invalid`, `fx_missing`.
- `total` is `null` (not 0) when no position could be valued.

## History series (§13, D6)

- Current quantities × historical close × same-day FX; label in UI as "valeur des positions actuelles", not a return history.
- Timeline = dates in range with at least one real close among counted positions. Closes and FX forward-fill within tolerance (never forward-looking).
- A day where any counted position lacks close/FX has `value: null` and lists `missing` ids (no partial sums).
- Headline = first vs last complete point of the full series (`fromDate`/`toDate` exposed, may be later than the period start); `changePct` null when start ≤ 0. Downsampling (≤ 400, deterministic, first/last kept) happens after; per-point `evolutionPct` is relative to the headline start.

## Movers (§14)

Gainers: perf > 0 desc; losers: perf < 0 asc (worst first); 5 each; null and exactly 0 excluded; ties by lowercase name, exact name, then id.

## Spec ambiguities and conservative choices

See the S4 domain handoff: "1 semaine" = 7 days; "Max" base definition; end price ≤ 0 invalid; partial history days null rather than partial; empty total null; no more currency aliases guessed.
