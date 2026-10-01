# S5 review (2026-09-30)

Independent code review and security audit of commit 0f1be82 (S5 dashboard backend: summary, history, movers). This file records each finding's status after the S5 backend fix pass. As for S3/S4, the original review texts are not reproduced: the findings below are the ones handed to the fix pass (subject-based numbering, `F<n>` as in the brief). Decision recorded with this pass: **D23** (the value card delta describes the same value as the total), `MVP-PLAN.md` section 7. The fix pass is uncommitted; the frontend (separate pass) already consumes the renamed fields.

## Code review

| Ref | Sev | Finding | Status |
| --- | --- | --- | --- |
| Review F1 | P1 | The card showed `total` (end price, possibly a same-day quote, D21) next to a delta computed from closes only: the delta described another value and could end on an older date while labelled current | **Fixed (D23).** The series ends with a terminal point at `asOf` valued by `computeSpaceValue` from the end prices and the current-rule FX (same inputs as the total); chart end = `change.endValue` = `total` whenever `isComplete`. The wire `change` is `end - start` of the rounded endpoints, so `total - change = start` exactly. Partial total: `change` is `null` (never a delta for another set). A series that ends early keeps its real `toDate`. Tests: same-day quote above the close (domain, compute, int), position with closes but no metrics row, FX 7/8/10 days old, suspended listing (trimmed tail, with and without a complete terminal), exact `total - change = start` with a long FX division. |
| Review F2 | P2 | History FX forward-fill used the 10-day close tolerance while D22 and the summary say 7 | **Fixed.** `ValueSeriesInput.fxToleranceDays` (defaults to `toleranceDays`), `computeHistory` passes `FX_TOLERANCE_DAYS` (7). Boundary tests at 7/8 days (domain and compute); docs and the contract comment updated. Side effect, intended: a period start more than 7 days after the last rate is now a null day (honest), fixtures adjusted (1w start needs a rate within 7 days). |
| Review F3 | P2 | Contract clarity: two different `asOf`, per-point rates repeated in `current` mode, no staleness on history or current rates | **Fixed.** `summary.freshness.asOf` -> `oldestPriceDate`, `history.asOf` -> `seriesEnd`; `history.isStale`; `currentFxRates[].isStale`; in `current` mode the points carry no `fxRates` (empty arrays, read `currentFxRates` with `rateDate`). Additive, requested later: `quotedCurrencies` on every applied rate (pence note only when a GBX position is involved). |
| Review F4 | P3 | `historyFx` pushed with a spread copy per point (quadratic) and parsed every rate per date | **Fixed.** Push in place; each rate parsed once (per row in `current` mode). |
| Review F5 | P3 | Second Decimal wrap per use, day numbers re-parsed in every lookup, `summary` had its own headline path | **Fixed.** `asDecimal` returns an instance already built by the domain clone; `latest` compares precomputed day numbers (`dayNumber`, memoized; `assertPlainDate` shares the memo); `cleanSeries` sorts only unordered input. `summary` calls `computeHistory`, the same function as `history` (no second algorithm), and reads the FX rows once. Measured on 25 years x 50 positions, `max`: compute about 350 ms -> about 200 ms; end to end about 606 -> about 480 ms (BACKEND.md, Performance). |
| Review F6 | P3 | Stale boundaries untested; mislabelled "Friday/weekend" test | **Fixed.** Price stale at exactly 6 days, not at 5 (Wednesday 09-30: Friday 09-25 fresh, Thursday 09-24 stale); FX rate stale at 8 days, not at 7. The test that called Saturday 09-26 a Friday was replaced by the boundary tests. |
| Review F7 | P3 | No `current` FX mode test with GBX, nor with a current rate dated before `to` | **Fixed.** `compute-d23.test.ts`: GBX position in `current` mode with a rate dated 5 days before `to` (real `rateDate`, `isStale`, GBP rate, no per-point rates), plus a stale-rate variant (`isStale` on the rate and on the history). |
| Review F8 | P3 | Rendering rules in BACKEND.md did not say how to label a delta older than as-of, which value the card uses, nor that the current-mode headline differs | **Fixed.** "What the frontend should call": show "au <toDate>" when `change.toDate` < as-of; the card always uses `summary.change` (historical FX); the chart headline in `current` mode intentionally differs; `null` change next to a partial total; 429 handling. |
| Review note (two-phase) | P3 | The downsampling-equivalence test did not cover gaps, trims or an FX-only hole | **Fixed.** Variant with a late-starting position (leading trim), 12+ day holes (mid gaps), a stopped position (trailing trim) and a USD rate hole with all closes present; kept points, `evolutionPct`, `dataDate`, `missing` and the headline equal the full series. |

## Security audit

| Ref | Sev | Finding | Status |
| --- | --- | --- | --- |
| Security F1 | P2 | Authenticated DoS: repeated `max` calls (about 0.5 s CPU each, a pool connection held during compute) | **Fixed (limits, not a cache).** (a) Per-user admission for `summary` and `history`: 2 in flight and a 30/min token bucket, typed `TOO_MANY_REQUESTS` with `retryAfterSeconds` and `Retry-After`, declared in the contract, after the access check; refusals cost nothing. (b) Reads run in the read-only REPEATABLE READ transaction, compute runs after it committed. (c) App role `statement_timeout = 10s` and `idle_in_transaction_session_timeout = 30s` via `ALTER ROLE ... SET` in `db:setup-roles`. Tests: the cap and the bucket trip with a typed 429, other users and `movers` unaffected, a non-member still gets `NOT_FOUND`, the slot is released after the call; `show statement_timeout` as the app role. No cross-request memo (see remaining risks). |
| Security F2 | P3 | IDOR matrix asserted only the status of an ok answer | **Fixed.** Every `positionId` of an ok dashboard answer belongs to the target space; space B holds a distinct instrument with metrics (MSFT) and neither its ids nor its name appear in space A's summary/history/movers (and A's not in B's), totals per space asserted (1240 vs 1400); garbage `period: 'bogus'`: non-member and member of another space `NOT_FOUND`, viewer `BAD_REQUEST`. |
| Security F3 | P3 | `getMovers` read outside the read-only transaction the doc describes | **Fixed.** `getMovers` uses the same read-only REPEATABLE READ transaction style (one statement, same snapshot discipline); BACKEND.md says so. |

## Re-review, frontend review and frontend audit

### Backend re-review

| Ref | Sev | Finding | Status |
| --- | --- | --- | --- |
| F1-F8 | P2/P3 | Findings of the first review and audit | **Fixed** (re-review confirms). |
| P3-A | P3 | `history.isStale` derived from `seriesEnd` (the NEWEST end price), inconsistent with `summary.freshness.isStale` | **Fixed.** Derived from the oldest held end-price date; test with one fresh and one old position (and a watchlist entry ignored). |
| P3-B | P3 | Per-point `fxRates` payload in historical mode grows linearly with the number of currencies held (bounded by 400 points; about 45 KB per currency) | **Accepted** for the MVP; revisit (per-response rate table referenced by date) if spaces commonly hold 8+ currencies. |

### Security re-audit (approve)

| Ref | Sev | Finding | Status |
| --- | --- | --- | --- |
| Limiter instance | P3 | The HTTP RPC router and `createServerClient` built separate `DashboardLimiter` instances (cap doubled across the two paths) | **Fixed.** One shared instance per process (module level, parked on `globalThis` against split Next bundles). |
| Honest-user cap | P3 | The per-user in-flight cap of 2 refused a normal user (a period change fires summary + history) | **Fixed.** In-flight cap per (user, procedure); token bucket per user kept (30/min); limiter tests updated. |

### Frontend review

| Ref | Sev | Finding | Status |
| --- | --- | --- | --- |
| FE-P2-1 | P2 | False 429 during normal use: summary + history filled the per-user cap, aborted requests kept computing server-side, the client never retried a 429 | **Fixed.** Cap per procedure; dashboard queries retry `TOO_MANY_REQUESTS` twice after `retryAfterSeconds` (0.5-3 s); previous data kept while loading (same space only). Unit tests (retry policy, limiter) and E2E (quick period/FX changes on `max`, single and persistent forced 429). |
| FE-P3-1 | P3 | Monotone curve with area fill suggested an intraday path and a zero baseline | **Fixed.** Linear line, no fill, `connectNulls={false}`; rationale in FRONTEND.md. |
| FE-P3-2 | P3 | Sign/colour/arrow from the unrounded value (a green "0 EUR") | **Fixed.** Derived from the displayed text; zero is neutral. Tests: +0.4 EUR, -0.4 EUR, 0.04 %, 0. |
| FE-P3-3 | P3 | `delta-end.ts` dead under D23; freshness wording | **Fixed.** File removed; `freshness.newestPriceDate` added (additive, tested); "Cours du X au Y" / "Cours au X"; docs corrected. |
| FE-P3-4 | P3 | FX tooltip rate with 4 fixed decimals (JPY/KRW unreadable) | **Fixed.** 5 significant digits; tests for USD, JPY, KRW. |
| FE-P3-5 | P3 | D20 notice listed every name and said "création" | **Fixed.** Long form for more than 3 names or `max`, names in a disclosure; wording "début de l'historique disponible". Tests. |
| FE-P3-6 | P3 | E2E gaps | **Fixed.** Error state (forced 500), stale badge, on-screen D23 invariant, GBP-only tooltip without pence note (the last two altered answers with `page.route`; the fake data is shared). |

### Frontend audit (approve)

No findings.

## Deferred / remaining risks

- **Row-level security (RLS) is deferred.** Isolation rests on the branded `AuthorizedSpace` (access resolved before validation) and on repositories reaching listings only through `space_positions`; there is no database-enforced backstop yet. To revisit with the deployment work (role split, see REVIEW-S4 audit P3-7).
- **Any future response memo must be keyed by the authorized space id** (never by user-supplied input alone, never shared across spaces) and invalidated when the worker refreshes prices, FX or metrics, or when positions change. None exists today: per-user limits and timeouts bound the cost instead.
- **The limiter is in memory, single instance (D13):** per-process budgets, reset on restart; behind several web instances the effective cap multiplies. Acceptable for the current single-instance deployment.
- **`summary` recomputes the series** (it needs the headline): a page calling both procedures pays it twice within its 30/min budget.

## Verification of this pass

See the final report of the fix pass (commands and outputs are not duplicated here): lint, format:check, typecheck, `pnpm test`, `db:check`, `db:generate` (no change), `pnpm test:integration`, `db:setup-roles` on the dev database and `show statement_timeout` as the app role, a real PEA `summary` 1m.
