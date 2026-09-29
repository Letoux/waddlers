import { implement, ORPCError } from '@orpc/server';
import { contract } from '@waddlers/contracts';
import { sql } from 'drizzle-orm';
import { authenticate, changePassword, login, logout, type AuthDeps } from './auth/service';
import type { ResolvedSession } from './auth/sessions';
import { warmDummyHash } from './auth/password';
import { LoginRateLimiter } from './auth/rate-limit';
import { getDb } from './db/client';
import { getEnv } from './env';
import { logError, type ErrorLogger } from './errors';

/** Per-request context supplied by the transport (HTTP handler or server-side client). */
export interface RpcContext {
  headers: Headers;
  /** Set by ResponseHeadersPlugin over HTTP; absent for server-side (SSR/RSC) callers. */
  resHeaders?: Headers;
}

export type DbCheck = () => Promise<void>;

const DB_CHECK_TIMEOUT_MS = 2_000;
/** The "database unavailable" log line is emitted at most once per interval. */
const DB_LOG_INTERVAL_MS = 30_000;

export const checkDatabase: DbCheck = async () => {
  await getDb().execute(sql`select 1`);
};

async function withTimeout(check: DbCheck): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('db check timeout'), { name: 'DbCheckTimeout' })),
          DB_CHECK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Client IP for rate limiting. Forwarded headers are client-controlled unless a trusted reverse
 * proxy sets them, so they are only read when TRUSTED_PROXY_HEADER is configured. With
 * x-forwarded-for the right-most entry is used (the one appended by our single trusted proxy).
 */
export function clientIpFrom(headers: Headers, trustedHeader: string | undefined): string {
  if (!trustedHeader) return 'unknown';
  const value = headers.get(trustedHeader);
  if (!value) return 'unknown';
  const parts = value.split(',');
  return (parts[parts.length - 1] ?? '').trim().slice(0, 64) || 'unknown';
}

export interface RouterDeps {
  checkDb?: DbCheck;
  now?: () => Date;
  /** Server-side error logger (sanitised by default). Injectable for tests. */
  log?: ErrorLogger;
  getDb?: AuthDeps['getDb'];
  loginLimiter?: LoginRateLimiter;
  passwordLimiter?: LoginRateLimiter;
  clientIp?: AuthDeps['clientIp'];
  /** Test seam: replaces the cookie-to-session lookup. Production always uses the database. */
  authenticate?: (context: RpcContext) => Promise<ResolvedSession | null>;
}

export function createRouter({
  checkDb = checkDatabase,
  now = () => new Date(),
  log = logError,
  getDb: getDatabase = getDb,
  loginLimiter = new LoginRateLimiter(),
  passwordLimiter = new LoginRateLimiter(),
  clientIp = (headers) => clientIpFrom(headers, getEnv().TRUSTED_PROXY_HEADER),
  authenticate: resolveAuth,
}: RouterDeps = {}) {
  const deps: AuthDeps = { getDb: getDatabase, now, loginLimiter, passwordLimiter, clientIp };
  // Pay the one-off argon2 dummy-hash cost now, not on the first unknown-user login (timing).
  warmDummyHash();
  const os = implement(contract).$context<RpcContext>();

  /**
   * Auth boundary. EVERY non-public procedure must be built from `authed` (enforced by a test
   * that calls each procedure unauthenticated). Runs before input validation: nothing about a
   * protected procedure's shape is revealed to anonymous callers.
   */
  const authed = os.use(async ({ context, next }) => {
    const session = await (resolveAuth ?? ((ctx) => authenticate(deps, ctx)))(context);
    if (!session) throw new ORPCError('UNAUTHORIZED', { message: 'Unauthorized' });
    return next({ context: { session } });
  });

  let lastDbLog = 0;

  return os.router({
    // Public, liveness only: no dependency state is disclosed to anonymous callers.
    health: os.health.handler(() => ({ status: 'ok' as const, time: now().toISOString() })),
    systemStatus: authed.systemStatus.handler(async () => {
      let db: 'ok' | 'unavailable' = 'ok';
      try {
        await withTimeout(checkDb);
      } catch (error) {
        // Detail stays in the server log (throttled); the response only says "unavailable".
        const t = now().getTime();
        if (t - lastDbLog >= DB_LOG_INTERVAL_MS) {
          lastDbLog = t;
          log('Status check: database unavailable', error);
        }
        db = 'unavailable';
      }
      return {
        status: db === 'ok' ? ('ok' as const) : ('degraded' as const),
        db,
        time: now().toISOString(),
      };
    }),
    auth: {
      login: os.auth.login.handler(({ context, input, errors }) =>
        login(deps, context, input, errors),
      ),
      logout: authed.auth.logout.handler(({ context }) => logout(deps, context, context.session)),
      me: authed.auth.me.handler(({ context }) => ({ user: context.session.user })),
      changePassword: authed.auth.changePassword.handler(({ context, input, errors }) =>
        changePassword(deps, context, context.session, input, errors),
      ),
    },
  });
}

export type AppRouter = ReturnType<typeof createRouter>;
