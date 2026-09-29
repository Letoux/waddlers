# Backend conventions (S1)

## Environment

Server env is validated with Zod in `packages/server/src/env.ts`, parsed lazily on first `getEnv()` (so `next build` needs no database). Required: `DATABASE_URL`, `APP_ORIGIN`, `MARKET_DATA_PROVIDER` (`fake` | `eodhd`); `NODE_ENV` defaults to `development`. Validation errors name the variable but never print its value. Secrets never use a `NEXT_PUBLIC_` prefix. `apps/web/next.config.ts` loads the root `.env` for local dev (process env wins).

## Migrations (Drizzle)

- Schema: `packages/server/src/db/schema/` (one file per table, re-exported from `index.ts`). Migrations: `packages/server/drizzle/`, committed and reviewed.
- Change the schema, then `pnpm db:generate` (use `-- --custom` for hand-written SQL). Never `drizzle-kit push` outside a throwaway database. Destructive changes need explicit authorization.
- Apply: `DATABASE_URL=... pnpm db:migrate` (programmatic `migrate()`, idempotent). Compose runs it as the one-shot `migrate` service that `web` depends on; CI runs it before integration tests.
- `pnpm db:check` (drizzle-kit check) runs in the CI quality job.
- `0000_init_extensions` enables `citext` and `pg_trgm` (trusted extensions on PostgreSQL 13+; the DB owner may create them).

## Integration tests

`pnpm test:integration` runs `packages/server/**/*.int.test.ts` (vitest project `integration`) against `DATABASE_URL_TEST`, migrating it first via global setup. It is excluded from `pnpm test`, and it fails loudly (not skips) if `DATABASE_URL_TEST` is unset, so CI misconfiguration cannot pass silently. Locally: `docker compose --profile test up -d postgres-test`, then `DATABASE_URL_TEST=postgres://waddlers:waddlers-test@localhost:5433/waddlers_test pnpm test:integration`.

`server-only` throws outside the `react-server` condition, so vitest aliases it to a stub. A future worker run with `tsx` that imports server modules must pass `--conditions react-server` (or avoid `server-only` modules).

## oRPC

Contract-first: schemas and the contract live in `packages/contracts` (browser-safe). Implementations live in `packages/server/src/router.ts` (`implement(contract)`); mounted at `apps/web/app/api/rpc/[[...rest]]/route.ts`. The typed client and TanStack Query helpers are in `apps/web/lib/orpc.ts`.

Security groundwork: the route exports **POST only** (add GET only when a procedure opts into it; Next adds an implicit HEAD when GET is exported, so `createRpcHandler` also answers 405 for any method other than POST/GET, and oRPC's `StrictGetMethodPlugin`, on by default, refuses GET on procedures). Every request needs the `x-csrf-token` header (oRPC simple CSRF plugin, added by the client link). `allowedOrigin` is a **required** `createRpcHandler` option (APP_ORIGIN): a request with a foreign `Origin` gets 403 (missing Origin is allowed; the CSRF header still applies). The custom 403/405 bodies are oRPC-encoded (`{ json: <ORPCError json> }`) so RPCLink decodes them as typed `ORPCError`s (covered by an in-process client test). Every RPC response, including 403/404/405, carries `Cache-Control: no-store`. Session cookies and authn/z arrive in S2.

## Error-mapping policy (specs section 36)

Technical errors are never exposed. `packages/server/src/errors.ts` wraps every procedure call: an `ORPCError` passes through unchanged (procedures throw these deliberately: `NOT_FOUND`, `UNAUTHORIZED`, ...); any other error is logged server-side and replaced by `INTERNAL_SERVER_ERROR` with the neutral message `Internal server error` (no stack, SQL, driver text, no `cause`). The UI maps error codes to user-facing French messages. Dependency failures in `health` are reported as `db: 'unavailable'` (HTTP 200, `status: 'degraded'`) with no detail.

## Logging policy

All server error logs go through `describeError()` (`errors.ts`): error `name`, SQLSTATE/system `code`, `constraint_name`, `severity`, Drizzle `query` (placeholders only) and the stack frames, walking `cause` at most two levels. It never logs `message` (Drizzle embeds params in it), `params` or Postgres `detail` (row values). `ORPCError`s with status >= 500 (e.g. output validation) are logged and passed through unchanged. Loggers are injectable (`log` in `createRpcHandler` / `RouterDeps`) so tests need no console spies.

## Route tests

`apps/web/**/*.test.ts` run in the vitest project `web` (part of `pnpm test`): the Next route module is imported directly with stubbed env (unreachable DB) to assert Origin, method exports and 404 behaviour.
