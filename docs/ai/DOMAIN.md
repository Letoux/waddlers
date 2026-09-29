# Waddlers — domain module conventions (`packages/domain`, S4)

Pure TypeScript, no I/O, no React, no provider code. Money math uses **decimal.js** (isolated clone, 40 significant digits, ROUND_HALF_EVEN). Chosen over big.js because decimal.js works in significant digits (big.js divides at a fixed number of decimal places, which is wrong for both 0.0001-scale prices and large totals) and supports an isolated `clone` config; it is dependency-free. No float arithmetic on money anywhere.

Every public entry point re-wraps incoming Decimals with `asDecimal` so a foreign decimal.js clone (other precision/rounding) cannot leak its settings into our arithmetic.

## Decisions

- **D20 (2026-09-29, user)**: "on ne ment pas sur la donnée. Si un titre est récent, on affiche pas de donnée avant la création du titre." Consequences: a history day where any counted position has no close or FX is `null`, never a partial sum; the leading and trailing null points of the history series are trimmed, so the series starts at the first complete point and ends on the last one; the headline `fromDate` is exposed so the UI can show "valeur des positions actuelles depuis le …". Nulls in the middle remain as gaps.

## Decimals and money

- Wire/DB: decimal strings. `parseDecimal(str)` returns `null` for null, blank, `NaN`, exponent, thousands separators — never 0. `decimalToString` never emits exponent notation.
- `Money = { amount: Decimal | null, currency }`; `moneyFromStrings` / `moneyToStrings` convert at the boundary.
- Tolerances (`toleranceDays`) must be non-negative integers, otherwise `RangeError`. Movers `limit` must be a non-negative integer. Reference currencies must be valid major currencies (not `GBX`), otherwise `RangeError`.

## Currencies and minor units

- `normalizeCurrency(code)` → `{ currency (major), divisor }` or `null`.
- Known minor units (exact case): `GBX`, `GBp` → GBP/100; `ZAc` → ZAR/100.
- `ZAC` and `ILA` are rejected (`null`) rather than guessed: reading them as a major currency would be a 100x error. **They must be confirmed against what EODHD really returns before the real adapter lands**, then added explicitly with a test if needed.
- Any code not matching `^[A-Z]{3}$` is invalid.

## FX direction (D2, ECB)

- Rates are EUR-based: `rates.get('USD') = 1.25` means `1 EUR = 1.25 USD`. EUR is implicit and not listed. Rates are for major currencies only.
- `amount_EUR = amount / rate[from]`; `result = amount_EUR × rate[to]`. Cross rates go through EUR.
- Same currency after normalization is an exact identity (no rate needed); EUR→EUR too.
- Missing, zero, negative or non-finite rate → failure (`convertAmount`) / `null` (`convert`). Never 1.
- Display (specs §34, "USD/EUR : 0,85"): `eurPerUnit('USD', rates)` = 1 / rate = EUR per 1 unit of CCY (minor-unit aware). Display only; converting must use `convert`.

## Dates and periods (§11, §31)

- Dates are exchange-local calendar `YYYY-MM-DD` strings (`PlainDate`), validated; arithmetic on integer day numbers, never UTC-derived from instants and independent of process TZ.
- Periods: `1w`, `1m`, `6m`, `1y`, `5y`, `max` (specs: 1 semaine, 1 mois, 6 mois, 12 mois, 60 mois, Max).
- Target base date from as-of: `1w` = −7 days; months are calendar months computed directly from as-of with end-of-month clamping (2026-03-31 − 1m = 2026-02-28; 2024-02-29 − 12m = 2023-02-28; 2024-02-29 − 60m = 2019-02-28). `max` has no target.

## Base price and performance (§31, D3, D4, D14)

- Performance % = `(end / base − 1) × 100` (Decimal), in the listing's local currency (D4).
- **Callers must pass split-adjusted closes (D3).** The module cannot detect raw vs adjusted.
- **Known risk (currency pairing)**: `PerformanceInput` carries no currency. The series and `end` must be in the same local currency; that pairing is the caller's responsibility. A later slice decides whether to add a currency to the input.
- Base = close on the nearest trading day on or before the target. Gap tolerance default 10 calendar days, inclusive, configurable. Never looks forward.
- `historyCompleteFrom` must be the date of the **first stored close** (the listing's first trade date), NOT the start date of the backfill request: a request starting before the listing existed would make `max` look valid while the real first trade is unknown, and one starting after it would silently truncate `max`.
- `max` requires `historyCompleteFrom`; base = first datapoint on/after it (and not after as-of). If that first point is more than the tolerance after `historyCompleteFrom` the result is `history_gap_at_start`; if `historyCompleteFrom` is after as-of it is `history_starts_after_target`.
- Result: `{ value, baseDate }` or `{ value: null, baseDate|null, reason }`. Reasons: `empty_series`, `history_starts_after_target`, `gap_exceeds_tolerance`, `end_missing`, `end_invalid` (end ≤ 0), `history_completeness_unknown`, `history_gap_at_start`, `insufficient_history` (max with a single point at as-of). UI renders `—`.
- Closes that are null, non-finite or <= 0 are unusable and skipped everywhere (`cleanSeries`): base lookup, `max` and history all fall back to the previous valid close within tolerance, so a 0 close on the target date gives the same base in `computePerformance` and in the history headline. Hence there is no `non_positive_base` reason; `end_invalid` remains because `end` is a direct input.
- Series hygiene: unusable closes are ignored, input order irrelevant, duplicate dates: last occurrence wins (same rule for closes and FX; an invalid last value drops the date).

## Space value (§12, §32, D5, D9)

- Σ quantity × price × fx(local → reference). Reference is EUR (D7).
- `quantity === null` (watchlist): excluded, not "missing". `quantity 0` is a real 0. Negative/NaN/Infinity quantity, price ≤ 0 or non-finite, invalid currency → row null with reason.
- Missing price/FX → row `null`; `total` is partial with `isComplete: false` and `missing: [{ positionId, reason }]`. Reasons: `quantity_invalid`, `price_missing`, `price_invalid`, `currency_invalid`, `fx_missing`.
- `total` is `null` (not 0) when no position could be valued.

## History series (§13, D6, D20)

- Current quantities × historical close × same-day FX; label in UI as "valeur des positions actuelles depuis le <headline.fromDate>", not a return history.
- Timeline = `from` (the period target, valued by carrying closes forward exactly as the base price of `computePerformance` does: close on or before the target within tolerance, never looking forward) plus every later date ≤ `to` with a real close among counted positions. Points after `to` are ignored; `from > to` throws `RangeError`.
- Closes and FX forward-fill within tolerance (never forward-looking). A close ≤ 0 is missing (same `cleanSeries` rule as performance): it can be carried over from an earlier valid close, otherwise the position is missing that day; it never becomes a 0 value.
- A day where any counted position lacks close/FX has `value: null` and lists `missing` ids. A counted position with an invalid quantity (negative/NaN/Infinity) makes every day null (reported in `invalidPositions`), so the series is empty. **The API and UI must surface `invalidPositions`**, otherwise an empty chart is unexplained.
- Leading/trailing null points are trimmed (D20); the headline is first vs last point of the trimmed series, `changePct` null when start ≤ 0, headline null with fewer than two points. Downsampling (≤ 400, deterministic: indices `floor(i·(n−1)/(max−1))`, first/last kept) happens after trimming, so chart endpoints equal the headline endpoints. Each point has `dataDate` (the most recent actual close date used that day, null for null days) and the headline has `baseDate` (= the first point's `dataDate`), so the UI can label "depuis le 5 juin" with a real trading day rather than a weekend target `fromDate`; for one position `baseDate` equals `computePerformance`'s `baseDate`. `leadingMissing` lists the positions with no data at the period start whenever leading points were trimmed (also when the series ends up empty or with a single point), for "pas de donnée avant la création de X". Per-point `evolutionPct` is relative to the headline start and null when there is no headline.

## Movers (§14)

Gainers: perf > 0 desc; losers: perf < 0 asc (worst first); 5 each (limit configurable, 0 allowed); null, NaN/Infinity and exactly 0 excluded; ties by lowercase name, exact name, then id.

## Spec ambiguities and conservative choices

- **"1 semaine"** is not defined in specs §11/§31: taken as exactly 7 calendar days back from as-of.
- **"Max" base**: D14 says "since first datapoint with complete history". Interpreted as the first datapoint on/after `historyCompleteFrom` within tolerance; without a known completeness boundary the value is unavailable rather than assuming the stored history is complete.
- **End/current price ≤ 0** (and price ≤ 0 in valuation) is treated as invalid: a zero close from a provider is indistinguishable from a data artifact, and showing −100 % or a 0 valuation would be fabricated.
- **Empty total**: an empty sum is not shown as 0; `total` is null when no position could be valued.
- **Partial history days (D5 vs D6)**: D5 accepts partial totals for the *current* value, but for the *historical chart* a partial sum would look like a real drop; D20 resolves it: null day, no data before a recent listing exists.
- **Minor units**: only `GBX`, `GBp`, `ZAc` are known; other spellings are rejected instead of guessed (see Currencies).
