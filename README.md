# Waddlers

Tableau de bord de suivi et d'analyse financière (pas un broker, pas une banque). Spécification: [`specs.md`](./specs.md).

## Démarrage rapide

Prérequis: Node >= 22, pnpm 12 (`corepack enable`), Docker (pour PostgreSQL).

```bash
pnpm install
cp .env.example .env          # valeurs locales uniquement, jamais commité
docker compose up -d postgres # PostgreSQL 17 sur localhost:5432
pnpm dev                      # http://localhost:3000
```

## Commandes

| Commande                          | Rôle                                     |
| --------------------------------- | ---------------------------------------- |
| `pnpm lint` / `pnpm format:check` | ESLint / Prettier                        |
| `pnpm typecheck`                  | tsc strict sur tous les workspaces       |
| `pnpm test`                       | tests unitaires (Vitest)                 |
| `pnpm build`                      | build Next.js (standalone)               |
| `pnpm test:integration`           | tests PostgreSQL (`DATABASE_URL_TEST`)   |
| `pnpm db:generate` / `db:migrate` | migrations Drizzle (générer / appliquer) |
| `pnpm db:check`                   | cohérence des migrations (drizzle-kit)   |
| `pnpm test:e2e`                   | Playwright (nécessite `pnpm build`)      |

Première fois pour Playwright: `pnpm --filter @waddlers/web exec playwright install chromium`.

Base de test éphémère (tmpfs, port 5433): `docker compose --profile test up -d postgres-test`.
Image web: `docker compose --profile app up --build web`.

## Structure

`apps/web` (Next.js), `apps/worker`, `packages/domain`, `packages/contracts`, `packages/server` (`server-only`).
Règle d'import: `apps/web` n'importe `@waddlers/server` que depuis `app/api/**` ou `server/**` (ESLint).
