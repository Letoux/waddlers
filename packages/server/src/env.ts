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
    MARKET_DATA_PROVIDER: z.enum(['fake', 'eodhd']),
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
