import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  // Monorepo: trace files from the workspace root so standalone output includes workspace packages.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@waddlers/domain', '@waddlers/contracts', '@waddlers/server'],
};

export default config;
