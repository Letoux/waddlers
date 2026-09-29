# S2 review (2026-09-29)

Independent code review and security audit of commit cc3585b (S2 backend: users, sessions, admin CLI). This file records each finding's status after the S2 fix pass. The full original review texts are not reproduced here. Code-review findings not named in the table: F1 is the same issue as the P1 rate-limit bypass (fixed); F2 (CI `build-e2e` had no database) was fixed by the S2 frontend pass (Postgres service + `e2e/support/global-setup.ts`); F7 (expired sessions only purged per user, unused `expires_at` index) is deferred below; F8 (users repository missing) is fixed (`auth/users.ts`).

## Fixed in the S2 fix pass

| Ref | Sev | Finding | Status |
| --- | --- | --- | --- |
| Review + audit | P1 | Login/changePassword rate limits bypassed by concurrent requests (40 parallel wrong logins, no 429) | **Fixed.** Attempt reserved synchronously after the check, refunded on success. Tests: 40 parallel logins, 30 parallel changePassword, limiter unit tests. |
| Audit | P2 | With `TRUSTED_PROXY_HEADER` unset every IP is `unknown`, so 5 anonymous failures lock a user out for everyone | **Fixed.** Unknown IP: no pair limit, per-username progressive delay (5 free, 2 s doubling to 60 s). BACKEND.md matches the code. |
| Review F3 | P3 | changePassword rotated a possibly revoked session | **Fixed.** `rotateSession` uses `.returning()`, requires unexpired session and `disabled_at IS NULL`; the transaction aborts (password rolled back) with UNAUTHORIZED. Tests. |
| Review F4 | P3 | Login session writes not atomic | **Fixed.** Revoke old, purge, insert in one transaction. |
| Review F5 | P3 | Session-mutating procedures silently lose the session via the server client | **Fixed.** They throw without `resHeaders`, before any side effect. Test. |
| Review F6 | P3 | Several session Set-Cookie headers in one response | **Fixed.** `setSessionCookieHeader` keeps one (last write). Tests: stale refresh + logout, + changePassword. |
| Review F9 | P3 | TOO_MANY_REQUESTS untyped; no Retry-After; English username messages | **Fixed.** Typed error with `data.retryAfterSeconds` in the contract (login, changePassword), `Retry-After` header, French `usernameSchema` messages and corrected doc comment, `sessionOutputSchema` exported. |
| Review F10 | P3 | No test running as the DML-only app role | **Fixed.** `auth/app-role.int.test.ts`: createUser, login, me, changePassword, disableUser. |
| Review F11/F13 | P3 | Leftover `void hashPassword`, `isError ? {} : {}`; engines; countAndRevoke counted before deleting; CLI ignored `cause.code`; opaque migrate permission error | **Fixed** in the backend pass; the apps/web part of F11 (`route.test.ts:56`) is **fixed in frontend pass**. Node engines `>=22.9`; `revokeUserSessions` returns rows deleted; `pgErrorCode` reads `cause`; `db:migrate` hints at `DATABASE_MIGRATE_URL` on 42501. |
| Audit | P3 | Limiter eviction could drop a blocking key | **Fixed.** Only non-blocking keys are evicted (may exceed the soft cap). Tests. |
| Audit | P3 | Two cookie parsers | **Fixed.** `parseSessionCookie` is the single parser. |
| Audit | P3 | Dev seed could run against a non-local database | **Fixed.** Refuses unless `APP_ORIGIN` is localhost or `ALLOW_DEV_SEED=1`. Test. |
| Audit | P3 | Compose published web on all interfaces | **Fixed.** `127.0.0.1:3000:3000`. |
| Review F12 | P3 | First unknown-user login pays the dummy-hash cost (timing) | **Fixed.** Dummy hash warmed at router creation. |
| Review | P3 | Missing tests: expired sessions purged on login; expired session never refreshed | **Fixed.** Tests added. |
| Review | P3 | Users repository extraction; AdminError inside an import cycle | **Fixed** (cheap, server-only): `auth/users.ts`, `admin/errors.ts`. |

## Deferred / accepted

- **Absolute session lifetime and a global expired-session purge job:** sliding expiry has no absolute cap, and only a user's own expired rows are purged (at login). Planned as a worker job (S4+). The `sessions_expires_at_idx` index is kept for that job (it is unused by current queries; drop it if the job is not built).
- **Nonce-based CSP:** `script-src` still allows `'unsafe-inline'` (Next bootstrap). S10.
- **Revoking `TEMP` from `PUBLIC`** on the database (app role can create temp tables): deferred; low impact.
- **SCRAM verifier in `setup-roles`:** the role password is sent as a literal in `ALTER/CREATE ROLE`, visible in server logs if `log_statement` is `ddl`/`all`. Documented in BACKEND.md: keep statement logging off. Precomputing a SCRAM-SHA-256 verifier is a future improvement.
- **`next.config.ts` loads the root `.env` in non-Docker dev:** `apps/web` was off-limits during this pass; documented in BACKEND.md. Revisit with the frontend.
- **Rate limiter is in memory / single instance (D13)** and login attempts are not audit-logged: accepted for the MVP; audit log is an S10 candidate.

## Re-audit / second review

| Ref | Sev | Finding | Status |
| --- | --- | --- | --- |
| P2-a | P2 | Unknown-IP backoff: an attacker polling once a second keeps a username at the 60 s cap forever (victim in 0/488 attempts in a simulated hour) | **Fixed (backend).** Signed device cookies (`__Host-wd_device`, HMAC with new required `AUTH_SECRET`): a login with a valid cookie for that username uses its own per-device budget (5 attempts, 15 min lock for that device only) and bypasses the shared backoff. Tests: victim logs in while the attacker hammers; forged/tampered/other-username cookies are treated as absent; per-device lockout. BACKEND.md no longer claims a bounded lock-out: users on a new browser stay delayed during an attack. |
| P2-b | P2 | Layout guard bypass via RSC navigation | **Frontend pass** (per-page `requireUser`). |
| P3-a | P3 | `safeNextPath` accepted dot-segments | **Frontend pass.** |
| P3-b | P3 | Dev seed could target a remote database | **Fixed (backend).** Also refuses unless `DATABASE_URL` host is local (`localhost`, `127.0.0.1`, `::1`, `postgres`) or `ALLOW_DEV_SEED=1`. Test. |
| P3-c | P3 | E2E database-name guard | **Frontend pass.** |
| P3-d | P3 | CI info: Playwright traces contain throwaway passwords; E2E uses `next start`, not the standalone output | **Accepted / info** (throwaway credentials against an ephemeral database; standalone output is exercised by the Docker build). Owner: frontend/CI. |
| FW1-FW9 | - | Frontend review findings | **Frontend pass.** |
| FX1 | P3 | BACKEND.md integration suite list missing `auth-hardening` and `app-role` | **Fixed.** |
| FX2 | P3 | Evicting non-blocking keys could reset progress | **Fixed.** Eviction order: expired/idle entries, then only entries still under their free attempts (oldest first); entries at a backoff level or at their budget are kept, so junk-key flooding cannot reset an attacked username. Trade-off (soft cap can be exceeded in proportion to attack effort, D13) documented in BACKEND.md and justified by the cost of reaching a level. |

Operational note for P2-a: `AUTH_SECRET` is now required by the web env schema. CI jobs, Playwright's web server env and `apps/web` route tests that stub the env must provide it (see the handoff for exact lines).
