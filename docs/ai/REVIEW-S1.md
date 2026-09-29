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

- **DB roles (P2):** split superuser into a migration/owner role and an app role with DML only; separate `DATABASE_URL`s for `migrate` and `web`.
- **CSRF invariants for cookie sessions (P2):** never enable CORS / `Access-Control-Allow-Credentials`; fail closed when a session cookie is present but both `Origin` and `Sec-Fetch-Site` are missing; login/logout/change-password go through the same RPC handler (no separate route/server action/form POST); tests for each.
- **Server-side client (P2):** SSR/RSC must use `createRouterClient(router, { context })` under `apps/web/server/**`; `apps/web/lib/orpc.ts` stays browser-only (no hard-coded `localhost:3000`).
- **Body size limit (P2):** `BodyLimitPlugin` (~1 MB) + 413 test before `auth.login`.
- **Schema drift in CI (P2):** `db:generate` + `git diff --exit-code packages/server/drizzle` after `db:check`.
- **oRPC context:** `implement(contract).$context<{ headers: Headers; resHeaders?: Headers }>()`; `ResponseHeadersPlugin` for `Set-Cookie`.
- **Health (P3):** public endpoint liveness-only or restricted; rate-limit; throttle its log line.
- **HTTP headers (P3):** `poweredByHeader: false`, CSP / `frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy`, HSTS.
- **Docker (P3):** `web` gets only needed env (not the whole `.env`); `migrate` stage non-root; URL-safe/encoded DB password.

## Deferred / accepted

- Validation `BAD_REQUEST` returns Zod issue metadata (no input values in Zod 4). UI must never render `message`/`issues` raw; revisit if custom refinements echo values.
- Bare `vitest` (without `pnpm test`) fails when `DATABASE_URL_TEST` is unset — intentional fail-loud; use `pnpm test` / `pnpm test:integration`.
- Dev-only advisory GHSA-67mh-4wv8-2f99 (esbuild via drizzle-kit) — not reachable; watch for drizzle-kit update.
- Not yet verified: client bundle analysis for server-code leakage; Docker/Compose `migrate` service at runtime.
