import { z } from 'zod';

function isPostgresUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'postgres:' || protocol === 'postgresql:';
  } catch {
    return false;
  }
}

function isHttpOrigin(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Compose passes unset variables as '': treat them as absent so defaults apply. */
const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

function boundedInt(min: number, max: number, fallback: number) {
  return z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(min).max(max).default(fallback),
  );
}

/**
 * Market-data settings (S4), shared by the web env and the worker/CLI env. Every value has a
 * default; TTLs follow specs 27 and docs/ai/MARKET-DATA.md.
 */
export const marketDataEnvShape = {
  MARKET_DATA_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['fake', 'eodhd']).default('fake')),
  FX_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['fake', 'ecb']).default('fake')),
  /** Provider credential. Never logged, never echoed by validation errors. */
  EODHD_API_TOKEN: z.preprocess(emptyToUndefined, z.string().min(8).max(256).optional()),
  MARKET_DATA_QUOTE_TTL_MINUTES: boundedInt(1, 24 * 60, 15),
  MARKET_DATA_HISTORY_TTL_HOURS: boundedInt(1, 24 * 14, 12),
  MARKET_DATA_FX_TTL_HOURS: boundedInt(1, 24 * 14, 12),
  /** Provider calls per UTC day (every attempt counts), persisted in `provider_usage`. */
  MARKET_DATA_DAILY_QUOTA: boundedInt(1, 10_000_000, 5000),
  MARKET_DATA_CONCURRENCY: boundedInt(1, 32, 4),
  MARKET_DATA_TIMEOUT_MS: boundedInt(500, 120_000, 8000),
} as const;

export const marketDataEnvSchema = z.object(marketDataEnvShape);
export type MarketDataEnv = z.infer<typeof marketDataEnvSchema>;

// Refinement messages are static on purpose: a failing value (which may embed a
// password) must never be echoed back.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().refine(isPostgresUrl, 'must be a postgres:// or postgresql:// URL'),
    APP_ORIGIN: z
      .string()
      .refine(isHttpOrigin, 'must be an http(s) origin')
      .transform((value) => new URL(value).origin),
    ...marketDataEnvShape,
    /** HMAC key for device cookies (>= 32 bytes). Never logged; env errors never echo values. */
    AUTH_SECRET: z
      .string()
      .refine((value) => Buffer.byteLength(value, 'utf8') >= 32, 'must be at least 32 bytes'),
    /** Header set by a trusted reverse proxy carrying the client IP (rate limiting). Unset = ignore. */
    TRUSTED_PROXY_HEADER: z.preprocess(
      (value) => (value === '' ? undefined : value), // Compose passes unset vars as ''
      z.enum(['x-forwarded-for', 'x-real-ip']).optional(),
    ),
  })
  .superRefine((env, ctx) => {
    // The session cookie is Secure (__Host-): browsers drop it on plain http except localhost,
    // so an http production origin would silently break login.
    if (env.NODE_ENV !== 'production') return;
    const url = new URL(env.APP_ORIGIN);
    if (url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_ORIGIN'],
        message: 'must be https in production (Secure session cookie)',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(
    readonly variables: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

/** Parses an env source. The error names invalid variables but never their values. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    const reason = issue.code === 'invalid_type' ? 'is missing or not a string' : issue.message;
    return `  - ${name}: ${reason}`;
  });
  const variables = result.error.issues.map((issue) => issue.path.join('.'));
  throw new EnvValidationError(
    variables,
    `Invalid environment configuration:\n${lines.join('\n')}`,
  );
}

/** Worker/CLI env: the database plus the market-data settings (no web-only variables). */
export const workerEnvSchema = z.object({
  DATABASE_URL: z.string().refine(isPostgresUrl, 'must be a postgres:// or postgresql:// URL'),
  ...marketDataEnvShape,
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function parseWorkerEnv(source: Record<string, string | undefined>): WorkerEnv {
  const result = workerEnvSchema.safeParse(source);
  if (result.success) return result.data;
  const names = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
  throw new EnvValidationError(
    names,
    `Invalid environment configuration:\n${result.error.issues
      .map(
        (i) =>
          `  - ${i.path.join('.') || '(root)'}: ${i.code === 'invalid_type' ? 'is missing or not a string' : i.message}`,
      )
      .join('\n')}`,
  );
}

let cached: Env | undefined;

/** Lazily parsed once per process; fails fast on first use. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test helper. */
export function resetEnvCache(): void {
  cached = undefined;
}
