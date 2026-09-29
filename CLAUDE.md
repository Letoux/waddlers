# Waddlers — Claude Code project instructions

## 1. Project identity

Waddlers is a financial monitoring and analysis dashboard.

It is NOT:
- a bank;
- a broker;
- a trading platform;
- an order-management system;
- an accounting application.

There is no buying, selling, order placement, broker integration, transaction ledger, or banking workflow in the current scope.

The product specification is the source of truth:
- `specs.md`

Read `specs.md` before making product or architectural decisions.

## 2. Source of truth hierarchy

Use this precedence:

1. `specs.md` for product requirements.
2. `CLAUDE.md` for global engineering rules.
3. `AGENTS.md` for agent orchestration rules.
4. `docs/ai/` for AI workflow and architecture context.
5. Existing code and tests for current implementation reality.
6. Agent assumptions last.

Never silently invent a requirement that conflicts with `specs.md`.

If the specification is ambiguous, stop and ask for clarification when the ambiguity can materially change architecture, data semantics, security, or UX.

## 3. Stack

Required stack:

- TypeScript
- React
- Next.js
- Tailwind CSS
- shadcn/ui
- TanStack Query
- TanStack Table
- Recharts
- React Hook Form
- Zod
- Zustand when genuinely necessary
- react-toastify
- Node.js
- oRPC
- Drizzle ORM
- PostgreSQL
- Docker / Docker Compose
- pnpm
- GitHub Actions (CI)
- Vitest
- Playwright
- ESLint
- Prettier

Do not replace these technologies without an explicit architectural decision.

## 4. Architecture principles

- TypeScript end-to-end.
- Keep domain/business logic out of React components.
- Keep market-data providers behind an application boundary.
- The frontend must never call a financial-data provider directly.
- Validate external and user input with Zod.
- Use oRPC for typed application API boundaries.
- Use Drizzle for PostgreSQL access.
- Treat PostgreSQL as the durable source of truth for persisted application data.
- Use TanStack Query for client-side server-state caching.
- Add server-side market-data caching to avoid unnecessary provider polling.
- WebSocket support may be introduced for invalidation/realtime updates, but it is not required for MVP.
- Prefer simple designs over speculative abstractions.

## 5. Financial-data correctness

Financial data is a critical correctness boundary.

Never:
- silently convert an unavailable value to zero;
- invent a market value;
- mix currencies without an explicit conversion;
- present stale data as realtime;
- silently change the selected exchange/listing;
- change a performance formula without tests.

Unavailable values should normally be represented as `null`/undefined in the domain and rendered as `—` in the UI.

Any change to performance, currency conversion, valuation, portfolio-space value, or historical data logic requires tests.

## 6. UI principles

Waddlers is a dashboard, not a spreadsheet.

Priorities:
1. clarity;
2. information hierarchy;
3. fast scanning;
4. configurable density;
5. consistency.

Use shadcn/ui primitives where appropriate.
Avoid unnecessary custom UI primitives.

The main table must support configurable columns, ordering, filtering, sorting, search, and persistence as specified in `specs.md`.

## 7. Data fetching and caching

Avoid polling financial APIs unnecessarily.

Use:
- TanStack Query cache in the browser;
- server-side cache with explicit TTLs;
- PostgreSQL for persisted market history and application data.

Cache policy must be documented when introducing a new financial-data endpoint.

A frontend refetch must not automatically imply an external-provider request.

## 8. Testing

Every meaningful behavior change should have appropriate tests.

Priorities:
- domain/business logic;
- financial calculations;
- API contracts;
- authorization;
- cache behavior;
- table filtering/sorting behavior;
- critical dashboard flows.

Do not chase an arbitrary coverage percentage. Coverage is a diagnostic signal; meaningful behavioral assertions matter more.

## 9. Security

Security is a first-class requirement.

Pay particular attention to:
- authentication;
- authorization and tenant/space isolation;
- secrets;
- API input validation;
- SSR/RSC boundaries;
- SQL access;
- external provider credentials;
- dependency vulnerabilities;
- XSS/CSRF/session issues;
- insecure direct object references.

Security review is mandatory for authentication, authorization, external APIs, secrets, and sensitive-data changes.

## 10. Agent behavior

Before implementing:
- understand the task;
- inspect the relevant code;
- read the relevant part of `specs.md`;
- make a concise plan;
- identify assumptions.

During implementation:
- make the smallest coherent change;
- avoid unrelated refactors;
- add/update tests;
- run relevant validation.

Before declaring completion:
- run tests;
- run lint/typecheck/build as applicable;
- inspect the diff;
- verify the requirement against `specs.md`;
- report anything not verified.

Never claim a test passed unless it was actually executed.

## 11. Git

Keep commits focused.

Do not:
- rewrite unrelated history;
- force-push;
- delete branches;
- merge pull requests;
- push to remote unless explicitly requested.

Do not create a commit merely to make a task look complete.

## 12. Agent model policy

Reasoning / planning / review agents:
- Claude Opus 5.5

Execution agents:
- Claude Sonnet 5.5

If the configured Claude Code installation exposes these through different model identifiers, use the project's configured aliases/environment mapping rather than inventing a provider-specific identifier.

Do not downgrade a reasoning task to Sonnet merely to save context unless explicitly instructed.

## 13. Persistent AI state

Do not rely on conversation memory as project memory.

Persist durable information in:
- `specs.md`
- `docs/ai/`
- code comments only when the comment explains a non-obvious invariant
- Git history

The current task state should be recorded in the project's task/sprint tracking system when one exists.

## 14. Completion contract

A task is complete only when:
- the requested behavior exists;
- relevant tests exist and pass;
- typecheck/lint/build status is known;
- security implications were considered;
- no unrelated files were changed without justification;
- documentation/state is updated when needed.
