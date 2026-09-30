# S4 review (2026-09-30)

Independent code review and security audit of commit 129b687 (S4 market data: providers, schema 0004, service, worker). This file records each finding's status after the S4 fix pass. As for S3, the original review texts are not reproduced: the findings below are the ones handed to the fix pass. The `P3 n` numbers follow the order of the fix brief (subject-based, not necessarily the reviewer's own numbering). No commit yet.

Decision recorded with this pass: **D21** (end price: the official close for a date wins over a same-day quote; the quote is used only until that close exists), see `MARKET-DATA.md` and `MVP-PLAN.md` section 7.

## Code review

| Ref | Sev | Finding | Status |
| --- | --- | --- | --- |
| Review P2-1 | P2 | `upsertQuotes` could regress a quote (late/out-of-order provider answer overwrote a newer one) | **Fixed.** `price`, `currency`, `source` and `as_of` only move forward in provider time (CASE / `greatest` on `excluded.as_of >= as_of`); `fetched_at` still records the fetch, so freshness stays honest. Test: stored quote at T, provider answers T-1h, price and `as_of` unchanged, `fetched_at` moved; a newer answer still updates. |
| Review P2-2 | P2 | The nightly history pull skipped listings refreshed less than 12 h earlier | **Fixed.** `runNightly` uses `NIGHTLY_MAX_AGE_MS` (1 h) for history and FX; backoff and quota still apply. Test: a refresh 5 h earlier does not make the nightly skip (2 provider history calls, FX refreshed). |
| Review P2-3 | P2 | One failing listing aborted `recomputeListingMetrics`, and the session purge depended on the metrics step | **Fixed.** Per-listing try/catch (logged with `describeError`, counted as `failed`), batched upsert with row-by-row fallback; in `runNightly` metrics and purge each have their own try; the result carries `metricsFailed`. Tests: invalid exchange timezone fails one listing, the others are stored (unit-level and through `runNightly`, purge still runs). |
| Review P2-4 | P2 | Values that round or overflow at the column scale broke a whole batch (or were silently rounded) | **Fixed.** `normalize.ts`: prices max 16 integer digits and 8 decimals, FX 10 and 10, always > 0, exponent forms bounded from their exponent before expansion, literal length capped. Row-level drop into `rejectedRows`; the service repeats the check on quotes, bars and FX as defence in depth. Tests: `1e-9`, `5e-9`, `1e17`, FX `1e11`, `6e-11`, `1e999999999`, one bad row in a history batch stores the good ones. Behaviour note: a value needing more decimals than the column is dropped, not rounded (adapters must format numbers). |
| Review P2-5 | P2 | Quote/close tie went to the quote | **Fixed by D21.** Close wins for a date on or after the quote's local date; the quote is used only until that close exists. `selectEndPrice` tests: quote-only day, same-date close wins, newer quote date wins, exchange-local dates; integration test walks quote, close arrives, newer quote. |
| Review P2-6 | P2 | `recomputeListingMetrics` read every listing's full series one by one | **Fixed.** `metrics-reads.ts`: batched `inArray` reads bounded to `asOf - 60 months - 10 days`, plus the anchor close below the window and the first close on/after `history_complete_from`; one batched upsert; `runQuoteBatch` batches `recordSuccesses` / `recordFailures`. Test: a 10-year series, a stale series and a gap at the 5y target give rows identical to the unbounded computation (`computeMetricsValues` over `readBars`). |
| Review P3 1 | P3 | FX tolerance (7 days) vs close tolerance (10 days) unexplained | **Fixed.** Rationale documented in `config.ts` and `MARKET-DATA.md` (ECB TARGET calendar: longest gap about 4 days). |
| Review P3 2 | P3 | History/FX `asOf` is a UTC-midnight instant for a plain date (timezone shift risk) | **Fixed.** `Served` exposes `asOfDate: PlainDate` (history: last bar, FX: latest rate; null for quotes); `asOf` documented. Tests. |
| Review P3 3 | P3 | Local quota refusal and upstream `quota_exceeded` indistinguishable | **Fixed.** New code `local_quota` (guard only, no backoff); upstream `quota_exceeded` backs off. Tests (service, guard). |
| Review P3 4 | P3 | XFRA hours | **Fixed.** 08:00-22:00; the other table entries re-checked (unchanged); test. |
| Review P3 5 | P3 | Dead `'rounds_to_zero'` branch in the perf loop | **Fixed.** Removed (a non-null domain value always stores as a string); the live price_eur `rounds_to_zero` reason stays. |
| Review P3 6 | P3 | Worker test name claimed no overlap without asserting it | **Fixed.** Renamed, plus a new test that fires the nightly timer while the nightly runs (skipped warning, peak concurrency 1). |
| Review P3 7 | P3 | Duplicate-row rule differed from DOMAIN.md | **Fixed.** Bars and ECB rates: last occurrence wins, an unusable last one drops the date; superseded rows count as rejected. Tests. |
| Review P3 8 | P3 | No concurrent reserve test at the budget boundary | **Fixed.** 10 parallel reservations, budget 3, exactly 3 succeed; zero budget counts nothing. |
| Review P3 9 | P3 | No test for a partially overlapping in-flight quote batch | **Fixed.** Second caller joins the shared listing and fetches only its own new one. |
| Review P3 10 | P3 | FX backfill coverage transitions and the 1999-01-04 clamp untested | **Fixed.** Backfill, incremental, older need, newer need (skipped), clamp then covered. |
| Review P3 11 | P3 | Market hours during the US/EU DST mismatch weeks untested | **Fixed.** Spring (2026-03-16) and autumn (2026-10-26) mismatch weeks, the week after, and the 5 h overlap. |
| Review P3 docs | P3 | `MARKET-DATA.md` inaccuracies | **Fixed.** Nightly behaviour; "NULLs sort last" is a query requirement; partial indexes to be validated with `EXPLAIN` in S6; single-flight is per process (web + worker may double-fetch, quota stays correct); adapters must honour `AbortSignal`. |

## Security audit

| Ref | Sev | Finding | Status |
| --- | --- | --- | --- |
| Audit P2-1 | P2 | A deterministic persist error after a good provider call was retried (and re-paid) every tick | **Fixed.** The catch blocks after a successful provider call record `bad_payload` through `recordFailures` (best-effort, never throws). Tests: forced persist error (invalid `source`) on quotes, history and FX records the backoff and the next call is `skipped_backoff` with no provider call. |
| Audit P2-2 | P2 | History currency never checked (quotes were) | **Fixed.** `HistoryBatch.currency` (set by the fake provider; the ECB adapter is FX only and has no history batch); `runHistory` rejects a differing batch with `bad_payload`; `GBX` = `GBp`, `GBP` vs `GBX` rejected (`sameQuotedCurrency`, domain `normalizeCurrency`). Tests. |
| Audit P3-1 | P3 | ECB parser: backtracking day-block regex, 32 MB cap, whole body buffered | **Fixed.** Linear scan (`indexOf` for the closer, bounded quantifiers, stop when no closer is left), 8 MB cap, body read as a stream with a running byte counter and cancelled past the cap even without content-length. Tests: 32k unterminated openers under 200 ms, chunked oversize body rejected and reading stops early. |
| Audit P3-2 | P3 | `redact.ts` missed encoded secrets, `%3D`, `Basic` credentials | **Fixed.** Percent-encoded and base64/base64url forms of every configured secret, `%3D` / `%3d` after param names, `Basic` rule. Probe tests. |
| Audit P3-3 | P3 | Web env accepted/validated the worker-only `EODHD_API_TOKEN` | **Fixed.** Only `workerEnvSchema` has it; the web schema strips it (never validated, never in the parsed env). Tests. |
| Audit P3-4 | P3 | Worker container hardening | **Fixed.** `read_only: true` + tmpfs `/tmp`, `cap_drop: [ALL]`, `no-new-privileges`. `docker compose --profile app config` validated; worker image built and started with the same flags (jobs ran, exit code 0). |
| Audit P3-5 | P3 | Session purge used the application clock and returned ids | **Fixed.** `expires_at < now()` (database clock), returns the row count only. Tests adapted (expiries relative to real time). |
| Audit P3-6 | P3 | Quote requests are not chunked for large held sets | **Deferred** to the EODHD adapter (its batch endpoint limits decide the chunk size). |
| Audit P3-7 | P3 | Worker uses the same DML-only role as web | **Deferred**: a split worker role (separate credentials, no access to `users`/`sessions` except the purge) with the deployment work. |

## Deferred / accepted

- **EODHD adapter security review:** mandatory when the adapter is written (credential handling, URL construction, response validation, `AbortSignal`, mapping of `close` vs `adjusted_close`, D3).
- **Quote chunking** and **split worker DB role:** see above.
- **Partial indexes on `listing_metrics`:** validate with `EXPLAIN` on realistic data in S6.
- **Float noise from providers:** a price such as `183.45000000000002` is rejected (more than 8 decimals) instead of rounded; the adapter must format numbers before returning them.

## Targeted re-review and re-audit (0281411) — verdict: approve

All review P2s and audit findings confirmed fixed or deferred with a reason; no regressions. D21 implementation confirmed (`selectEndPrice`: the quote wins only when its date is after the latest close). Bounded metrics window confirmed equivalent to the unbounded computation. Dropping values that do not fit the column scale accepted; the EODHD adapter must round explicitly (see `MARKET-DATA.md`, "EODHD adapter checklist").

| Ref | Sev | Finding | Status |
| --- | --- | --- | --- |
| Re-review R1 | P3 | `DISTINCT ON` latest/first-close reads still scan each listing's matching rows in Postgres; `minStart` shared per 500-listing chunk | Open. Use `LEFT JOIN LATERAL … LIMIT 1` on the `(listing_id, trade_date)` PK; confirm with `EXPLAIN (ANALYZE, BUFFERS)` (before S6 scale work). |
| Re-review R2 | P3 | D21 relies on adapters not returning the current session's bar before its close | Documented in the EODHD adapter checklist; optional service-side guard later. |
| Re-review R3 | P3 | Metrics window uses `DEFAULT_TOLERANCE_DAYS` while `computePerformance` uses its default implicitly | Open. Pass the same constant explicitly to `computePerformance`. |
| Re-review R4 | P3 | Quote rejected by the service scale check recorded as `not_found`; stored quotes can get `bad_payload` if `recordSuccesses` throws | Open (diagnostics only, no financial effect). |
| Re-review R5 | P3 | Markdown typo in `MARKET-DATA.md` | **Fixed.** |
| Re-review P3-3 | P3 | `listing_metrics` has no staleness flag | Open for S6: derive staleness from `as_of_date` / `computed_at`, or add a column. |
| Re-audit P3 | P3 | Pattern-only redaction misses JSON-style `"api_token":"…"` when the secret is not configured | Open; covered today because the token is always passed as a secret. Handle at the EODHD adapter security review. |
