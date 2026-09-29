import path from 'node:path';
import type { NextConfig } from 'next';

// Monorepo: Next only reads .env from apps/web, so load the root .env (if present) for local dev.
// Existing process env (Compose, CI, hosting) always wins; loadEnvFile does not override.
try {
  process.loadEnvFile(path.join(import.meta.dirname, '../../.env'));
} catch {
  // No root .env: rely on the process environment.
}

const isDev = process.env.NODE_ENV !== 'production';

/**
 * CSP compatible with Next without per-request nonces: Next injects inline bootstrap scripts,
 * so `script-src` needs 'unsafe-inline' (and 'unsafe-eval' for React refresh in dev only).
 * That weakens XSS mitigation; a nonce-based policy (middleware + dynamic rendering) is a
 * tracked S10 hardening item. Everything else is locked down: no framing, no plugins, no
 * cross-origin connections (the browser only talks to this origin's /api/rpc).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  // Ignored by browsers over plain http; only meaningful (and only sent) in production.
  ...(isDev
    ? []
    : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
];

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // Monorepo: trace files from the workspace root so standalone output includes workspace packages.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@waddlers/domain', '@waddlers/contracts', '@waddlers/server'],
  headers: async () => [{ source: '/:path*', headers: securityHeaders }],
};

export default config;
