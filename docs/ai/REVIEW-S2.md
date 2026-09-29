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
| Review F11/F13 | P3 | Leftover `void hashPassword`, `isError ? {} : {}`; engines; countAndRevoke counted before deleting; CLI ignored `cause.code`; opaque migrate permission error | **Fixed** (apps/web excluded from this pass). Node engines `>=22.9`; `revokeUserSessions` returns rows deleted; `pgErrorCode` reads `cause`; `db:migrate` hints at `DATABASE_MIGRATE_URL` on 42501. |
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
