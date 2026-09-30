# Frontend conventions (S2 auth UI)

UI language is French (D16). Auth API contract: see `BACKEND.md` ("What the frontend should call").

## Routes and guard

**Rules (security):** the layout guard is UX only. Every page under `app/(app)/` calls `await requireUser()` (`@/server/auth`, memoised over `getCurrentUser()`), because a client-side RSC navigation can render a page without re-running the layout (an anonymous replay with `RSC: 1` and a router state tree got the page content in the security re-audit). Server data is fetched only through `getServerClient()` (authed procedures); there is no direct `getDb` in `apps/web` (ESLint `no-restricted-imports` blocks `getDb`/`closeDb`, `drizzle-orm`, `postgres` and `@waddlers/server/*` in `app/api/**` and `server/**`; everywhere else `@waddlers/server` is blocked entirely).

- `app/login/page.tsx` (public): server component; redirects an already authenticated user to the validated `next` target (or `/`). Renders `components/auth/login-form.tsx`. No signup link or route exists.
- `app/(app)/layout.tsx`: calls `requireUser()` for the redirect UX and renders the shell (`components/app-header.tsx`: app name, username, "Paramètres", "Se déconnecter"). It is not the boundary. `error.tsx` (page errors inside the shell) lives there. There is deliberately no `loading.tsx` under `(app)`: a Suspense boundary above a page makes `notFound()` stream a 404 fallback with HTTP 200 (audit F2). Without it, an unknown or inaccessible space answers a real HTTP 404 (asserted in e2e); the positions list has its own loading skeleton, and the layout awaits the session lookup before anything streams anyway.
- `app/error.tsx` catches what the `(app)` layout and `/login` throw (session lookup with the database down); `app/global-error.tsx` is the last resort (own `<html>/<body>`). All render the neutral French `components/error-state.tsx`, never `error.message`.
- `proxy.ts` (Next 16 middleware) only sets an `x-waddlers-path` request header (overwriting any client value; tested) so `requireUser()` can build `?next=`. It is a convenience: removing it degrades to a plain `/login` redirect, it never decides access. The value is re-validated by `safeNextPath`.
- `app/(app)/settings/page.tsx`: change-password form.

## Login/logout behaviour

Forms call the browser client (`orpc.auth.*.mutationOptions()` from `@/lib/orpc`) via TanStack `useMutation`. After login and logout: `queryClient.clear()`, `router.replace(...)`, `router.refresh()` (the RSC guard re-runs). Expired sessions while the page is open: `QueryCache`/`MutationCache` `onError` in `components/providers.tsx` (`shouldRedirectToLogin`, `lib/auth/unauthorized.ts`) clears the cache and hard-navigates to `loginUrlFor(current path)` on any `UNAUTHORIZED`, except for the login mutation (bad credentials), logout (already signed out) and the login page. The submit button stays disabled through the redirect.

- `lib/auth/safe-next.ts`: `safeNextPath()` accepts only same-origin relative paths and returns the URL-normalised `pathname+search+hash` (dot segments such as `/..//evil` are resolved, then rejected if the result starts with `//`; `/login` is rejected case-insensitively; backslashes, control chars and scheme URLs too), falling back to `/`. `loginUrlFor()` builds the login URL.
- `lib/auth/errors.ts`: error code to French message. `UNAUTHORIZED` -> "Identifiant ou mot de passe incorrect."; `TOO_MANY_REQUESTS` -> wait duration from `data.retryAfterSeconds` (rounded up); `INVALID_CURRENT_PASSWORD` -> field error on the current password; anything else generic. Server `message`/`issues` are never rendered.
- `lib/zod-fr.ts`: French fallback messages for zod issues without an explicit message (e.g. the lenient login schema), scoped per form via `zodResolver(schema, { error: frenchIssueMessage })` (no global `z.config`). `too_small` with minimum 1 is "Ce champ est requis.", larger minimums "Valeur trop courte.". Explicit contract messages (password policy) win.
- Forms use React Hook Form + `zodResolver` with the contract schemas (`loginInputSchema`, `changePasswordInputSchema`, `newPasswordSchema`, `PASSWORD_MIN_LENGTH`); only the password confirmation is UI-specific. `components/ui/form.tsx` (shadcn pattern) wires `aria-invalid` / `aria-describedby` (hint + error). Field messages are always-rendered `aria-live="polite"` regions; `aria-describedby` only references ids that exist (the description only when rendered). Form-level errors use `role="alert"`. Server errors move focus to the relevant field (`form.setFocus`). Inputs are not disabled while pending (a disabled input cannot take focus); the submit button is.
- Success toast (`react-toastify`): "Mot de passe modifié." only. Login/logout errors are inline, not toasts (logout failure is a toast).

## Spaces and positions (S3)

API: `BACKEND.md` ("Spaces & positions (S3)"). Creating/renaming spaces and adding positions stay admin-only (CLI) in S3.

**Routes** (all call `requireUser()`; space pages also `requireSpace(spaceId)` from `@/server/spaces`, which turns an unknown, malformed or inaccessible id into the same `notFound()`):

- `/` (`(app)/page.tsx`): redirects to `/s/<activeSpaceId>` (from `spaces.list`), or shows "Aucun espace disponible. Contactez l'administrateur." when the user has none.
- `/s/[spaceId]`: dashboard placeholder for S5 (name, role, "Titres suivis" count taken from `spaces.get().positionCount`, never from `positions.list.total`).
- `/s/[spaceId]/titres`: `components/spaces/positions-list.tsx` (client, `useQuery(positions.list)` with `staleTime: 0`; loading, empty, error, NOT_FOUND and "liste tronquée" states; `lib/spaces/truncation.ts` is the only place that reads the cut-list flag). Simple table for S3; TanStack Table arrives with S6.
- `/espaces`: accessible spaces with role and count, "Ouvrir" to switch.
- `(app)/not-found.tsx` (inside the shell) and `app/not-found.tsx`: neutral French "Page introuvable", identical for unknown and inaccessible ids.

**Space selection.** `(app)/layout.tsx` fetches `spaces.list` server-side and passes it as `initialData` to the client `AppHeader`, which shares the `spaces.list` TanStack cache. The current space is the one in the URL (`lib/spaces/nav.ts`), else `activeSpaceId`. The header selector (shadcn Select, label "Espace") pushes the same sub-page in the new space (`switchSpaceHref`) (it does not call the API itself). Space pages render `ActivateSpace`, the single `spaces.setActive` caller (`useSetActiveSpace`, silent on failure, never blocks rendering), which records the opened space once when it differs from the cached `activeSpaceId`. Nav: Dashboard, Titres (only with a space), Espaces, Paramètres; `aria-current="page"` marks the active item; below `md` a Sheet menu holds the links and logout while the selector stays in the header bar.

**Quantity input rules** (`lib/spaces/quantity.ts`, string-only, no float math; unit tests): blank means `null`; spaces (regular, no-break, U+202F) are accepted only as thousands separators in groups of three (`1 234 567`), so `1 2 3` is rejected; `,` or `.` is the decimal separator (not both); `,5` becomes `0.5`; the value is canonicalised (no leading zeros, no trailing fraction zeros, no bare separator: `5,0` is `5`), so an unchanged value is a no-op with no request and no toast. A single `.` followed by exactly three digits (`1.234`) is ambiguous for a French reader (1 234 or 1,234?) and is rejected with "Utilisez la virgule pour les décimales (ex. 1,234) ou un espace pour les milliers (1 234)."; `0.123` is accepted. The result is validated with the contract's `nullableQuantitySchema` (non-negative, at most 16 integer and 8 fraction digits). Display is fr-FR (`1 234,5`, U+202F group separator), `null` renders `—`, never 0 (0 is a real quantity). The raw listing currency is shown as is (`GBX` is never divided). Counts (positions of a space) use `toLocaleString('fr-FR')`, not the quantity formatter.

**Editing** (owner/editor only, from `SPACE_WRITER_ROLES`; viewers get read-only values): click, Enter or blur saves, Escape cancels. Invalid input keeps the editor open with an inline message; only the Enter path pulls focus back to the field (on blur the user has moved on). The mutation logic lives in `lib/spaces/set-quantity.ts` (pure, unit-tested with a QueryClient and a mocked mutation function; `use-positions.ts` only wires it to oRPC and toasts):

- edits of one position are serialized with a mutation `scope` (`qty:<positionId>`), so the last edit wins on the server;
- optimistic update touches that row only; a failure rolls back that row only, only if it still shows this edit's value and no other edit of the position is in flight, and falls back to the last value confirmed by the server (never to another edit's unsaved value);
- `positions.list` and `spaces.list` are invalidated on settle only when no other write of the space (edit or removal, tagged with mutation `meta`) is in flight, so a refetch cannot overwrite a value still being saved;
- success toasts "Quantité mise à jour." and updates one `aria-live` status ("Quantité de LVMH mise à jour."); FORBIDDEN toasts "Vous n’avez pas le droit de modifier cet espace."; NOT_FOUND refreshes quietly.

Query retries (`lib/query-retry.ts`): NOT_FOUND, FORBIDDEN, UNAUTHORIZED and BAD_REQUEST are never retried (a revoked space shows at once), other failures get two retries. The positions list state machine: NOT_FOUND on the list query (even with cached rows) renders "Espace indisponible" with a link to `/espaces`; any other refetch error keeps the rows and shows a "Données non actualisées." banner with "Réessayer".

Removal (`RemovePositionButton`): confirmation dialog, `positions.remove`, toast "Titre retiré de l’espace."; a double click sends one request and NOT_FOUND closes quietly; focus returns to the trigger on cancel, and to the list region (`role="region"`) when the row is gone (`onRemoved`, called from the mutation's `onSuccess` after closing).

Space switching: `ActivateSpace` (rendered by the space pages) is the only caller of `spaces.setActive`; the header selector only navigates (inside `useTransition`, the selector is disabled and `aria-busy` while the navigation is pending). If the URL names a space missing from the cached list, `spaces.list` is refetched once. The mobile table markup carries explicit `role` attributes (`table`, `row`, `cell`, ...) because the responsive CSS changes the `display` of table elements.

E2E data: global setup runs `pnpm db:seed` against the test database (`ALLOW_DEV_SEED=1`, random dev password) for reference data only. Every space scenario builds its own data inside the test (`e2e/support/fixtures.ts`): a fresh user (`user:create`), spaces, memberships and positions (`space:create`, `space:grant`, `position:add`; the space id is parsed from the anchored `Space created: <name> (<uuid>)` line), all with random names. Nothing is shared between tests, so `playwright test e2e/spaces.spec.ts --repeat-each=3` and retries are safe. The fixture also exposes `setRole`/`revoke` to change a membership after the page has loaded (FORBIDDEN and revoked-space cases). Specs: `e2e/spaces.spec.ts`. Seed selection reasons are stored in French ("Place principale (Euronext Paris)."); the CLI cannot set a reason, so they are only checked manually on the dev seed. Existing dev/test databases keep their older English reasons because the seed never overwrites rows.

Known limitation: a malformed percent-encoding in a space URL (`/s/%E0%A4%A`) is answered by Next itself with a plain-text HTTP 500 before any app code runs (no data is exposed); `parseSpacePath` only protects the header from throwing.

## shadcn note

`pnpm dlx shadcn@latest add …` in this repo generated `import { cn } from "cn"` (the npm package `cn`, unrelated to our helper) and did not overwrite `button.tsx` non-interactively. Generated files were fixed to `@/lib/utils` and the stray `cn` dependency removed; `form.tsx` was added by hand (standard shadcn form). Check imports after every `shadcn add`.

## E2E (Playwright)

`apps/web/playwright.config.ts` serves the production build (`pnpm build` first) on port 3100 against a **throwaway test database** (`E2E_DATABASE_URL`, default `postgres://waddlers:waddlers-test@localhost:5433/waddlers_test`; compose profile `test`): `docker compose --profile test up -d --wait postgres-test`, then `pnpm build && pnpm test:e2e`. A second server on 3101 points at an unreachable database (error-boundary scenario). Both get a test-only `AUTH_SECRET` from the config.

`e2e/support/global-setup.ts` checks the database with `test-support/safe-database.ts` (unit-tested: name must match `(^|_)test($|_)`, host must be local unless `CI`), runs `pnpm db:migrate`, and creates **one fresh random user per scenario** (`ACCOUNT_KEYS` in `e2e/support/env.ts`) through the admin CLI, so the login rate limit, the session revocation of `changePassword` and retries cannot leak between tests. Credentials are exposed to tests only via process env (`account(key)`). Existing servers are never reused. CI (`build-e2e`) provides a Postgres service on 5433 and sets `E2E_DATABASE_URL`.

## Known limitations

- Password field is not cleared after a failed login (clearing raced with fast retyping); the field is refocused.
- Playwright E2E covers Chromium desktop plus one 375px check; other browsers not run.
