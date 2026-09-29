# Frontend conventions (S2 auth UI)

UI language is French (D16). Auth API contract: see `BACKEND.md` ("What the frontend should call").

## Routes and guard

**Rules (security):** the layout guard is UX only. Every page under `app/(app)/` calls `await requireUser()` (`@/server/auth`, memoised over `getCurrentUser()`), because a client-side RSC navigation can render a page without re-running the layout (an anonymous replay with `RSC: 1` and a router state tree got the page content in the security re-audit). Server data is fetched only through `getServerClient()` (authed procedures); there is no direct `getDb` in `apps/web` (ESLint `no-restricted-imports` blocks `getDb`/`closeDb`, `drizzle-orm`, `postgres` and `@waddlers/server/*` in `app/api/**` and `server/**`; everywhere else `@waddlers/server` is blocked entirely).

- `app/login/page.tsx` (public): server component; redirects an already authenticated user to the validated `next` target (or `/`). Renders `components/auth/login-form.tsx`. No signup link or route exists.
- `app/(app)/layout.tsx`: calls `requireUser()` for the redirect UX and renders the shell (`components/app-header.tsx`: app name, username, "Paramètres", "Se déconnecter"). It is not the boundary. `error.tsx` (page errors inside the shell) and `loading.tsx` (skeleton) live there. Note: `loading.tsx` only covers page-level suspense; the layout awaits the session lookup before anything streams, so it does not cover the auth wait (a slow lookup shows the previous page or a blank navigation; streaming the shell was judged not worth the complexity).
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

## shadcn note

`pnpm dlx shadcn@latest add …` in this repo generated `import { cn } from "cn"` (the npm package `cn`, unrelated to our helper) and did not overwrite `button.tsx` non-interactively. Generated files were fixed to `@/lib/utils` and the stray `cn` dependency removed; `form.tsx` was added by hand (standard shadcn form). Check imports after every `shadcn add`.

## E2E (Playwright)

`apps/web/playwright.config.ts` serves the production build (`pnpm build` first) on port 3100 against a **throwaway test database** (`E2E_DATABASE_URL`, default `postgres://waddlers:waddlers-test@localhost:5433/waddlers_test`; compose profile `test`): `docker compose --profile test up -d --wait postgres-test`, then `pnpm build && pnpm test:e2e`. A second server on 3101 points at an unreachable database (error-boundary scenario). Both get a test-only `AUTH_SECRET` from the config.

`e2e/support/global-setup.ts` checks the database with `test-support/safe-database.ts` (unit-tested: name must match `(^|_)test($|_)`, host must be local unless `CI`), runs `pnpm db:migrate`, and creates **one fresh random user per scenario** (`ACCOUNT_KEYS` in `e2e/support/env.ts`) through the admin CLI, so the login rate limit, the session revocation of `changePassword` and retries cannot leak between tests. Credentials are exposed to tests only via process env (`account(key)`). Existing servers are never reused. CI (`build-e2e`) provides a Postgres service on 5433 and sets `E2E_DATABASE_URL`.

## Known limitations

- Password field is not cleared after a failed login (clearing raced with fast retyping); the field is refocused.
- Playwright E2E covers Chromium desktop plus one 375px check; other browsers not run.
