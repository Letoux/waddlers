import path from 'node:path';
import type { NextConfig } from 'next';

// Monorepo: Next only reads .env from apps/web, so load the root .env (if present) for local dev.
// Existing process env (Compose, CI, hosting) always wins; loadEnvFile does not override.
try {
  process.loadEnvFile(path.join(import.meta.dirname, '../../.env'));
} catch {
  // No root .env: rely on the process environment.
}

const config: NextConfig = {
  output: 'standalone',
  // Monorepo: trace files from the workspace root so standalone output includes workspace packages.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@waddlers/domain', '@waddlers/contracts', '@waddlers/server'],
};

export default config;
