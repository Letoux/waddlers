# S1 review (2026-09-29)

Independent review of commit "Add database and typed API skeleton (S1)" by code-reviewer, security-auditor and coverage-analyst. Verdict: no P0/P1 defects; approve with follow-ups.

## Fixed in the S1 fix pass

Status of each item is tracked in the fix-pass commit message.

1. P2 — Error log wrote Drizzle query params (future secrets/PII). Sanitised `describeError()` used for all server logs.
2. P3 — Route exported PUT/PATCH/DELETE (and implicit HEAD) reaching procedures. POST only.
3. P3 — Origin check was opt-in. Now required.
4. P3 — Origin-check 403 was not oRPC-encoded.
5. P3 — `ORPCError` with status ≥ 500 (e.g. output validation) was not logged.
6. P3 — Health check logged only `error.name`.
7. P3 — `StrictGetMethodPlugin` registered twice (already on by default).
8. P3 — No `Cache-Control: no-store` on RPC responses.
- Tests: interceptor wiring (P1), route-level Origin/method/404 (P1), GET 405, health timeout, integration test env isolation.
- Housekeeping: dev-only DB pool cached on `globalThis`; `.dockerignore` `**/.env*`; Next-generated `apps/web/AGENTS.md`/`CLAUDE.md` ignored.

## Must be handled in S2 (auth) — mandatory checklist

Status after the S2 backend pass (details in `docs/ai/BACKEND.md`, "Authentication (S2)"):

- **DB roles (P2): DONE.** Owner vs DML-only `waddlers_app` (`db/roles.ts`, `pnpm db:setup-roles`), separate `DATABASE_MIGRATE_URL`; Compose `migrate` runs setup then migrations; integration test proves no DDL/TRUNCATE/migration-schema access.
- **CSRF invariants (P2): DONE.** No CORS (tested incl. preflight), fail closed on cookie without Origin/Sec-Fetch-Site, `Sec-Fetch-Site` must be `same-origin`, auth procedures use the same handler; unit + integration tests.
- **Server-side client (P2): DONE.** `createServerClient` (`createRouterClient`) + `apps/web/server/{orpc,auth}.ts` (`getCurrentUser`); `apps/web/lib/orpc.ts` is browser-only and no longer hard-codes localhost:3000.
- **Body size limit (P2): DONE.** `BodyLimitPlugin` 1 MB, 413 test (unit) and verified with curl.
- **Schema drift in CI (P2): DONE.** `db:generate` + fail on any change or untracked file under `packages/server/drizzle`.
- **oRPC context: DONE.** `$context<RpcContext>()`, `ResponseHeadersPlugin`.
- **Health (P3): DONE.** Public `health` is liveness-only (no DB state, so no rate limit or log needed); DB probe moved to authenticated `systemStatus` with a throttled log line. Rate-limiting anonymous `health` itself is deferred (no expensive work; reverse-proxy concern).
- **HTTP headers (P3): DONE, with a gap.** All listed headers set and tested; CSP keeps `script-src 'unsafe-inline'` (Next inline bootstrap). Nonce-based CSP deferred to S10.
- **Docker (P3): DONE.** `web` gets an explicit env allow-list; `migrate` stage non-root (verified: `uid=1000`, run against the dev DB); URL-safe DB passwords enforced by `setup-roles`.

## Deferred / accepted

- Validation `BAD_REQUEST` returns Zod issue metadata (no input values in Zod 4). UI must never render `message`/`issues` raw; revisit if custom refinements echo values.
- Bare `vitest` (without `pnpm test`) fails when `DATABASE_URL_TEST` is unset — intentional fail-loud; use `pnpm test` / `pnpm test:integration`.
- Dev-only advisory GHSA-67mh-4wv8-2f99 (esbuild via drizzle-kit) — not reachable; watch for drizzle-kit update.
- Not yet verified: client bundle analysis for server-code leakage; Docker/Compose `migrate` service at runtime.
