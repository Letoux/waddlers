# Backend conventions (S1, auth added in S2)

## Environment

Server env is validated with Zod in `packages/server/src/env.ts`, parsed lazily on first `getEnv()` (so `next build` needs no database). Required: `DATABASE_URL` (runtime, **app role**), `APP_ORIGIN`, `MARKET_DATA_PROVIDER` (`fake` | `eodhd`), `AUTH_SECRET` (HMAC key for device cookies, at least 32 bytes, never logged; generate with `echo "AUTH_SECRET=$(openssl rand -base64 48)" >> .env`, the app refuses to start without it); `NODE_ENV` defaults to `development`. Optional: `TRUSTED_PROXY_HEADER` (`x-forwarded-for` | `x-real-ip`, empty = unset). In production `APP_ORIGIN` must be https (or localhost): the session cookie is `Secure`. Script-only variables (not in the web env schema): `DATABASE_MIGRATE_URL` (owner; falls back to `DATABASE_URL`), `APP_DB_PASSWORD`, `SEED_USER_USERNAME`/`SEED_USER_PASSWORD`. The `db:*`, `admin` and `db:seed` scripts load the root `.env` via `tsx --env-file-if-exists=../../.env` (process env wins). Validation errors name the variable but never print its value. Secrets never use a `NEXT_PUBLIC_` prefix. `apps/web/next.config.ts` loads the root `.env` for local dev (process env wins).

## Migrations (Drizzle)

- Schema: `packages/server/src/db/schema/` (one file per table, re-exported from `index.ts`). Migrations: `packages/server/drizzle/`, committed and reviewed.
- Change the schema, then `pnpm db:generate` (use `-- --custom` for hand-written SQL). Never `drizzle-kit push` outside a throwaway database. Destructive changes need explicit authorization.
- Apply: `pnpm db:migrate` (programmatic `migrate()`, idempotent, runs as the **owner** via `DATABASE_MIGRATE_URL`). Compose runs `db:setup-roles` then `db:migrate` in the one-shot, non-root `migrate` service that `web` depends on; CI runs it before integration tests.
- CI (`quality` job) runs `db:generate` and fails if `packages/server/drizzle` changes or gains an untracked file (schema drift).
- `pnpm db:check` (drizzle-kit check) runs in the CI quality job.
- `0000_init_extensions` enables `citext` and `pg_trgm` (trusted extensions on PostgreSQL 13+; the DB owner may create them).

## Integration tests

`pnpm test:integration` runs `packages/server/**/*.int.test.ts` (vitest project `integration`) against `DATABASE_URL_TEST`, migrating it first via global setup. It is excluded from `pnpm test`, and it fails loudly (not skips) if `DATABASE_URL_TEST` is unset, so CI misconfiguration cannot pass silently. Locally: `docker compose --profile test up -d postgres-test`, then `DATABASE_URL_TEST=postgres://waddlers:waddlers-test@localhost:5433/waddlers_test pnpm test:integration`.

`server-only` throws outside the `react-server` condition, so vitest aliases it to a stub. A future worker run with `tsx` that imports server modules must pass `--conditions react-server` (or avoid `server-only` modules).

## oRPC

Contract-first: schemas and the contract live in `packages/contracts` (browser-safe). Implementations live in `packages/server/src/router.ts` (`implement(contract)`); mounted at `apps/web/app/api/rpc/[[...rest]]/route.ts`. The typed client and TanStack Query helpers are in `apps/web/lib/orpc.ts`.

Security groundwork: the route exports **POST only** (add GET only when a procedure opts into it; Next adds an implicit HEAD when GET is exported, so `createRpcHandler` also answers 405 for any method other than POST/GET, and oRPC's `StrictGetMethodPlugin`, on by default, refuses GET on procedures). Every request needs the `x-csrf-token` header (oRPC simple CSRF plugin, added by the client link). `allowedOrigin` is a **required** `createRpcHandler` option (APP_ORIGIN): a request with a foreign `Origin` gets 403 (missing Origin is allowed; the CSRF header still applies). The custom 403/405 bodies are oRPC-encoded (`{ json: <ORPCError json> }`) so RPCLink decodes them as typed `ORPCError`s (covered by an in-process client test). Every RPC response, including 403/404/405, carries `Cache-Control: no-store`. Session cookies and authn/z: see the Authentication section below.

## Error-mapping policy (specs section 36)

Technical errors are never exposed. `packages/server/src/errors.ts` wraps every procedure call: an `ORPCError` passes through unchanged (procedures throw these deliberately: `NOT_FOUND`, `UNAUTHORIZED`, ...); any other error is logged server-side and replaced by `INTERNAL_SERVER_ERROR` with the neutral message `Internal server error` (no stack, SQL, driver text, no `cause`). The UI maps error codes to user-facing French messages. Dependency failures in the authenticated `systemStatus` are reported as `db: 'unavailable'` (HTTP 200, `status: 'degraded'`) with no detail.

## Logging policy

All server error logs go through `describeError()` (`errors.ts`): error `name`, SQLSTATE/system `code`, `constraint_name`, `severity`, Drizzle `query` (placeholders only) and the stack frames, walking `cause` at most two levels. It never logs `message` (Drizzle embeds params in it), `params` or Postgres `detail` (row values). `ORPCError`s with status >= 500 (e.g. output validation) are logged and passed through unchanged. Loggers are injectable (`log` in `createRpcHandler` / `RouterDeps`) so tests need no console spies.

## Route tests

`apps/web/**/*.test.ts` run in the vitest project `web` (part of `pnpm test`): the Next route module is imported directly with stubbed env (unreachable DB) to assert Origin, method exports and 404 behaviour.

## Authentication (S2)

Spec: specs section 7-8. No signup exists anywhere (no procedure, route or page); users are created by the admin CLI.

### Data model and migration impact

`0001_auth_users_sessions.sql` (purely additive; no destructive change):

- `users` (`id` uuid pk, `username` citext unique, `password_hash` text, `created_at`, `updated_at`, `disabled_at` nullable, all timestamptz).
- `sessions` (`id` uuid pk, `user_id` fk `users` **on delete cascade**, `token_hash` text unique with CHECK `^[0-9a-f]{64}$`, `created_at`, `last_seen_at`, `expires_at`, `user_agent` nullable) with indexes on `user_id` and `expires_at`.

### Session model

- Token: 32 random bytes (base64url in the cookie). Only its SHA-256 (hex) is stored, so a database leak does not yield usable sessions.
- Cookie `__Host-wd_session`: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`, no `Domain`. Verified: Chromium accepts a `Secure` cookie from `http://localhost` (also Firefox); **Safari does not**, so use Chromium/Firefox for local dev over http. No dev-only cookie name exists, on purpose (a weaker fallback name would risk shipping).
- Lifetime: 30 days, sliding. `expires_at`/`last_seen_at` are refreshed at most once per 24 h and the cookie is re-issued at that moment. Refresh only happens on requests that can carry `Set-Cookie` (the HTTP handler). The server-side client (SSR/RSC) never writes, otherwise the database expiry could move without the cookie following.
- A session is valid only if the token is known, `expires_at > now` and the user is not disabled. Login replaces any presented session (no fixation) and purges the user's expired sessions.
- `logout` deletes the session row and clears the cookie. `changePassword` requires the current password, updates the hash, deletes all the user's other sessions and rotates the current session's token, in one transaction.

### Passwords

argon2id via `@node-rs/argon2`, OWASP minimum profile: `m=19456 KiB, t=2, p=1` (constants in `auth/password.ts`; parameters live in the PHC string, `needsRehash` upgrades a weaker hash on the next successful login). Policy (shared Zod schema in `@waddlers/contracts`, `newPasswordSchema`): 12-256 characters, no composition rules; it is enforced when a password is set, never on login input. Unknown and disabled accounts run a dummy verification with the same parameters, and every failure returns the same `UNAUTHORIZED` / "Identifiants invalides".

D15 defaults applied, revisitable: identifier = **username** (3-64 chars `[A-Za-z0-9._-]`, case-insensitive); **no forced password change at first login** in the MVP (the admin chooses the initial password; users can change it in settings).

### Rate limiting

`auth/rate-limit.ts`, in memory, single instance (D13: per process, reset on restart; multi-instance needs a shared store). Attempts are **reserved synchronously** right after the limit check (no `await` in between) and refunded when the attempt succeeds, so concurrent requests cannot all slip under the budget (tested with 40 parallel logins: exactly 5 reach password verification, the rest get 429). A blocked request is not counted and does not extend the window.

- **Known client IP** (`TRUSTED_PROXY_HEADER` set; with `x-forwarded-for` the right-most entry is used): 5 attempts per (username, IP) and 20 per username across IPs per 15 minutes, then a hard block (`TOO_MANY_REQUESTS`, 429) even for the right password. The per-username cap still holds if a spoofed header rotates the IP.
- **Unknown client IP** (`TRUSTED_PROXY_HEADER` unset, the default): every client looks the same, so a pair limit would let anonymous failures lock a user out for everyone. Instead a per-username **progressive delay** applies: 5 free attempts, then a wait of 2 s doubling up to 60 s (resets after a success or 15 idle minutes). This caps an attacker at about one guess per minute per username, but it is **not** a bounded lock-out for the victim: an attacker polling once a second holds the username at the 60 s cap indefinitely (simulated: the victim got in 0 times in an hour). Users who have a device cookie (below) are not affected; a user on a new browser is until the attack stops.
- **Device cookies** (`auth/device.ts`, OWASP pattern): every successful login sets `__Host-wd_device` (HttpOnly, Secure, SameSite=Strict, 1 year): `v1.<random 128-bit device id>.<HMAC-SHA-256(AUTH_SECRET, v1|lower(username)|deviceId)>`. A login carrying a valid cookie **for that username** is throttled on its own per-device budget (5 attempts, then only that device is locked out for 15 minutes, `Retry-After: 900`) and bypasses the shared per-username limits in both IP modes; success clears it and re-issues the same cookie. A forged, tampered, malformed, re-keyed or other-username cookie is indistinguishable from an absent one (constant-time compare). A cookie can only be obtained by logging in with the password, and is useless for any other username. Residual risk: someone holding a stolen device cookie plus a stolen username gets 5 guesses per 15 minutes. Rotating `AUTH_SECRET` invalidates all device cookies (users fall back to the shared limits); it does not touch sessions.
- `changePassword` has its own budget per user (wrong current password; stolen-session guessing), same mechanics.
- Throttled responses are the typed error `TOO_MANY_REQUESTS` with `data: { retryAfterSeconds }` plus a `Retry-After` header.
- Limiter memory has a soft cap on keys. Eviction never resets progress: expired windows/idle entries go first, then only keys still under their free attempts (oldest first). Keys at a backoff level or at their budget are kept, so flooding junk usernames cannot reset the delay of a username under attack. Reaching a level costs `freeAttempts` requests per key within 15 minutes, so the map can exceed the soft cap only in proportion to real attack effort; accepted for a single instance (D13), revisit with a shared store.

### oRPC layout

- Context: `{ headers: Headers; resHeaders?: Headers }` (`RpcContext`). `ResponseHeadersPlugin` turns `resHeaders` into response headers (`Set-Cookie`).
- Procedures that set or clear the cookie (`login`, `logout`, `changePassword`) throw when called without `resHeaders` (the server-side client): a session must never be committed without a response to carry the cookie. A response carries at most one session `Set-Cookie` (the last write wins, e.g. a sliding refresh followed by logout sends only the clearing cookie). Login's session writes (revoke previous, purge expired, insert) are one transaction; `changePassword` rotates the current session inside its transaction and aborts (rolling the new password back) if that session no longer qualifies (revoked, expired, user disabled).
- `authed` middleware (in `router.ts`) resolves the session from the `cookie` header and adds `context.session`. It runs before input validation. **Every non-public procedure must be built from `authed`.** `PUBLIC_PROCEDURES` in `@waddlers/contracts` (`health`, `auth.login`) is the explicit allowlist; `auth/guard.test.ts` enumerates the contract and asserts every other procedure answers `UNAUTHORIZED` to anonymous calls (with no database access).
- `health` is **public and liveness-only** (`{ status: 'ok', time }`): no dependency state is exposed to anonymous callers, and it needs no rate limit or log line. The database probe moved to authenticated `systemStatus` (its "database unavailable" log line is throttled to one per 30 s).
- Login-related errors: `UNAUTHORIZED` (401), `TOO_MANY_REQUESTS` (429), `INVALID_CURRENT_PASSWORD` (400, typed in the contract), `BAD_REQUEST` (validation). Do not render `message`/`issues` raw.

### CSRF invariants (cookie sessions)

1. No CORS, ever: no `Access-Control-*` headers; `OPTIONS` is 405 (tested).
2. `x-csrf-token` header required (oRPC simple CSRF plugin, added by the client link).
3. `Sec-Fetch-Site`, when present, must be `same-origin`; `Origin`, when present, must equal `APP_ORIGIN`.
4. **Fail closed:** a request carrying the session cookie with neither `Origin` nor `Sec-Fetch-Site` gets 403. Cookie-less requests (curl, login from a script) are allowed without them. When testing with curl and a session cookie, send `Origin: <APP_ORIGIN>`.
5. login/logout/me/changePassword are ordinary RPC procedures behind the same handler (POST `/api/rpc/auth/...`); there is no separate route, server action or form POST.
6. Body limit 1 MB (`BodyLimitPlugin`) before any procedure; oversize bodies get 413.

### Server-side client (SSR/RSC)

`createServerClient({ headers })` (`@waddlers/server`, wraps `createRouterClient`) runs the same router in-process. In the web app use `apps/web/server/orpc.ts` (`getServerClient()`) and `apps/web/server/auth.ts` (`getCurrentUser()`: user or `null`, memoised per request, only `UNAUTHORIZED` maps to `null`). `apps/web/lib/orpc.ts` is browser-only and throws if used on the server. Next middleware, if any, is only a redirect convenience, never the auth boundary.

### Database roles (least privilege)

- **Owner** (`POSTGRES_USER`, `DATABASE_MIGRATE_URL`): runs migrations and `pnpm db:setup-roles`. Only the `migrate` service and CI use it.
- **App role** `waddlers_app` (`DATABASE_URL`, password `APP_DB_PASSWORD`): `SELECT/INSERT/UPDATE/DELETE` on `public` tables and sequence usage; no DDL, no `TRUNCATE`, no access to the `drizzle` migration schema, not superuser. `ALTER DEFAULT PRIVILEGES` gives it DML on tables created by future migrations, so nothing needs re-granting. Used by web, the admin CLI and the seed. `db:setup-roles` is idempotent and also rotates the password; run it before `db:migrate` (Compose does). Passwords must be URL-safe (`openssl rand -hex 24`), enforced by the script, because they are embedded in URLs. `setup-roles` sends the password with `ALTER/CREATE ROLE ... PASSWORD '<literal>'`, which PostgreSQL may write to the server log if `log_statement` is `ddl`/`all`: **keep statement logging off** (the default) on the database, or rotate the password afterwards. `db:migrate` prints a hint to use `DATABASE_MIGRATE_URL` (owner) on SQLSTATE 42501. Integration tests (`db/roles.int.test.ts`) prove the role cannot run DDL.
- Non-Docker `next dev` loads the root `.env` from `apps/web/next.config.ts` (Next only reads `apps/web/.env`); Docker/CI rely on the process environment. Local dev stays simple: `.env.example` documents both URLs; `pnpm db:migrate` falls back to `DATABASE_URL` if `DATABASE_MIGRATE_URL` is unset (single-role setups). The Compose `web` service only receives `DATABASE_URL` (app role), `APP_ORIGIN`, `MARKET_DATA_PROVIDER`, `TRUSTED_PROXY_HEADER`, never the root `.env`. The `migrate` stage runs as non-root `node`.

### HTTP security headers (`apps/web/next.config.ts`, tested in `next.config.test.ts`)

`poweredByHeader: false`; CSP (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri`/`form-action 'self'`, `connect-src 'self'`; dev adds `unsafe-eval` and `ws:` for HMR); `X-Content-Type-Options: nosniff`; `Referrer-Policy: strict-origin-when-cross-origin`; `X-Frame-Options: DENY`; `Permissions-Policy`; HSTS in production only. **Known gap:** `script-src` needs `'unsafe-inline'` because Next inlines bootstrap scripts; a nonce-based CSP is an S10 item. Do not load third-party scripts/fonts/images without amending the CSP.

### Admin CLI and dev seed

Code: `packages/server/src/admin/*` (service + CLI logic, testable), entry points in `apps/worker/src/{admin,seed}.ts` (run via tsx; they import `@waddlers/server/admin`, which has no `server-only`).

```bash
pnpm admin -- user:create alice            # hidden prompt (asked twice on a TTY)
pnpm admin -- user:reset-password alice    # new password, revokes all sessions
pnpm admin -- user:disable alice           # disables, revokes all sessions (idempotent)
printf '%s\n' "$PASSWORD" | pnpm admin -- user:create alice   # non-interactive: first stdin line
```

The password is read only from the hidden prompt or stdin, never argv (extra arguments, including `--password`, are refused) and never from the environment. Uses `DATABASE_URL` (app role). `pnpm db:seed` creates `SEED_USER_USERNAME` (default `dev`) with `SEED_USER_PASSWORD` if absent (existing users are untouched), and exits non-zero when `NODE_ENV=production`, or, unless `ALLOW_DEV_SEED=1`, when `APP_ORIGIN` is not localhost or the `DATABASE_URL` host is not local (`localhost`, `127.0.0.1`, `::1`, `postgres`). Spaces and positions: see the S3 section below.

### What the frontend should call

- Browser: `rpc.auth.login({ username, password })` (returns `{ user }`, sets the cookie), `rpc.auth.me()` (401 = signed out), `rpc.auth.logout()`, `rpc.auth.changePassword({ currentPassword, newPassword })` (returns `{ user }`, cookie rotated). TanStack helpers: `orpc.auth.me.queryOptions()`, `orpc.auth.login.mutationOptions()`. Reuse `loginInputSchema`, `changePasswordInputSchema`, `newPasswordSchema` from `@waddlers/contracts` for forms; error codes are documented on the contract.
- Route guard (server component/layout): `const user = await getCurrentUser(); if (!user) redirect('/login')` (from `@/server/auth`). After login/logout do `router.refresh()` and clear the TanStack Query cache.
- Never show "user not found" vs "wrong password": there is one message, `UNAUTHORIZED`.

### Integration tests

`packages/server/test/auth-harness.ts` drives the real RPC handler with a browser-like request (CSRF header, Origin, Sec-Fetch-Site). Suites: `auth/auth.int.test.ts`, `auth/auth-hardening.int.test.ts` (concurrency, dead-session rotation, cookie uniqueness, device cookies, housekeeping), `auth/app-role.int.test.ts` (full flow as the DML-only role), `admin/admin.int.test.ts`, `db/roles.int.test.ts`, `health.int.test.ts`. Unit tests (`pnpm test`, no database): password/token/cookie/rate-limit, guard enumeration, CSRF/body-limit/CORS in `rpc-handler.test.ts`, CLI argument handling, env rules.

### Code layout notes

`auth/users.ts` is the users repository (used by the auth service and the admin module); `AdminError` lives in `admin/errors.ts` (no import cycle between `admin/index.ts` and `admin/cli.ts`/`seed.ts`). Node >= 22.9 is required (`--env-file-if-exists`).

## Spaces & positions (S3)

Spec: specs 2, 7, 9, 33, 35, 40. Decisions D7-D11, D17 and the S3 orchestrator decisions below.

### Decisions recorded for S3

- **Spaces are created and managed by the admin only** (specs 7; D17 defaulted): no create/rename/delete procedure for users. Admin CLI below. Space names are unique (citext) so the CLI can address them.
- **Roles (D10)**, per membership (`owner` | `editor` | `viewer`, text + CHECK): `owner` and `editor` change quantities and remove positions; `viewer` is read-only. Owner has no extra power over editor in S3 (owner-only actions can come later).
- **Positions**: listing chosen per space (D8) with a `selection_reason` (specs 35, nullable, never invented), `quantity numeric(24,8) NULL` (D9: null = watchlist entry, never coerced to 0), `quantity >= 0` and not NaN (CHECK), unique(space, instrument). In S3 positions are added by the dev seed or `position:add`; the user-facing add form ships after the S4 search (D11). Users can remove a position (owner/editor).
- Active space: `users.last_space_id` (advisory), URLs `/s/[spaceId]/...`.

### Schema and migration impact

`0002_spaces_positions.sql`: purely additive (new tables + one nullable column `users.last_space_id`); no destructive statement, no backfill, safe on a populated database. The app role gets DML on the new tables through the existing default privileges (proved in `auth/app-role.int.test.ts`).

- Global reference data: `exchanges` (`mic` pk, name, timezone, country), `instruments` (id, `type` stock|etf, name, `isin` unique nullable, sector, description, timestamps), `listings` (id, instrument, exchange, `symbol`, `currency` = the provider's RAW quote currency incl. `GBX`/`GBp`/`ZAc`; unique(exchange, symbol); unique(id, instrument) as FK target; index on instrument), `listing_provider_ids` (listing, `provider`, `provider_symbol`; unique(listing, provider) and unique(provider, provider_symbol)). Major-currency handling is derived at read time with `normalizeCurrency` (`@waddlers/domain`), never stored. Market-data tables: see the Market data (S4) section.
- Per-space: `spaces` (id, `name` citext unique, `reference_currency` default `EUR`, timestamps), `space_members` (pk (space, user), `role`; index on user), `space_positions` (id, space, instrument, listing, `selection_reason`, `quantity`, timestamps). A composite FK (listing, instrument) -> `listings(id, instrument_id)` guarantees a position's listing belongs to its instrument.
- Deletion: deleting a space cascades members and positions and nulls `users.last_space_id`; deleting a user cascades memberships; instruments, listings and exchanges are RESTRICTed while referenced.
- Numbers: PostgreSQL `numeric` <-> decimal string (Drizzle) <-> `Decimal` (domain, when computing). The API returns canonical strings without trailing zeros (`12.5`, not `12.50000000`; `canonicalQuantity`).

### Authorization core (security heart of S3)

`packages/server/src/spaces/access.ts`:

- `requireSpaceAccess({ db, userId }, spaceId, minRole)` is the ONLY producer of the branded `AuthorizedSpace` (`{ id, role, userId }`). Every repository function that touches per-space data (`spaces/repository.ts`: positions, space details, active space) takes an `AuthorizedSpace`, so a missing access check is a compile error (`spaces/access.test.ts` has `@ts-expect-error` cases; `tsc` fails if they start to compile). A cast can still forge it: reject `as AuthorizedSpace` in review.
- Space-scoped procedures are built from `spaceScoped(minRole)` in `router.ts` (`authed` + access check on `input.spaceId`, adds `context.space`). It runs **before input validation**: an inaccessible/nonexistent space is `NOT_FOUND` and a too-low role `FORBIDDEN` regardless of the rest of the payload. A malformed `spaceId` is also `NOT_FOUND` (it never reaches SQL).
- The write statements re-check the writer role themselves (`AND EXISTS (select 1 from space_members ... role in ('owner','editor'))` in the UPDATE/DELETE of `updatePositionQuantity` / `deletePosition`), so a membership revoked or downgraded between `requireSpaceAccess` and the write cannot be written through; nothing affected = `NOT_FOUND`. The minted id is lower-cased.
- Outcomes: unauthenticated or disabled user -> `UNAUTHORIZED`; not a member (including a member of other spaces only) or nonexistent space -> `NOT_FOUND` with an identical body (never FORBIDDEN, so existence is not confirmed); member with too low a role -> `FORBIDDEN`; a position id from another space with an accessible `spaceId` -> `NOT_FOUND` (row ids are resolved with `space_id = <authorized space>` inside the same statement, no fetch by id alone).
- ESLint (`eslint.config.mjs`) forbids `as AuthorizedSpace` / `<AuthorizedSpace>` outside `spaces/access.ts` and importing `operatorSpaceAccess` outside `src/admin/**`.
- `operatorSpaceAccess(spaceId)` mints an access with role owner and `userId: null` for the admin CLI and dev seed (operator = database owner of the deployment). It must never be called from a request path.
- The IDOR matrix (`spaces/idor-matrix.int.test.ts`) is data-driven: every space-scoped procedure x {anonymous, disabled user, non-member, member of another space, viewer, editor, owner, nonexistent/malformed space id, foreign position id, garbage payload}, checking the outcome and that denied calls leave the data untouched. `test/procedure-classification.ts` requires EVERY contract path to be classified `public` | `user` | `space` (unit test `spaces/contract-classification.test.ts`, no database): an unclassified path fails, `public` must equal `PUBLIC_PROCEDURES`, and a deep search of each input's JSON Schema for keys matching `/space|position/i` fails unless the path is `space`-classified (or justified in `SPACE_LIKE_KEY_JUSTIFICATIONS`). The matrix test asserts its procedures equal the `space`-classified set.

### Procedures (all authed; contract in `@waddlers/contracts`)

| Procedure | Min role | Result |
|---|---|---|
| `spaces.list()` | any user | `{ spaces: [{ id, name, referenceCurrency, role, positionCount }], activeSpaceId }`, only the caller's spaces, by name. `activeSpaceId` = last active space if still accessible, else the first by name, else `null` |
| `spaces.get({ spaceId })` | viewer | one summary (same shape) |
| `spaces.setActive({ spaceId })` | viewer | `{ activeSpaceId }`; stores `users.last_space_id` (idempotent) |
| `positions.list({ spaceId, page?: { offset, limit } })` | viewer | `{ rows, total, hasMore }` |
| `positions.setQuantity({ spaceId, positionId, quantity })` | editor | `{ positionId, quantity }`; idempotent; `quantity: null` = watchlist |
| `positions.remove({ spaceId, positionId })` | editor | `{ ok: true }`; a second call is `NOT_FOUND` |

`positions.list` rows: `{ id, quantity: string|null, selectionReason: string|null, addedAt, instrument: { id, name, type, isin }, listing: { id, symbol, exchange: { mic, name }, currency (raw, may be GBX), currencyMajor (GBP) | null, minorUnitDivisor (100) | null } }`. **No prices, values or performance** (S4/S6 add them; nothing is invented). Sorted by instrument name (case-insensitive) then id. Pagination: optional `page = { offset >= 0 (default 0), limit 1..POSITIONS_LIST_MAX (default 1000) }`; omitting `page` returns the first 1000 rows, as before. `total` = positions matching the query (today every position of the space), `hasMore = offset + rows.length < total`. Rows and total are read in one read-only REPEATABLE READ transaction, so they describe the same snapshot. Server sort, filter and search arrive in S6; an `asOf` (data freshness) field will be added to the output in S4/S6 with the market data. No provider call and no cache involved: this data is PostgreSQL only, so there is no TTL to document.

Quantity input (`quantitySchema`, reuse it in forms): a plain decimal string `^(0|[1-9]\d{0,15})(\.\d{1,8})?$`, i.e. non-negative, at most 16 integer and 8 fraction digits, matching `numeric(24,8)`. Rejected: exponent (`1e3`), thousands separators (`1 000`, `1,000`), decimal comma (`1,5`), signs, `NaN`, blanks/padding, leading/trailing dot, leading zeros (`007`), JS numbers. The empty string is invalid (the UI must send `null` for "no quantity"). `0` is valid and different from `null`.

Error codes for the UI (French messages): `UNAUTHORIZED` (redirect to login), `NOT_FOUND` (space/position unavailable: go back to the space list; also what a revoked space looks like), `FORBIDDEN` (read-only role: hide/disable edit controls using the `role` from `spaces.list`), `BAD_REQUEST` (input; never render raw issues).

### What the frontend should call

- App shell: `orpc.spaces.list` gives the selector content, the role per space and the default `activeSpaceId`. On `/` redirect to `/s/<activeSpaceId>/...` (or an empty state when `null`: the user has no space, ask the admin). Selecting a space: navigate to `/s/<id>/...` and fire `spaces.setActive` (a failure must not block navigation). Use `spaces.get` in a server component to validate `[spaceId]` (`NOT_FOUND` -> `notFound()`).
- Table: `positions.list`, edit with `positions.setQuantity` (show controls only for `owner`/`editor`), delete with `positions.remove`. Render `—` for `quantity === null` and when a value is unavailable; never turn null into 0. Show `currency`; do not divide GBX yourself, S4 will provide converted values (`currencyMajor`/`minorUnitDivisor` are metadata).
- After a mutation invalidate the `positions.list` and `spaces.list` queries (position count).
- Pages must read data only through authed oRPC procedures (FRONTEND.md); every `/s/[spaceId]/...` page calls `requireUser()` and the procedure re-checks access.

### Admin CLI (spaces)

```bash
pnpm admin -- space:create "PEA"                        # reference currency EUR (D7)
pnpm admin -- space:rename "PEA" "PEA Bourse"
pnpm admin -- space:grant "PEA" alice owner             # owner|editor|viewer; repeating changes the role
pnpm admin -- space:revoke "PEA" alice                  # idempotent
pnpm admin -- space:list                                # id, name, member and position counts
pnpm admin -- position:add "PEA" AI.XPAR 10.5           # <symbol>.<MIC> [quantity]; no quantity = watchlist
```

Space arguments are names (quote them). `position:add` needs the instrument/listing to exist in the reference data (loaded by the dev seed; loading real reference data comes with the S4 search, D11): unknown listing, invalid quantity, or an instrument already tracked in the space (also with another listing) is an error and changes nothing. Symbols may contain dots: the MIC is what follows the last dot.

### Dev seed

`pnpm db:seed` (same production/local-host guards as S2) also creates reference data and three spaces. It never attaches to data it did not create:

- a space is filled (members, positions) only when THIS run created it (`insert ... returning`); an existing space of the same name (for example a real "PEA") is left completely untouched;
- memberships go only to a dev user created by THIS run; an existing user, even one named like `SEED_USER_USERNAME`, gets no grant (spaces created for it have no member: use `space:grant`), and `SEED_USER_PASSWORD` is only needed when the user must be created;
- each space is seeded in one transaction.

Consequently a re-run changes nothing: it no longer resurrects deleted positions or revoked memberships, and never overwrites an edited quantity or role. Data: exchanges XPAR/XNAS/XNYS/XETR/XLON; 10 instruments and listings (one ETF: Amundi MSCI World `CW8`; one GBX listing: Shell on XLON; `eodhd` provider ids such as `AI.PA`, NOT yet verified against EODHD); spaces **PEA** (dev owner, 6 positions incl. a watchlist entry with `null` quantity), **Actions US** (dev viewer, 4 positions) and **Famille** (nobody has access: manual IDOR checks). The seed prints each space id and whether it was created.

### Migration 0003 (`0003_space_constraints.sql`)

Tightening constraints only, validated against the seeded dev data: `listings.currency` = `^[A-Z]{3}$` or `GBp`/`ZAc` (a test proves it accepts exactly what the domain treats as minor units); `spaces.reference_currency` also excludes `GBX`/`ZAC`/`ILA`; non-blank `instruments.name` and `spaces.name` (`btrim`, which only strips spaces), `spaces.name` at most 64 characters. It drops the redundant `space_positions_instrument_id_fk` and `space_positions_instrument_id_idx`: the composite FK (listing, instrument) -> `listings` already enforces the instrument's existence and RESTRICT (listings reference instruments), and no query filters positions by instrument alone (a future "where is this instrument tracked" query would need the index back).

### Tests (S3)

Unit: `spaces/quantity.test.ts` (schema table + canonical form), `spaces/access.test.ts` (compile-time guarantee, role order, malformed ids never reach the database), CLI arity/validation in `admin/admin-unit.test.ts`, guard enumeration. Integration: `spaces/idor-matrix.int.test.ts`, `spaces/spaces.int.test.ts` (lists, active space, decimal round trips incl. beyond `MAX_SAFE_INTEGER`, watchlist null, cap, CHECK/FK/cascade behaviour), `admin/spaces.int.test.ts` (CLI commands, seed idempotence and guards), app-role smoke extended with seed, CLI and procedures.

Gotchas found while testing: Drizzle renders subquery columns unqualified inside sql`` (two grouped subqueries need distinct aliases), and it renders `${table.col}` unqualified in a single-table `select`, so a correlated subquery written with it silently binds to the inner table. Counts are now grouped Drizzle subqueries left-joined with `coalesce`, aliased uniquely.

## Market data (S4 persistence, service, worker)

Full design, TTL table, SWR/backoff/quota semantics, market hours and the end-price rule: `docs/ai/MARKET-DATA.md`. Migration `0004_market_data.sql` is purely additive (six new tables; no existing table or data is touched, nothing destructive; the `waddlers_app` role gets DML on them through the existing default privileges).

Env (web and worker, all optional): `MARKET_DATA_PROVIDER` (`fake`|`eodhd`, eodhd is a stub), `FX_PROVIDER` (`ecb` default | `fake`; tests pin `fake` so they never hit the network), `EODHD_API_TOKEN` (never logged), `MARKET_DATA_QUOTE_TTL_MINUTES` (15), `MARKET_DATA_HISTORY_TTL_HOURS` (12), `MARKET_DATA_FX_TTL_HOURS` (12), `MARKET_DATA_DAILY_QUOTA` (5000), `MARKET_DATA_CONCURRENCY` (4), `MARKET_DATA_TIMEOUT_MS` (8000). The worker/CLI validate only `DATABASE_URL` plus these (`parseWorkerEnv`).

Admin CLI: `market:refresh [--quotes] [--history] [--fx] [--metrics] [<symbol>.<MIC>]` forces a refresh past the TTLs (backoff and quota still apply; no listing = every held listing); `market:status` prints fetch-state per kind, failing entries with `next_retry_at`, provider usage and the metrics row count.

Worker: `pnpm worker` (Compose service `worker`, profile `app`, single instance only, D13). No oRPC procedure exposes market data yet (S5/S6).

Tests: unit `market-data/{guard,parsing,market-hours,metrics}.test.ts`; integration `market-data/{service,history,metrics,jobs}.int.test.ts`, `db/market-schema.int.test.ts`, and the app-role smoke test runs the quote/nightly jobs with DML only. Shared helpers: `test/market-fixtures.ts` (spy provider, controllable clock).

## Dashboard (S5)

Code: `packages/server/src/dashboard/{repository,compute,service}.ts`, contract `packages/contracts/src/dashboard.ts`. No migration (no schema change: every read is served by the existing primary keys; see "Performance"). Decisions: D4, D5, D6, D9, D20, D21, D22 (`MVP-PLAN.md` section 7).

### Procedures (all `spaceScoped('viewer')`, classified `space`, rows in the IDOR matrix)

Input: `{ spaceId, period }` with `period` in `1w | 1m | 6m | 1y | 5y | max` (Zod enum, same ids as the domain `PERIODS`; a test keeps them equal). Access is resolved BEFORE validation (inaccessible space: `NOT_FOUND`), then a bad `period` is `BAD_REQUEST`. All numbers are decimal strings rounded half-even ONCE at the boundary (money and percentages: 8 decimals), unavailable = `null` (never `"0"`), money `{ amount, currency: 'EUR' }`, dates exchange-local `YYYY-MM-DD`.

- `dashboard.summary({ spaceId, period })`: `total` (Money, `amount` null when nothing is valued), `isComplete`, `missing[] { positionId, name, reason }` (D5 partial total + warning; reasons `price_missing | price_invalid | fx_missing | currency_invalid | quantity_invalid`), `heldCount` / `valuedCount` / `watchlistCount`, `change` (`fromDate`, `baseDate`, `toDate`, `startValue`, `endValue`, `change`, `changePct`; `null` with fewer than two complete points) derived from the SAME series as `history` (historical FX), `leadingMissing[]`, `invalidPositions[]`, `freshness { asOf, fxAsOf, isStale, stalePositions[], staleFx[] }`, `fxRates[] { currency, ratePerEur, date }` used for the total.
- `dashboard.history({ spaceId, period, fxMode? })`: `points[] { date, value|null, evolutionPct|null, dataDate|null, fxRates[] }` (at most 400, downsampled by the domain after trimming; first and last kept), `totalPoints`, `headline` (same shape as `summary.change`), `leadingMissing[] { positionId, name }` (D20: "pas de donnee avant la creation de X"), `invalidPositions[]`, `asOf`, `currency`, `basis: 'current_quantities_past_prices'`, `label: 'valeur des positions actuelles'` (D6; render "... depuis le <headline.baseDate>", baseDate is the real trading day, fromDate may be a weekend target), `fxMode`, `fxLabel` (`null` or `'au taux de change actuel'`), `currentFxRates` (`current` mode only).
- `dashboard.movers({ spaceId, period })`: `gainers[]` / `losers[]` (5 each, best/worst first): `positionId, instrumentId, name, symbol, exchange { mic, name }, performancePct, baseDate, asOf, currency` (raw listing currency, D4: performance is in LOCAL currency). Source: `listing_metrics.perf_<period>` of the listing chosen per space position; null, zero and ties handled by the domain `computeMovers` (ties: name case-insensitive, then name, then id); watchlist entries are included (D9).

### FX mode (D22, history only)

`fxMode: 'historical' | 'current'`, default `historical`, Zod-validated (`BAD_REQUEST` otherwise). `historical`: each point is converted at that day's stored rate, forward-filled by the domain within the 10-day history tolerance (closes and FX share it; the metrics use 7 days for FX, `fxToleranceDays`). `current`: every point uses the latest stored rate per currency dated on or before the series end and at most `fxToleranceDays` (7) older; without such a rate the currency's positions are missing on every day (empty series, `leadingMissing` names them), never a rate of 1. Each point's `fxRates[] { currency, ratePerEur, eurPerUnit, rateDate }` is the rate actually applied (tooltip; `eurPerUnit` = 1 / rate, the specs 34 direction "USD/EUR : 0,85", 8 decimals, display only). A GBX position is reported with its GBP rate (minor-unit note is the UI's). In `current` mode `rateDate` is the real date of the current rate. The FX decision lives in ONE function (`historyFx` in `compute.ts`, with `readHistoryFx` in `service.ts`). The summary total always uses the latest rate; movers are local currency.

### Data path (no provider call on the request path)

Every read is PostgreSQL only, inside one read-only REPEATABLE READ transaction (positions, closes and FX describe one snapshot): positions + `listing_metrics` in one LEFT JOIN, closes of the HELD positions through `space_positions` (watchlist entries never enter value or series; only closes in the listing's current currency), FX for the held major currencies. Why not `MarketDataService`: see `MARKET-DATA.md` "What S5/S6 need". Current value = `listing_metrics.price` (D21 end price, raw currency) x the newest stored rate per currency in `[asOf - 7 days, asOf]` (`asOf` = newest end-price date among the held positions), through `computeSpaceValue`. The headline delta comes from the history series (closes only) and can therefore differ slightly from `total` minus the start value when the end price is a same-day quote (D21). `missing` is per position, the total is partial (never 0, `null` when nothing is valued).

Freshness: a price older than 5 calendar days (weekend plus one holiday) or a rate older than 7 days versus the current UTC date is stale. `asOf` is the OLDEST valued price date, `fxAsOf` the oldest rate used. Nothing is ever labelled realtime.

History window: from `target - 10 days` (base close tolerance) to the series end; `max` reads the whole stored history of the held listings (25 years x 50 positions is the worst case: about 0.6 s, see Performance). With no `listing_metrics` row for any held position there is no series end: empty series, no `leadingMissing`.

### Performance (measured, test DB, in-process HTTP handler incl. auth, 50 positions, daily data)

| stored history | period | summary | history | movers |
| --- | --- | --- | --- | --- |
| 6 years | 1m / 1y / 5y / max | 11 / 50 / 155 / 175 ms | 10 / 50 / 154 / 178 ms | 2-3 ms |
| 25 years | 1m / 1y / 5y / max | 13 / 57 / 165 / 606 ms | 11 / 61 / 173 / 607 ms | 3 ms |

The time is decimal arithmetic in the domain (closes are read in about 45 ms for 5 years), not SQL. `summary` recomputes the series (it needs the headline), so a page calling both `summary` and `history` pays it twice; a server-side memo was deliberately not added (correctness of invalidation vs a small gain). Latest/first-close reads (REVIEW-S4 R1) use `JOIN LATERAL ... LIMIT 1`: one backward index probe per listing (`EXPLAIN`: `Index Scan Backward using price_daily_listing_id_trade_date_pk`, 4 buffers per listing).

### What the frontend should call (TanStack Query, specs 28)

```ts
const key = (name: string, spaceId: string, period: Period, extra?: object) =>
  ['dashboard', name, spaceId, period, ...(extra ? [extra] : [])];
// portfolio-value   -> orpc.dashboard.summary({ spaceId, period })             staleTime 60 s
// portfolio-history -> orpc.dashboard.history({ spaceId, period, fxMode })     staleTime 5 min, key includes fxMode
// top-gainers/losers-> orpc.dashboard.movers({ spaceId, period })              staleTime 5 min (one call feeds both blocks)
```

Suggested keys: `['dashboard','summary',spaceId,period]`, `['dashboard','history',spaceId,period,fxMode]`, `['dashboard','movers',spaceId,period]`. Period lives in the URL and drives all three; `fxMode` is a chart-local toggle (default `historical`). A refetch reads Postgres only. Rendering rules: `null` -> `—` (never 0); show a warning listing `missing[]` when `isComplete` is false ("total partiel"); when `freshness.isStale` say which positions/rates are old; label the chart "valeur des positions actuelles depuis le <headline.baseDate>" (+ `fxLabel` when set) and, when `leadingMissing` is not empty, "pas de donnee avant la creation de <names>"; an empty chart with `invalidPositions` or `leadingMissing` must say why; tooltip = `date`, `value`, `evolutionPct`, plus `fxRates` ("USD/EUR : 0,85" from `eurPerUnit`); a gap day (`value: null`) is a gap, not 0; a mover row links to the instrument (S9). Use `@waddlers/contracts` types (`DashboardSummaryOutput`, `DashboardHistoryOutput`, `DashboardMoversOutput`), never redefine them.

### Tests (S5)

Unit `dashboard/compute.test.ts` (hand-computed EUR/USD/GBX fixtures, missing FX/price, watchlist, stale flags, every period window over 6 years of weekdays, D20 trimming, movers ordering/ties/nulls, FX modes). Domain: applied-rate and downsampling-equivalence tests in `history.test.ts`. Integration `dashboard/dashboard.int.test.ts` (exact strings through the real RPC handler, every period, FX modes, validation, no `fetch`/provider, module import scan, bounded space-scoped reads) and the three procedures in `spaces/idor-matrix.int.test.ts`.
