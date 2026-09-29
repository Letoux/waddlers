import { defineConfig, devices } from '@playwright/test';
import {
  E2E_AUTH_SECRET,
  E2E_DATABASE_URL,
  E2E_DB_DOWN_PORT,
  E2E_DB_DOWN_URL,
  E2E_PORT as port,
} from './e2e/support/env';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/support/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Serves the production build (run `pnpm build` first; CI does this in the build stage).
      command: `pnpm exec next start -p ${port}`,
      url: `http://localhost:${port}`,
      // Never reuse a server: it could be wired to another database.
      reuseExistingServer: false,
      env: {
        DATABASE_URL: E2E_DATABASE_URL,
        APP_ORIGIN: `http://localhost:${port}`,
        MARKET_DATA_PROVIDER: 'fake',
        AUTH_SECRET: E2E_AUTH_SECRET,
        NODE_ENV: 'production',
      },
      timeout: 60_000,
    },
    {
      // Same build, unreachable database: exercises the error boundaries (db-down.spec.ts).
      command: `pnpm exec next start -p ${E2E_DB_DOWN_PORT}`,
      url: `http://localhost:${E2E_DB_DOWN_PORT}`,
      reuseExistingServer: false,
      env: {
        DATABASE_URL: E2E_DB_DOWN_URL,
        APP_ORIGIN: `http://localhost:${E2E_DB_DOWN_PORT}`,
        MARKET_DATA_PROVIDER: 'fake',
        AUTH_SECRET: E2E_AUTH_SECRET,
        NODE_ENV: 'production',
      },
      timeout: 60_000,
    },
  ],
});
