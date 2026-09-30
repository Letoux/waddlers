# S3 review (2026-09-30)

Independent code review and security audit of commit 0951695 (S3 backend: spaces, positions, authorization core). This file records each finding's status after the S3 backend fix pass. The original review texts are not reproduced; the findings below are the ones handed to the fix pass. Frontend re-audit is pending.

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
- **Frontend re-audit:** pending.
