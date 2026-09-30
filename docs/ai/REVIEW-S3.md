# S3 review (2026-09-30)

Independent code review and security audit of commit 0951695 (S3 backend: spaces, positions, authorization core). This file records each finding's status after the S3 backend fix pass. The original review texts are not reproduced; the findings below are the ones handed to the fix pass. The frontend review and audit of ead2f83 are recorded in the last section.

## Fixed in the S3 fix pass

| Ref | Sev | Finding | Status |
| --- | --- | --- | --- |
| Audit | P2 | Dev seed could attach members and positions to a pre-existing real space, and grant memberships to a pre-existing user | **Fixed.** Only spaces created by the run are filled (`insert ... returning`), grants only to a user created by the run, one transaction per space. Tests: pre-existing "PEA" untouched, pre-existing dev-named user gets nothing, re-run resurrects nothing. |
| Review | P2 | `positions.list` contract not forward-compatible with S6 (fixed cap, `truncated`) | **Fixed.** `page { offset, limit }`, output `{ rows, total, hasMore }`, rows and total in one REPEATABLE READ read-only transaction. `asOf` planned for S4/S6. Tests: pagination, hasMore, defaults. |
| Audit | P3 | Race between the access check and the write (revoked/downgraded member could still write) | **Fixed.** UPDATE/DELETE carry an `EXISTS` writer-role guard on membership; nothing affected = `NOT_FOUND`. Tests call the repositories after revoking/downgrading. |
| Audit | P3 | IDOR enumeration guard blind spots | **Fixed.** Every contract path must be classified public/user/space; deep JSON-Schema key search for `/space\|position/i`; matrix must equal the space-classified set. |
| Audit | P3 | `AuthorizedSpace` brand forgeable by a cast; `operatorSpaceAccess` importable anywhere | **Fixed.** ESLint `no-restricted-syntax` and `no-restricted-imports` (probed: both fire). |
| Audit | P3 | UUID case not normalised in the minted access | **Fixed.** Lower-cased, tested (also through RPC). |
| Review | P3 | `position:add <space> <listing> ""` created a watchlist entry; `ARITY[command]` on prototype keys | **Fixed.** Branch on argument count; `Object.hasOwn`. Tests. |
| Review | P3 | Hand-written correlated count SQL, `as SpaceSummaryRow[]` cast, raw `sql` WHERE clauses | **Fixed.** Grouped Drizzle subquery + left join + `coalesce`; `and(eq(), eq())`. |
| Review | P3 | Loose DB constraints (currency spellings, blank names, redundant FK/index) | **Fixed** by migration 0003 (see BACKEND.md); currency check kept in sync with the domain by a test. |
| Review | P3 | Test quality (updated_at not proven, provider-id duplicate untested, instrument count `>=`, readSecret stub, ordering, whole-table filtering in fixtures) | **Fixed.** |

## Deferred / accepted

- **Row-level security as defence in depth:** authorization is enforced in the application (branded type, in-statement guard, IDOR matrix). PostgreSQL RLS with a per-request setting would be a second layer; deferred (needs per-request transactions/roles).
- **S7:** `table_configs` must reference `space_members` with `ON DELETE CASCADE` so a revoked member's configuration disappears.
- **S4:** market-data tables must reference `listings` with `ON DELETE CASCADE`.
- **S4/S6:** `pg_trgm` indexes for search (the extension is already enabled).
- **`btrim` blank check** only strips spaces (a tab-only name passes); accepted, names are admin-supplied.

## Frontend review / audit (ead2f83)

Code review: approved with changes. Security audit: approved with follow-ups. Status after the frontend fix pass (no commit yet):

| # | Ref | Sev | Finding | Status |
| --- | --- | --- | --- | --- |
| 1 | Review | P2 | Mutating E2E tests not retryable (`--repeat-each=2` failed) | **Fixed.** Each scenario creates its own user, spaces and positions in the test (`e2e/support/fixtures.ts`, random names); invalid-input has its own user. `playwright test e2e/spaces.spec.ts --repeat-each=3` passes. |
| 2 | Review / Audit F1 | P2 | Optimistic-update races (whole-list snapshot, several edits, refetch during writes) | **Fixed.** `set-quantity.ts`: per-position `scope`, row-only rollback guarded by the optimistic value and "alone" check, fallback to last confirmed value, invalidate only when no other write is in flight (mutation `meta`). Removal is not optimistic; its invalidation uses the same gate. Vitest with a real QueryClient: success, rollback, overlapping first-fails, both fail, shared value, refetched value, null, independent rows. |
| 3 | Review | P2 | Revoked space shows a stale list, edits silently revert | **Fixed.** NOT_FOUND on the list query renders "Espace indisponible" (link to /espaces) even with cached rows; other refetch errors keep the data with a "Données non actualisées." banner and Réessayer. Definitive errors are no longer retried (`query-retry.ts`). E2E for both. |
| 4 | Review | P2 | Focus stolen back to the field on blur | **Fixed.** Only Enter refocuses; on blur the message stays visible. E2E: invalid, Tab moves focus on. |
| 5 | Review | P2 | State machine untested | **Fixed.** Vitest (above) plus Playwright: forced 500 (old value, French toast), FORBIDDEN after a CLI downgrade, revoked space, failed refresh banner. |
| 6 | Review | P3 | fr-FR parser leniency | **Fixed.** Canonical form (`5,0` is `5`, no-op skips write and toast); spaces only as thousands groups (`1 2 3` rejected); `1.234` rejected with a French hint (`0.123` accepted). Tests. |
| 7 | Review | P3 | Invisible U+202F literals in source | **Fixed.** Written as the `\u202f` escape in `quantity.ts`, its test and the spec. |
| 8 | Review | P3 | Duplicate live-region/toast announcement | **Fixed.** The status region says "Quantité de <titre> mise à jour."; the toast keeps the specified "Quantité mise à jour.". |
| 9 | Review | P3 | English seed selection reasons | **Fixed** in `seed.ts` (strings only), documented as stored in French. Existing dev/test rows keep English text: the seed never overwrites. |
| 10 | Review | P3 | Dialog default "Close"; counts via quantity formatter | **Fixed.** "Fermer"; `toLocaleString('fr-FR')` for counts (dashboard, Espaces). |
| 11 | Review | P3 | Removal focus | **Fixed.** List region has `role="region"`; `onRemoved` runs from the mutation `onSuccess` after closing. E2E asserts the region is focused. |
| 12 | Review | P3 | Header nav / stale list | **Fixed.** Nav follows the URL space when known; `spaces.list` refetched once when the URL space is missing from it. |
| 13 | Review | P3 | Several `setActive` callers, no pending state | **Fixed.** `ActivateSpace` is the only caller; the selector navigates in `useTransition` (disabled and `aria-busy`). |
| 14 | Review | P3 | Table semantics lost with responsive `display` | **Fixed.** Explicit `role` attributes on table, rowgroups, rows, headers, cells. |
| 15 | Review | P3 | Loose space-id regex in global setup | **Fixed.** Anchored `/^Space created: .* \(([0-9a-f-]{36})\)$/m` (now in the fixture). |
| 16 | Audit F3 | P3 | `decodeURIComponent` can throw in `parseSpacePath` | **Fixed** (try/catch, null; unit test). Note: Next itself answers `/s/<malformed %>` with a plain 500 before app code runs; nothing is exposed; documented, not fixable in the app. |
| 16 | Audit F2 | P3 | Space not-found returned HTTP 200 (streamed 404 fallback) because of `loading.tsx` | **Fixed.** `(app)/loading.tsx` removed (the positions list has its own skeleton); unknown/inaccessible spaces now answer a real 404, asserted in e2e. |
| 17 | Audit F4 | P3 | `CI=1` relaxes the safe-database host check in E2E global setup | **Accepted.** The database name must still match `(^|_)test($|_)`; CI provides its own throwaway Postgres. |
