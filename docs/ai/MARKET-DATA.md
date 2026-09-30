# Market data (S4)

Source of truth: `specs.md` sections 25-32, `docs/ai/MVP-PLAN.md` "Market-data provider & cache", `CLAUDE.md` sections 5 and 7. Code: `packages/server/src/market-data/`.

## Layering

```
TanStack Query (browser cache)  ->  oRPC procedure  ->  MarketDataService  ->  PostgreSQL  ->  provider (only on miss/expiry)
```

CLAUDE.md section 7: **a client refetch reads PostgreSQL and never calls a provider.** A refetch (window focus, invalidation, polling by TanStack Query) reaches an oRPC procedure, which reads `quote_latest` / `price_daily` / `fx_daily` / `listing_metrics`. Only `MarketDataService`, when a stored value is missing or past its TTL, calls a provider, and it does so at most once per key at a time. The frontend never calls a provider. `MarketDataService` is the only caller of providers; adapters are never imported elsewhere.

## Provider interface (`types.ts`)

`MarketDataProvider`: `getQuotes(listings[])`, `getDailyHistory(listing, from, to)`, optional `search(query)`. Separate `FxProvider.getDailyRates(from, to)`. Every method returns `ProviderResult<T>`:

- `{ ok: true, data, source, asOf }`: `source` names the provider, `asOf` is when the provider says the data is valid (not when we fetched it).
- `{ ok: false, code, message, source }` with `code` in `timeout | network | rate_limited | upstream_error | quota_exceeded | unauthorized | not_found | bad_payload | unsupported | not_configured`.

A provider result never throws and never carries 0/NaN/negative for a missing value: adapters normalize field by field (`normalize.ts`, `bars.ts`), drop an invalid row and count it in `rejectedRows`. Prices are decimal strings in the listing's raw currency (`GBX` = pence). Trade dates are exchange-local `YYYY-MM-DD`.

Implementations: `FakeMarketDataProvider` (deterministic, dev/E2E, failure injection), `FakeFxProvider`, `EcbFxProvider` (public ECB XML, no key, `1 EUR = rate CCY`), `EodhdStubProvider` (**intentionally a stub**: throws `NotConfiguredError`, surfaced as `not_configured`, decision D1: check plan/coverage with the user first).

### Call guard (`guard.ts`)

Every provider call goes through `CallGuard`: concurrency semaphore (`MARKET_DATA_CONCURRENCY`), per-attempt timeout with abort (`MARKET_DATA_TIMEOUT_MS`), up to 3 attempts with full-jitter exponential delay **for transient codes only** (`timeout`, `network`, `rate_limited`, `upstream_error`), the persisted daily quota, and secret redaction (`redact.ts`: `api_token=`/`apikey=`/bearer patterns plus the configured token value, applied to messages and logs; stored error state keeps only a code).

## TTLs (env, Zod-validated)

| Data | Table | TTL | Env |
| --- | --- | --- | --- |
| Quote | `quote_latest` | 15 min | `MARKET_DATA_QUOTE_TTL_MINUTES` |
| Daily history | `price_daily` | 12 h | `MARKET_DATA_HISTORY_TTL_HOURS` |
| FX rates | `fx_daily` | 12 h | `MARKET_DATA_FX_TTL_HOURS` |
| Fundamentals, descriptions | not in S4 | 24 h / 7 d planned | later slice |

Cache keys are deterministic: quote `quote:<listingId>`, history `history:<listingId>`, FX `fx` (single-flight keys), and the persisted rows are keyed by (listing), (listing, trade_date), (rate_date, currency).

## Stale-while-revalidate (`service.ts`)

- Fresh (`now - fetched_at < TTL`): return it, 0 provider calls.
- Stale: return it with `freshness: 'stale'` and start ONE background refresh.
- Missing: one blocking fetch bounded to about 5 s (`blockingFetchMs`); on timeout or error return `data: null, freshness: 'unavailable'` (the fetch keeps running and persists for the next reader).
- Every read carries `source`, `asOf` (provider validity), `fetchedAt` (when we stored it).
- Single-flight per key: N concurrent callers share one provider call. Quote batches join listings already in flight.
- A failed refresh **never** bumps `fetched_at` or overwrites data; it only writes `market_data_fetch_state`.
- Refreshes are safe to repeat: upserts are idempotent; a fresh or backed-off key is skipped.

## Backoff and quota

- `market_data_fetch_state` (listing, kind `quote|history|fx`): `failure_count`, `last_error_code`, `next_retry_at`, `last_success_at`, `history_complete_from`. After the n-th consecutive failure the next retry is `now + min(6 h, 1 min * 2^(n-1))`. A success resets the streak. Inside the window the key is skipped (`skipped_backoff`) without a provider call.
- Daily quota: `provider_usage (provider, UTC day, calls)`, `MARKET_DATA_DAILY_QUOTA` (default 5000). Every attempt (retries included) is counted atomically in SQL; over budget the call is refused (`quota_exceeded`) and the provider is not contacted. If the usage store itself fails the call is refused. A quota refusal is not recorded as the listing's failure (no backoff). FX counts under `fx_<name>`.

## Persistence (migration 0004)

`price_daily` (PK listing+date, `close` = SPLIT-ADJUSTED close used by all computations, `adj_close` informational), `quote_latest`, `fx_daily` (EUR-based: `rate_per_eur` = units of currency per 1 EUR; EUR never stored), `market_data_fetch_state` (unique NULLS NOT DISTINCT, one FX row), `provider_usage`, `listing_metrics`. CHECK constraints: prices/rates strictly positive and not NaN, formats of currency/source/reason codes, `listing_metrics` consistency (value XOR reason). Additive migration: no existing table is modified.

### D3 risk: adjusted close

EODHD `adjusted_close` adjusts for splits **and dividends**. D3 requires a split-adjusted price return, so the real adapter MUST NOT use `adjusted_close` as `close`. Map `close` from the provider's split-adjusted but not dividend-adjusted field (EODHD `close` is split-adjusted only; verify per listing before trusting it, and re-check whenever the plan changes). `adj_close` is stored only for information. The fake provider emulates the difference on purpose so a test would notice if anything read `adj_close`.

## listing_metrics (`metrics.ts`)

Computed only with the domain functions (`computePerformance`, `convert`); the server only chooses inputs and rounds once to the column scale (prices 8, percentages 8, rates 10).

**End-price rule.** With `quoteDate` = exchange-local date of the latest quote's provider timestamp and `closeDate` = date of the latest stored close: use the QUOTE if `quoteDate >= closeDate` (ties go to the quote), otherwise the CLOSE. No close: quote. No quote: close. Neither: price NULL and every period `end_missing`. The performance as-of date is the date of the chosen price. Quotes/closes in another currency than the listing's are ignored.

**FX rule.** `price_eur` = domain `convert` with the latest stored rate dated on or before the as-of date and at most `fxToleranceDays` (7) older. Otherwise `price_eur` is NULL with `price_eur_reason = rate_missing` (never a rate of 1). GBX: pence / 100 / (GBP per EUR).

**`history_complete_from`** = the date of the first stored close, set only after a full backfill where the provider says the series reached its own start; never the request's `from` (D14). Without it `perf_max` is NULL with reason `history_completeness_unknown`.

## Worker (`apps/worker`, `pnpm worker`)

Single instance only (D13): the no-overlap `JobLock` is in-process. Two workers would double-fetch and double-count the quota. Compose `worker` service (profile `app`): one replica, non-root, env allow-list, DML-only DB role, `stop_grace_period` 40 s. SIGTERM/SIGINT: stop scheduling, abort loops between listings, wait for the running job, close the pool, exit 0 (hard exit after 30 s).

| Job | Schedule | Work |
| --- | --- | --- |
| Catch-up | on start | nightly job, then the first quote tick |
| quotes | every 15 min | held listings (present in a space position) whose exchange is in its refresh window; one batched provider call; metrics recomputed for refreshed listings |
| nightly | 03:30 UTC daily | incremental history (last 5 days re-pulled) for held listings, FX (back to the oldest close), `listing_metrics` for held listings, global purge of expired sessions |

A job already running is skipped, not queued.

### Market hours (exchange-local time, DST via IANA timezone)

Refresh window = weekday, from open to close + 30 min. **Holidays are not modelled**: on a holiday the worker still asks, the provider returns the last session's price and its `asOf` says so. Unknown MIC: 09:00-17:30.

| MIC | Open | Close | | MIC | Open | Close |
| --- | --- | --- | --- | --- | --- | --- |
| XPAR, XAMS, XBRU, XMIL, XMAD, XETR, XSWX, XSTO | 09:00 | 17:30 | | XNYS, XNAS, XTSE | 09:30 | 16:00 |
| XLON, XLIS | 08:00 | 16:30 | | XFRA | 08:00 | 20:00 |
| XCSE | 09:00 | 17:00 | | XHEL | 10:00 | 18:30 |
| XOSL | 09:00 | 16:20 | | | | |

## Operator commands

`pnpm admin -- market:refresh [--quotes] [--history] [--fx] [--metrics] [<symbol>.<MIC>]` (past the TTLs, still honours backoff and quota) and `pnpm admin -- market:status`. Env in `.env.example`.

## What S5/S6 need

- Read through `MarketDataService` (`getQuote`, `getDailyHistory`, `getLatestFx`) from oRPC procedures, or SQL over `listing_metrics` for table sort/filter (partial indexes exist on price_eur and every perf column; NULLs sort last).
- Show `—` for NULL values, with the reason code; show freshness (`stale`) and `asOf`.
- Position value/portfolio history: domain `valuation` / `buildValueSeries` with `price_daily`, `fx_daily`; nothing is precomputed for them.
