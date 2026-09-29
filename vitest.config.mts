import path from 'node:path';
import { defineConfig } from 'vitest/config';

const serverOnlyStub = path.resolve(
  import.meta.dirname,
  'packages/server/test/server-only-stub.ts',
);

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'domain',
          include: ['packages/domain/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias: { 'server-only': serverOnlyStub } },
        test: {
          name: 'server',
          include: ['packages/server/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'packages/server/**/*.int.test.ts'],
          environment: 'node',
        },
      },
      {
        // Next route handlers imported directly (node env, no server needed).
        resolve: {
          alias: {
            'server-only': serverOnlyStub,
            '@': path.resolve(import.meta.dirname, 'apps/web'),
          },
        },
        test: {
          name: 'web',
          include: ['apps/web/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'apps/web/.next/**', 'apps/web/e2e/**'],
          environment: 'node',
        },
      },
      {
        // Needs PostgreSQL (DATABASE_URL_TEST). Not part of `pnpm test`; run `pnpm test:integration`.
        resolve: { alias: { 'server-only': serverOnlyStub } },
        test: {
          name: 'integration',
          include: ['packages/server/**/*.int.test.ts'],
          environment: 'node',
          globalSetup: ['packages/server/test/integration-setup.ts'],
          // Tests share one database.
          fileParallelism: false,
        },
      },
    ],
  },
});
