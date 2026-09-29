# Waddlers — MVP implementation plan

Status: **approved decisions D1–D11 recorded 2026-09-29 (§7); non-blocking items still open**. Produced 2026-09-29 by `/plan` (planner + architect, Opus). **Done: S0, S1, S2, S4 domain module** (decisions: `docs/ai/BACKEND.md`, `docs/ai/FRONTEND.md`, `docs/ai/DOMAIN.md`; reviews: `docs/ai/REVIEW-S1.md`, `docs/ai/REVIEW-S2.md`).
Source of truth remains `specs.md`; this file records the agreed decomposition and design.

## 1. Objective

Deliver the MVP defined in `specs.md` §45, following priorities §47 (P0 foundations → P1 data/dashboard/table → P2 instrument detail), as tested vertical slices. P3 (WebSocket, intraday) is out of scope; §46 exclusions apply.

## 2. Architecture summary

### Layout (pnpm workspace, one deployable image)

```
apps/web            Next.js App Router; oRPC mounted at /api/rpc/[[...rest]]
apps/worker         scheduled market-data refresh + admin CLI (same image, different command)
packages/domain     pure TS: Decimal money, performance, valuation, FX, period math — no I/O, no React
packages/contracts  Zod schemas, oRPC contract, column-registry metadata — browser-safe
packages/server     services, repositories, Drizzle schema/migrations, auth, market-data providers/cache — `server-only`
```

Client code may import `contracts` and `domain` only (ESLint boundary rule). Rejected: separate web/api services (CORS, cross-site cookies, CSRF, two deploy units for no MVP benefit); single flat package (easy leakage of server/domain code into components).

### Layering (§41)

- App: oRPC procedure → `authed` / space-scoped middleware → service (authz + orchestration) → repository (Drizzle, requires branded `AuthorizedSpace`) → Postgres.
- Market data: `MarketDataProvider` adapter (Zod-parsed, normalized) → `MarketDataService` (TTL, single-flight, backoff, persistence) → Postgres → `MetricsService` (materializes `listing_metrics`) → services → oRPC.

### Data model (key points)

- **Global reference data**: `instruments` (type stock|etf, ISIN, sector, description), `exchanges` (MIC, timezone), `listings` (symbol, currency, minor-unit divisor), `listing_provider_ids`.
- **Per-space data**: `spaces` (reference_currency), `space_members` (M:N, role), `space_positions` (listing chosen per space + selection reason §35, `quantity numeric null ≥ 0`, unique(space, instrument)), `table_configs` (pk user+space, versioned jsonb).
- **Market data**: `price_daily` (listing, trade_date, close, adj_close, currency, source, fetched_at), `quote_latest`, `fx_daily` (EUR-based), `instrument_fundamentals` (wide, one column group per TTL group with `*_as_of`/`*_fetched_at`, all nullable), `market_data_fetch_state` (negative cache/backoff, `history_complete_from`), `provider_usage` (daily quota), `listing_metrics` (precomputed price EUR, perf per period with base date — enables SQL sort/filter).
- Numbers: Postgres `numeric` ↔ string in Drizzle ↔ `Decimal` in domain ↔ decimal strings in the API; money is always `{ amount: string | null, currency }`. Unavailable = `null`, never `0`.
- Enums as `text + CHECK`. Extensions `citext`, `pg_trgm`.

### Auth & security

- Hand-rolled sessions: 32-byte token, SHA-256 stored, cookie `__Host-wd_session` (HttpOnly, Secure, SameSite=Lax), 30-day sliding expiry.
- argon2id (`@node-rs/argon2`), dummy verify for unknown users, login rate limit, change-password revokes other sessions.
- CSRF: POST-only mutations, oRPC CSRF header plugin, Origin check.
- Next middleware is only a redirect convenience — **never** the auth boundary. Authz in oRPC middleware + services; inaccessible space → `NOT_FOUND`.
- No signup. Admin CLI (`user:create`, `user:reset-password`, `space:create`, `space:grant`, …); password never via argv. Dev seed refuses to run in production.

### Market-data provider & cache

- Provider interface: `search`, `getQuotes`, `getDailyHistory`, `getFundamentals`, optional FX; returns `ProviderResult` (never throws, never returns 0/NaN for missing). Wrapper handles rate limit, concurrency, timeout, retry, quota, key redaction.
- `fake` provider (deterministic, seeded) for dev/E2E; `FixtureProvider` for tests. Separate `FxProvider` (ECB recommended).
- Default TTLs (config, Zod-validated): quote 15 min · daily history 12 h · FX 12 h · market cap/EV/debt/dividend/holders 24 h · sector/description 7 d.
- Stale-while-revalidate: fresh → return; stale → return with `freshness: 'stale'` + background refresh; missing → blocking fetch (5 s) else `null` + `freshness: 'unavailable'`. Failures never bump `fetched_at`; backoff via `market_data_fetch_state`.
- Worker: quote refresh every 15 min in market hours for held listings; nightly incremental history (re-pull last 5 days), FX, due fundamentals, recompute `listing_metrics`.
- TanStack Query: staleTime 60 s (value/quotes), 5 min (tables/history); client refetch reads Postgres, not the provider.
- Every financial endpoint documents its TTL in `docs/ai/` (CLAUDE.md §7).

### Financial computations (`packages/domain`)

- Performance = `(end / base − 1) × 100` (Decimal). Base = close on nearest trading day **on or before** target; `null` if history starts after target, gap > tolerance (10 d default), base ≤ 0, or end missing. Month periods use calendar months with end-of-month clamping. Max requires `history_complete_from`.
- Space value = Σ qty × price × fx(local→ref); missing FX → row `null` (never rate 1); result carries `isComplete` + `missing[]`.
- History series = current quantities × historical close × same-day FX, forward-filled within tolerance, server-downsampled (≤ 400 pts); headline delta derived from the same series.
- Movers: gainers perf > 0 desc, losers perf < 0 asc, 5 each, nulls excluded, deterministic ties.

### Table (server-side, §20–22, §38)

- `positions.list({ spaceId, period, search, filters, sort, page })` → `{ rows, total, asOf }`.
- Filters: Zod discriminated union (`between` numeric, `in` enum), `columnId` from a whitelist enum.
- Column registry split: metadata in `contracts`, SQL mapping in `server`. `perf_period` resolves to `perf_{period}`. NULLS LAST, stable tiebreak, ILIKE + trigram search, offset pagination (limit ≤ 200).
- Table config v1: ordered `{id, visible}[]`, optional sort/filters/density/pageSize; migrate on read; defaults from §18; reset deletes row.

### Infra

- Compose: `postgres:17`, one-shot `migrate`, `web`, `worker`, `postgres-test` (tmpfs).
- Env Zod-validated at boot; `.env.example` committed; no `NEXT_PUBLIC_` secrets.
- Migrations: `drizzle-kit generate`, SQL reviewed and committed; no `push` outside a throwaway DB.
- GitHub Actions (`.github/workflows/ci.yml`, replaced GitLab CI on 2026-09-29 by user decision): quality (eslint, prettier, tsc, unit; + drizzle check from S1) → build + e2e (fake provider); integration job with a Postgres service from S1; security (pnpm audit, gitleaks, CodeQL) by S10.

## 3. Slices

| Slice | Content | Spec | Key tests | Execute | Gates |
|---|---|---|---|---|---|
| **S0** Scaffold | workspace, TS strict, ESLint/Prettier, Compose Postgres, Vitest/Playwright, CI skeleton, Tailwind/shadcn, Query + toastify providers | §4, §42–44 | smoke unit + Playwright root | backend-impl (+ frontend-impl for UI providers) | review |
| **S1** DB + API skeleton | Drizzle config/migrations, oRPC route + typed client, env schema, safe error mapping | §5–6, §36 | integration `health` against real Postgres | backend-impl | review |
| **S2** Auth | users/sessions, login/logout/me/changePassword, admin CLI, login page, settings form, route guard | §7–8 | hashing/policy unit; bad creds, expiry, logout, change-password, unauth rejection; E2E *connexion* | backend + frontend impl | review, **security** (mandatory), UI |
| **S3** Spaces & positions | spaces/members/instruments/listings/positions schema, `requireSpaceAccess`, list/setQuantity (+ add/remove per D-Q5), app shell + nav + space selector, dev seed | §2, §9, §33, §35, §40 | IDOR matrix per procedure; quantity validation; E2E *sélection d'un espace* | backend + frontend impl | review, **security** (IDOR), UI |
| **S4** Market data + domain | domain calcs **test-first**; provider interface + fake; price/quote/FX/fetch-state tables; MarketDataService (TTL, SWR, single-flight, backoff); metrics materialization; worker; real adapter after decision D1 | §25–27, §30–31, §34 | full domain edge-case tables; cache hit → no provider call; TTL expiry → call; provider error → stale/null, never 0; adapter parsing/malformed payload | test-designer writes cases → backend-impl | review, **coverage** (financial), **security** (credentials) |
| **S5** Dashboard | summary/history/movers procedures; period selector in URL; value card; Recharts chart + tooltip; movers blocks; loading/empty/error/unavailable states | §10–14, §28, §36 | series/movers unit; procedures integration; E2E *changement de période* | backend + frontend impl | review, UI (desktop/tablet/mobile) |
| **S6** Table v1 | server list/sort/search/pagination; column registry; TanStack Table manual mode; §18 defaults; "—" formatting; mobile h-scroll | §15–18, §20, §22, §24, §38–39 | sort nulls-last/stable, search per field, pagination, authz; fr-FR formatters; E2E *recherche*, *tri*; ~5 000-row latency check | backend + frontend impl | review, UI |
| **S7** Table v2 | combinable filter AST; show/hide, drag-reorder, reset; table_config per user+space | §16, §19, §21 | config isolation (space & user), filter combos, invalid filter rejected; E2E *filtrage*, *colonnes*, *ordre*, restore after re-login | backend + frontend impl | review, security (filter/config input), UI |
| **S8** Fundamentals | market cap, EV, EV/cap, net debt, debt ratio + nature, dividend/yield, holders, sector, description; table columns/filters | §17, §24, §27 | derived ratios with null/0 denominators; adapter per field; TTL per group | backend-impl | review, coverage |
| **S9** Instrument detail | `instruments.detail/history`; §23 page with own period tabs, sections, listing rationale | §23–24, §35 | authz + null fields; E2E *consultation d'un titre* from movers and table | frontend + backend impl | review, UI |
| **S10** Hardening | full §43 E2E in CI; full security audit; coverage-gap pass; responsive and error-message audit | §36, §39, §43 | — | ui-verifier, security-auditor, coverage-analyst | final verification |

### Dependencies

- S0 → S1 → S2 → S3 strictly sequential.
- S4 domain module + fake provider can start in parallel with S2/S3 (no DB). S4 persistence/service needs S1 + S3 schema. Real adapter needs D1.
- S5 and S6 need S3 + S4 (fake provider suffices); parallel only in isolated worktrees, after S4 lands.
- S7 needs S6. S8 needs S4 and touches the S6/S7 column registry. S9 needs S4, S8, S5 period state. S10 needs all.

## 4. Risks

1. Provider coverage/licensing for EU listings, ETF data, holders, net debt, descriptions — S8 may be mostly "—".
2. Adjusted vs raw close silently changing every performance figure.
3. FX direction errors and minor currency units (GBX, ZAc) — one EUR-base convention, tested.
4. Historical series (current quantities × past prices) misread as real returns.
5. Partial totals looking complete.
6. Trading date derived from UTC instead of exchange timezone.
7. Rate limits/quota exhaustion at scale (thousands of listings) — bulk endpoints, daily budget, backoff.
8. IDOR on every `spaceId`-taking procedure; RSC/SSR leaking server data or keys.
9. Float leakage into money math.
10. Scope creep toward a transaction ledger (§46).

## 5. MVP acceptance criteria

- **Auth (§7–8)**: admin-created user can log in/out and change password; no signup route; hashed passwords; persistent session; all procedures reject unauthenticated calls.
- **Isolation (§8)**: every space-scoped procedure returns not-found for spaces the user cannot access — proven by integration tests.
- **Spaces (§9, §33, §40)**: multiple spaces, switchable from nav; switching refreshes the dashboard; quantity edit persists with toast.
- **Period (§11)**: one selector drives chart, value delta, movers and "Performance période" column.
- **Value (§12, §32, §34)**: Σ qty × price with explicit FX; missing data never counted as 0.
- **Performance (§31)**: formula exact; "—" when history insufficient; unit-tested for all six periods.
- **Chart (§13)**: tooltip with date, value, evolution %.
- **Movers (§14)**: top/bottom 5 by selected period, nulls excluded, click opens detail.
- **Table (§15–22)**: §18 defaults, all §17 columns available; case-insensitive server search; AND-combined filters; sortable numeric columns with indicator; add/remove/reorder/reset columns; config per user+space restored after re-login.
- **Data (§25–27, §30)**: no client-side provider calls; configurable TTLs; cache hit makes no provider call (tested); values carry as-of/source; provider failure shows the §36 message, never fabricated values.
- **ETF (§24)**: non-applicable indicators show "—".
- **Detail (§23, §35)**: all sections, own period tabs, listing rationale.
- **Scale (§38)**: ~5 000-position space pages/sorts/filters server-side within agreed budget.
- **Quality (§43–44)**: CI green on lint, strict typecheck, Vitest, build, Playwright §43 scenarios.

## 6. Security checkpoints

S2 (auth/session), S3 (IDOR/isolation), S4 (provider credentials, external API), S7 (filter/config input), S10 (full audit, dependencies, headers, CSRF).

## 7. Open decisions (need user input)

Decided by the user on 2026-09-29:

| # | Decision | Outcome |
|---|---|---|
| D1 | Market-data provider | **EODHD** (changed from Twelve Data on 2026-09-29). Broad EU+US listings and bulk end-of-day data; main shareholders and ETF data need a higher plan. Before the real adapter, check coverage of the real ticker list and the plan tier against the §17 columns, and check licensing for several users. Any field it lacks stays `null`/"—". The fake provider covers S0–S7. |
| D2 | FX source | ECB reference rates (default; EODHD FX is a possible alternative) |
| D3 | Price basis | Split-adjusted price return |
| D4 | Performance currency | Local currency of the listing |
| D5 | Incomplete space total | Partial total + warning |
| D6 | Historical chart | Current quantities × past prices, labelled "valeur des positions actuelles" |
| D7 | Space reference currency | EUR only for MVP (DB column kept) |
| D8 | Listing choice scope | Per space position (default) |
| D9 | Null quantity | Allowed; watchlist entry excluded from value, included in table/movers |
| D10 | Shared spaces | M:N membership with roles (default); table config per user+space |
| D11 | Adding instruments | Server-side provider-backed search (rate-limited) + add form; admin CLI fallback. S3 fills positions via dev seed/admin CLI; the add form ships right after S4 (needs the search endpoint), on the fake provider until the EODHD adapter lands. |
| D20 | Missing history for recent listings | Decided 2026-09-29: "on ne ment pas sur la donnée". A history day where any counted position lacks a close or FX has no value (never a partial sum); leading/trailing empty days are trimmed so the chart starts at the first complete day, whose actual close date is shown ("depuis le …"); mid-series gaps stay visible. Details: `docs/ai/DOMAIN.md`. |

Non-blocking (can default and revisit):

- D12 Persisted table config contents — columns, order, sort, filters, density.
- D13 Deployment target (single vs multi instance → Redis timing) — single instance.
- D14 Definitions: "Performance Max" (since first datapoint with complete history), "Taux d'endettement" / "Nature" (provider-supplied with explicit kind), "Activité & positionnement" (provider description; no AI generation in MVP).
- D15 Admin provisioning via CLI; username (not email) login; force password change on first login?
- D16 UI language French, fr-FR formats; sector labels translated?
- D17 Content of "Titres" and "Espaces" pages; can users create/rename spaces themselves (§37) vs admin-only (§7)?
- D18 CI scope: build/test only, no deploy target in MVP.
- D19 Realistic max positions per space (drives precomputation budget).

## 8. Recommended next step

`/implement` **S3** (spaces & positions) — every page calls `requireUser()` and reads data only through authed oRPC procedures (`docs/ai/FRONTEND.md`); IDOR security review is mandatory. Then the S4 persistence/service part (needs S3 schema). Carry-overs for S5: surface `invalidPositions` and `leadingMissing` from the history series (`docs/ai/DOMAIN.md`).
