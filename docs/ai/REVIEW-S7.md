# S7 review (2026-10-02)

Independent code review and security audit of commit fed0a54 (S7 backend: filters, facets, per-user table config). This file records each finding's status after the S7 backend fix pass. As for S3 to S6, the original review texts are not reproduced: the findings below are the ones handed to the fix pass (`Review P<n>` for the code review, `Audit F<n>` for the security audit). Decision recorded with this pass: **D28** (currency in filters and facets), `MVP-PLAN.md` section 7. The fix pass is uncommitted; the frontend (separate pass) consumes the `truncated` field and the notes below.

## Code review

| Ref | Sev | Finding | Status |
| --- | --- | --- | --- |
| Review P2-1 | P2 | The `currency` filter and facet used the RAW currency while the search used the major one: `GBP` found a GBX listing in the search but not in the filter | **Fixed (D28).** The `currency` filter compares `majorCurrencyOf(listings.currency)` (the SQL the search uses; `ColumnSql.filter`), nulls excluded; the Devise cell keeps the raw spelling. `^[A-Z]{3}$` kept for filter values (so the raw `GBX` is well-formed and matches nothing, tested). A config saved with `GBX` is rewritten to `GBP` on read. |
| Review P2-2 | P2 | A facet value could not always be sent back as a filter (raw `GBp`/`ZAc` fail `^[A-Z]{3}$`: a 400 from the UI's own choices) | **Fixed (D28).** The currency facet groups by major currency (`GBP`, `ZAR`), the exact value the filter compares; label `GBP` or `GBP (cotations en pence incluses)` when minor-unit listings are grouped in it. Test `table-facets.int.test.ts`: every value of every facet, sent back as an `in` filter, returns 200 and exactly its count, on the dataset and with GBX, GBp and ZAc listings added. |
| Review P2-3 | P2 | Facets describe the current positions: a saved filter on a value that no longer exists is invisible in the choices yet hides every row; a facet cut at 200 values was silent | **Fixed.** `positions.facets` returns `truncated: { instrument_type, sector, currency, exchange }` (the query asks for 201). Documented in `BACKEND.md` (and the contract) that the UI must MERGE the active filter values into the choices (the frontend has been told). Test: save a sector filter, remove the position: the facets no longer list the value and `positions.list` with the filter returns `total: 0`. |
| Review P3-1 | P3 | `version` was written but never read: no dispatch for an older or newer stored document | **Fixed.** `version` is selected; `migrateTableConfig(raw, version)` runs a step chain (`STEPS[v]`, v to v+1) then the V1 normaliser and always yields the current shape. A stored version above the current is read best-effort and `save` refuses it with a typed `CONFLICT` (409, declared in the contract; atomic in SQL: `ON CONFLICT DO UPDATE ... WHERE version < current or (version = current and document differs)`). Unit tests for versions 0, 2, 99 and nonsense; integration test for the 409 (row untouched). |
| Review P3-2 | P3 | The comment and doc justified the 12 000-byte save bound as room for migrate-on-read | **Fixed.** Comment and `BACKEND.md` corrected: migration runs in memory, the margin is jsonb overhead (measured at about 750 bytes) plus headroom against the 16 384-byte `pg_column_size` CHECK. Integration test: the largest valid config (multibyte sector values just under 12 000 bytes) saves with 200, the row exists, its `pg_column_size` fits the CHECK; one byte over is a BAD_REQUEST. |
| Review P3-3 | P3 | Filters compared full-precision SQL values while cells show an 8-decimal value, and a `price_eur` shown as `rounds_to_zero` could still match a range | **Fixed.** `between` compares `wire8Sql(expr)`: 8 decimals half-even (PostgreSQL `round` is half away from zero, so ties are rewritten as `2 * round(n / 2)`), identical to the cells; a `price_eur` that rounds to zero is NULL for filters (a tracked value of 0 stays a real 0). Documented. Tests (`table-filters-wire.int.test.ts`): 9.996 vs a minimum of 10 is excluded and vs a maximum of 9.996 included; 29.99999999 CHF at rate 3 shows `10` and matches `[10, 10]`; a half-even tie (0.5 x 0.00000001 shows `0`) follows the cell (checked to fail with a wrong tie rule); rounds-to-zero excluded even by `[-1, 1]`. |
| Review P3-4 | P3 | Not handed to this fix pass | **Not in the brief.** No change was made under this reference. |
| Review P3-5 | P3 | `save` re-read after the write: under two racing saves a response could show the other request's config; last-write-wins was undocumented | **Fixed.** `insert ... returning config`, migrated: each response is its own write. Last write wins is documented. Test: two parallel saves give one row, equal to one of the inputs, and each response equals its own input. |
| Review P3-6 | P3 | A saved `perf_period` filter follows the URL period, not the period it was saved under | **Documented.** `BACKEND.md` says so; the UI chip shows the period it applies to (the frontend has been told). Behaviour unchanged by design (`perf_period` follows the request `period`). |
| Review P3-7 | P3 | The page and totals queries built their context separately, and totals always joined the FX CTE | **Fixed.** One `tableContext(db, space, period)` used by both. Totals join the FX rates only when a money filter is present (`filtersNeedFx`; a unit test checks `FX_FILTER_COLUMNS` against the real SQL of every filterable column). Latency re-measured at 5 000 rows: 3 combined filters 19 ms (was 16), money filters + search + sort 44 ms (was 36), facets 17 ms (was 16); budget 300 ms. |
| Review P3-8 | P3 | Dead fixtures in the migration test and test gaps | **Fixed.** The unused fixtures in `table-config-migrate.test.ts` are removed. Added: facets after `positions.remove` and after an add (a quantity change leaves them unchanged); an explicit filter on a column absent from `columns`; `computedAt`/`oldestComputedAt` under filters (matching rows only, null when none); `isDefault: false` when the saved config equals the defaults. |
| Review P3-9 | P3 | The specs 21 valuation, debt and dividend filters are not available | **Documented, planned for S8.** `MVP-PLAN.md` S7 and S8 rows: those filters ship with S8 (flip `filterable`, add the `columnSql` mapping and tests); they are `filterable: false` until the data exists, so no filter can silently hide every row. |

## Security audit

| Ref | Sev | Finding | Status |
| --- | --- | --- | --- |
| Audit F1 | - | A lone UTF-16 surrogate in a filter value or the search survived validation and made PostgreSQL fail on invalid UTF-8 (a 500) | **Fixed.** `isStorableText` (NUL and lone surrogates, regex-based, `packages/contracts/src/text.ts`) is applied to the filter `valueSchema` and to the search input. `saveTableConfig` maps SQLSTATE 22P02 and 22P05 to BAD_REQUEST as defence in depth. Tests: schema unit tests (filter value, search, saved config), integration tests on `tableConfig.save` (400, nothing written) and `positions.list` (filter and search, 400; a real surrogate pair is accepted), test of the SQLSTATE mapping with a stub db (in `table-config-hardening.int.test.ts`, the authorized space coming from `requireSpaceAccess`). |
| Audit F2 | - | `positions.facets` had no admission control and `tableConfig.save` no rate limit or write de-duplication | **Fixed.** `positions.facets`: per-user in-flight cap of 4, unrated, through the shared limiter (own counter), typed 429 after the access check. `tableConfig.save`: its own per-user token bucket (30 a minute, burst 10; `DashboardLimiter` gained a `burst` option, unit-tested), typed 429 with `retryAfterSeconds` and `Retry-After`, per user, after the access check; reads and the table are unaffected. An identical document is not written (`WHERE ... IS DISTINCT FROM excluded.config`: no new tuple, `updated_at` kept; tested through `xmin`). |
| Audit F3 | - | The IDOR matrix lacked a user who belongs to two spaces | **Fixed.** `idor-matrix.int.test.ts`: a member of A and B saves in A, then `get(B).isDefault === true`, a reset in B leaves A's view, and the only row is keyed to A. Mutation M3 (dropping `space_id` from the `get` predicate) was applied: the new test fails (`expected false to be true`), the existing matrix did not catch it; the mutation was reverted. |
| Audit F4 | - | Filter currency values and facet values disagreed (raw versus major) | **Fixed with Review P2-1 / P2-2 (D28).** |

## Re-review / frontend review / audit (e60de8d)

Second pass after the S7 frontend commit (e60de8d). As above, the original texts are not reproduced; refs are the ones handed to the fix pass. The fix pass is uncommitted.

### Backend re-review

All earlier findings are fixed. Two small ones remained:

| Ref | Finding | Status |
| --- | --- | --- |
| Review F-B1 | `save` answered the document as sent (`GBX`) while `get` rewrote it to `GBP` on read, so the client cache differed from the stored row | **Fixed.** The save path applies the same D28 rewrite (`withMajorCurrencyFilters`): the row stores `GBP`, the response is the stored document. Tests: `table-config-migrate.test.ts`, `table-config.int.test.ts`. |
| Review F-B2 | The currency facet label said "pence" for ZAR too | **Fixed.** `GBP (cotations en pence incluses)`, `ZAR (cotations en cents incluses)`. Test: `table-facets.int.test.ts`. |

### Frontend review

| Ref | Finding | Status |
| --- | --- | --- |
| Review F-F1 | `confirmed` was shared across spaces: a failed save in B could restore A's config | **Fixed.** `TableConfigSession` per `spaceId` (instance field), `<PositionsTable key={spaceId}>`. `config-session.test.ts` simulates the switch on one shared cache (no DOM test environment in the repo, so the hook is not rendered; the hook only builds the session in `useMemo([spaceId])`). |
| Review F-F2 | A reset could race the save in flight and drop or keep the wrong edits | **Fixed.** Reset cancels the waiting edit, holds the saver, awaits the save in flight, resets, then replays only the edits made after the click (generation counter). Fake-timer test in `config-session.test.ts`; `hold`/`idle` tests in `config-saver.test.ts`. |
| Review F-F3 | An invalid filter bound could show the quantity message | **Fixed.** `parseBound` always answers `BOUND_INVALID`. Test in `filter-form.test.ts`. |
| Review F-F4 | A merged active value was labelled "(absent)" even while the facets loaded, failed or were truncated; checkbox ids embedded free text | **Fixed.** `mergeFacetOptions(..., { loaded, truncated })`: count `0` ("absent") only when loaded and not truncated, otherwise no count; ids are `useId()` plus the index. Unit tests. |
| Review F-F5 | Keyboard reorder lost focus (the button became disabled) and nothing was announced | **Fixed.** Focus returns to the moved item's button (the other one at an end of the list); `aria-live` "X déplacée en position n". E2E "move a column down". |
| Review F-F6 | Hiding the sorted column kept the sort (config and `?tri=`) | **Fixed.** `toggleColumn` drops the saved sort; the view clears `?tri=` (`isSortHidden`). Unit tests. |
| Review F-F7 | E2E waits for a save could be satisfied by an earlier save (flaky) | **Fixed.** `configSaved(page, match)` matches the request body (full config) and is registered before the last edit. Spec run with `--repeat-each=3`. |
| Review F-F8 | The `pagehide` flush could be cancelled by the browser | **Fixed.** That flush uses a `keepalive: true` client (`rpcKeepalive`); a save already in flight is awaited, not duplicated. Unit test of the flag. Still best effort (64 KB limit, not verifiable in E2E). |

### Security audit

| Ref | Sev | Finding | Status |
| --- | --- | --- | --- |
| Audit F5 (P3-1) | P3 | Logout with an unsaved edit: the save left after the session ended (UNAUTHORIZED toast on /login, edit lost) | **Fixed.** The logout mutation awaits `flushPendingSaves()` (registry, bounded at 1 s) BEFORE `auth.logout`, then `haltPendingSaves()`; an UNAUTHORIZED save error never toasts nor writes the cache. Unit tests (`save-registry`, `config-session`) and E2E "logout right after an edit". |
| Audit F6 (P3-2) | P3 | Another tab kept showing (and saving) the previous session's data after a login or logout | **Fixed.** `session-sync.ts`: `BroadcastChannel('waddlers-auth')`, `storage` event fallback; other tabs halt their savers, clear the cache and reload. Handler and broadcast unit-tested; not covered by E2E (multi-page), not verified in a real browser. The user id is not in the `tableConfig.get` key (not cheap with the oRPC key helper); the clear-and-reload covers it. |
| Audit F7 (P3-3) | P3 | `sanitizeSearch` could cut a surrogate pair and send a lone surrogate (BAD_REQUEST) | **Fixed.** Cut on a code-point boundary, then `isStorableText` (an unstorable text is ignored). Test with 99 characters plus an emoji. |

### Targeted audit (e2811b1)

| Ref | Finding | Status |
| --- | --- | --- |
| Audit F1 | A save that got a 429 could retry after logout (`halt()` only cancelled the debouncer) | **Fixed.** `shouldContinue` from the session is checked after the sleep, before the retry. Tests: `save-policy.test.ts`, `config-session.test.ts` (halt at 1 s of a 3 s wait: exactly 1 call). |
| Audit I1 | Logout button could be double-clicked | **Fixed.** `disabled={busy}` and `aria-busy`. |
| Audit I2 | Between a login in tab B and the broadcast reaching tab A, a debounce timer in A could save under the new cookie | **Documented and accepted.** Bounded by server scoping (own row, own spaces); full fix needs a session-bound server check. See FRONTEND.md. |

## Notes for the next sprints

- S8 flips `filterable` for the valuation, debt and dividend columns, adds the `columnSql` mapping and tests; those values are cell values with their own rounding, so use `wire8Sql` and decide the null/zero semantics per column.
- A `tableConfig.save` that comes back `CONFLICT` means the view was written by a newer app version: the UI should reload (`get`) instead of retrying.
- The save bucket and the in-flight caps are in memory, single instance (D13), like the other limiters.
