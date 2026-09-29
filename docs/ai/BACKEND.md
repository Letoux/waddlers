# Backend conventions (S1, auth added in S2)

## Environment

Server env is validated with Zod in `packages/server/src/env.ts`, parsed lazily on first `getEnv()` (so `next build` needs no database). Required: `DATABASE_URL` (runtime, **app role**), `APP_ORIGIN`, `MARKET_DATA_PROVIDER` (`fake` | `eodhd`); `NODE_ENV` defaults to `development`. Optional: `TRUSTED_PROXY_HEADER` (`x-forwarded-for` | `x-real-ip`, empty = unset). In production `APP_ORIGIN` must be https (or localhost): the session cookie is `Secure`. Script-only variables (not in the web env schema): `DATABASE_MIGRATE_URL` (owner; falls back to `DATABASE_URL`), `APP_DB_PASSWORD`, `SEED_USER_USERNAME`/`SEED_USER_PASSWORD`. The `db:*`, `admin` and `db:seed` scripts load the root `.env` via `tsx --env-file-if-exists=../../.env` (process env wins). Validation errors name the variable but never print its value. Secrets never use a `NEXT_PUBLIC_` prefix. `apps/web/next.config.ts` loads the root `.env` for local dev (process env wins).

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
- **Unknown client IP** (`TRUSTED_PROXY_HEADER` unset, the default): every client looks the same, so a pair limit would let anonymous failures lock a user out for everyone. Only a per-username **progressive delay** applies: 5 free attempts, then a wait of 2 s doubling up to 60 s (resets after a success or 15 idle minutes). A victim is therefore delayed by at most 60 s, and an attacker is capped at about one guess per minute per username.
- `changePassword` has its own budget per user (wrong current password; stolen-session guessing), same mechanics.
- Throttled responses are the typed error `TOO_MANY_REQUESTS` with `data: { retryAfterSeconds }` plus a `Retry-After` header.
- Limiter memory is bounded (soft cap on keys); only non-blocking keys are ever evicted.

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

The password is read only from the hidden prompt or stdin, never argv (extra arguments, including `--password`, are refused) and never from the environment. Uses `DATABASE_URL` (app role). `pnpm db:seed` creates `SEED_USER_USERNAME` (default `dev`) with `SEED_USER_PASSWORD` if absent (existing users are untouched), and exits non-zero when `NODE_ENV=production`, or when `APP_ORIGIN` is not localhost unless `ALLOW_DEV_SEED=1`. Spaces (`space:create`, `space:grant`) arrive in S3.

### What the frontend should call

- Browser: `rpc.auth.login({ username, password })` (returns `{ user }`, sets the cookie), `rpc.auth.me()` (401 = signed out), `rpc.auth.logout()`, `rpc.auth.changePassword({ currentPassword, newPassword })` (returns `{ user }`, cookie rotated). TanStack helpers: `orpc.auth.me.queryOptions()`, `orpc.auth.login.mutationOptions()`. Reuse `loginInputSchema`, `changePasswordInputSchema`, `newPasswordSchema` from `@waddlers/contracts` for forms; error codes are documented on the contract.
- Route guard (server component/layout): `const user = await getCurrentUser(); if (!user) redirect('/login')` (from `@/server/auth`). After login/logout do `router.refresh()` and clear the TanStack Query cache.
- Never show "user not found" vs "wrong password": there is one message, `UNAUTHORIZED`.

### Integration tests

`packages/server/test/auth-harness.ts` drives the real RPC handler with a browser-like request (CSRF header, Origin, Sec-Fetch-Site). Suites: `auth/auth.int.test.ts`, `admin/admin.int.test.ts`, `db/roles.int.test.ts`, `health.int.test.ts`. Unit tests (`pnpm test`, no database): password/token/cookie/rate-limit, guard enumeration, CSRF/body-limit/CORS in `rpc-handler.test.ts`, CLI argument handling, env rules.

### Code layout notes

`auth/users.ts` is the users repository (used by the auth service and the admin module); `AdminError` lives in `admin/errors.ts` (no import cycle between `admin/index.ts` and `admin/cli.ts`/`seed.ts`). Node >= 22.9 is required (`--env-file-if-exists`).
