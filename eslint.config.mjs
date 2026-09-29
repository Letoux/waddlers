import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/next-env.d.ts',
      'scripts/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Boundary rule (see MVP-PLAN section 2): the web app may only import
    // @waddlers/server from server-only entry points: app/api/** and server/**.
    // Everything else in apps/web (pages, components, hooks, providers) is treated
    // as potentially client-reachable and must go through @waddlers/contracts / oRPC.
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: ['apps/web/app/api/**', 'apps/web/server/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@waddlers/server', '@waddlers/server/*'],
              message:
                'Client-reachable web code must not import @waddlers/server. Use @waddlers/contracts / oRPC, or move the import under apps/web/app/api/** or apps/web/server/**.',
            },
            {
              group: ['drizzle-orm', 'drizzle-orm/*', 'postgres', '**/packages/server/**'],
              message: 'apps/web must not access the database directly (see FRONTEND.md).',
            },
          ],
        },
      ],
    },
  },
  {
    // Server data in apps/web goes through getServerClient() (authed oRPC procedures), never the
    // database directly: app/api and server/** may import @waddlers/server but not the raw DB.
    files: ['apps/web/app/api/**/*.{ts,tsx}', 'apps/web/server/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@waddlers/server',
              importNames: ['getDb', 'closeDb'],
              message:
                'apps/web must not access the database directly. Use getServerClient() from @/server/orpc (authed procedures).',
            },
          ],
          patterns: [
            {
              group: [
                '@waddlers/server/*',
                'drizzle-orm',
                'drizzle-orm/*',
                'postgres',
                '**/packages/server/**',
              ],
              message: 'apps/web must not access the database directly (see FRONTEND.md).',
            },
          ],
        },
      ],
    },
  },
  {
    // Dynamic imports bypass no-restricted-imports: ban raw DB drivers that way too.
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportExpression[source.value=/^(drizzle-orm|postgres|@waddlers\\/server\\/)|packages\\/server\\//]',
          message: 'apps/web must not access the database directly (see FRONTEND.md).',
        },
      ],
    },
  },
  {
    // packages/contracts and packages/domain are browser-safe: never depend on server code.
    files: ['packages/contracts/**/*.ts', 'packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@waddlers/server', '@waddlers/server/*', 'server-only'] }] },
      ],
    },
  },
  prettier,
);
