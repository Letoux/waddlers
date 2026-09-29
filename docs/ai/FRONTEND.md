# Frontend conventions (S2 auth UI)

UI language is French (D16). Auth API contract: see `BACKEND.md` ("What the frontend should call").

## Routes and guard

- `app/login/page.tsx` (public): server component; redirects an already authenticated user to the validated `next` target (or `/`). Renders `components/auth/login-form.tsx`. No signup link or route exists.
- `app/(app)/layout.tsx`: **the auth boundary**. Calls `getCurrentUser()` (`@/server/auth`) and `redirect('/login?next=…')` when null, then renders the shell (`components/app-header.tsx`: app name, username, "Paramètres", "Se déconnecter"). Every authenticated page goes under `app/(app)/`. `loading.tsx` (skeleton) and `error.tsx` (neutral French message, never `error.message`) live there too.
- `proxy.ts` (Next 16 middleware) only sets an `x-waddlers-path` request header so the layout can build `?next=`. It is a convenience: removing it degrades to a plain `/login` redirect, it never decides access. The value is re-validated by `safeNextPath`.
- `app/(app)/settings/page.tsx`: change-password form.

## Login/logout behaviour

Forms call the browser client (`orpc.auth.*.mutationOptions()` from `@/lib/orpc`) via TanStack `useMutation`. After login and logout: `queryClient.clear()`, `router.replace(...)`, `router.refresh()` (the RSC guard re-runs). The submit button stays disabled through the redirect.

- `lib/auth/safe-next.ts`: `safeNextPath()` accepts only same-origin relative paths (rejects `//host`, backslashes, control chars, scheme URLs, `/login`), falls back to `/`. `loginUrlFor()` builds the login URL.
- `lib/auth/errors.ts`: error code to French message. `UNAUTHORIZED` -> "Identifiant ou mot de passe incorrect."; `TOO_MANY_REQUESTS` -> wait duration from `data.retryAfterSeconds` (rounded up); `INVALID_CURRENT_PASSWORD` -> field error on the current password; anything else generic. Server `message`/`issues` are never rendered.
- `lib/zod-fr.ts` (imported by `components/providers.tsx`): French fallback messages for zod issues without an explicit message (e.g. the lenient login schema). Explicit contract messages (password policy) win.
- Forms use React Hook Form + `zodResolver` with the contract schemas (`loginInputSchema`, `changePasswordInputSchema`, `newPasswordSchema`, `PASSWORD_MIN_LENGTH`); only the password confirmation is UI-specific. `components/ui/form.tsx` (shadcn pattern) wires `aria-invalid` / `aria-describedby` (hint + error). Server errors are announced through `role="alert"` and move focus to the relevant field (`form.setFocus`). Inputs are not disabled while pending (a disabled input cannot take focus); the submit button is.
- Success toast (`react-toastify`): "Mot de passe modifié." only. Login/logout errors are inline, not toasts (logout failure is a toast).

## shadcn note

`pnpm dlx shadcn@latest add …` in this repo generated `import { cn } from "cn"` (the npm package `cn`, unrelated to our helper) and did not overwrite `button.tsx` non-interactively. Generated files were fixed to `@/lib/utils` and the stray `cn` dependency removed; `form.tsx` was added by hand (standard shadcn form). Check imports after every `shadcn add`.

## E2E (Playwright)

`apps/web/playwright.config.ts` serves the production build (`pnpm build` first) on port 3100 against a **throwaway test database** (`E2E_DATABASE_URL`, default `postgres://waddlers:waddlers-test@localhost:5433/waddlers_test`; compose profile `test`): `docker compose --profile test up -d --wait postgres-test`, then `pnpm build && pnpm test:e2e`. `e2e/support/global-setup.ts` refuses a database name without "test", runs `pnpm db:migrate`, and creates two fresh random users per run through the admin CLI (`e2e-main-*` for login tests, `e2e-pw-*` for the password change, so the session revocation of `changePassword` cannot break parallel tests). Credentials are exposed to tests only via process env. Existing servers are never reused. CI (`build-e2e`) provides a Postgres service on 5433 and sets `E2E_DATABASE_URL`.

## Known limitations

- Password field is not cleared after a failed login (clearing raced with fast retyping); the field is refocused.
- Playwright E2E covers Chromium desktop plus one 375px check; other browsers not run.
