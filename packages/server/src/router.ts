import { implement, ORPCError } from '@orpc/server';
import { contract } from '@waddlers/contracts';
import { sql } from 'drizzle-orm';
import type { SpaceRole } from '@waddlers/contracts';
import {
  DASHBOARD_MAX_CONCURRENT,
  DASHBOARD_RATE_PER_MINUTE,
  DashboardLimiter,
  POSITIONS_FACETS_MAX_CONCURRENT,
  POSITIONS_LIST_MAX_CONCURRENT,
  TABLE_CONFIG_SAVE_BURST,
  TABLE_CONFIG_SAVE_MAX_CONCURRENT,
  TABLE_CONFIG_SAVE_RATE_PER_MINUTE,
  retryAfterSeconds,
  type AdmissionPolicy,
} from './dashboard/limiter';
import { getHistory, getMovers, getSummary, type DashboardDeps } from './dashboard/service';
import { FX_TOLERANCE_DAYS } from './market-data/config';
import { requireSpaceAccess } from './spaces/access';
import {
  getTableConfig,
  resetTableConfig,
  saveTableConfig,
  TableConfigNewerVersionError,
} from './spaces/table-config';
import { getPositionFacets } from './spaces/table-facets';
import {
  getSpace,
  listSpacePositions,
  listSpaces,
  removeSpacePosition,
  setActiveSpace,
  setPositionQuantity,
} from './spaces/service';
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
  /** Per-user admission of dashboard.summary/history (concurrency + rate). Injectable for tests. */
  dashboardLimiter?: DashboardLimiter;
  /** Per-user token bucket of tableConfig.save (30/min, burst 10). Injectable for tests. */
  tableConfigLimiter?: DashboardLimiter;
  clientIp?: AuthDeps['clientIp'];
  authSecret?: AuthDeps['authSecret'];
  /** Test seam: replaces the cookie-to-session lookup. Production always uses the database. */
  authenticate?: (context: RpcContext) => Promise<ResolvedSession | null>;
}

/**
 * ONE limiter per process, shared by the HTTP RPC router and the in-process server client (SSR),
 * so the per-user cap cannot be doubled by using both paths. Parked on `globalThis` because Next
 * can bundle the route handler and the server components as separate module graphs, each with
 * its own copy of this module. Tests inject their own.
 */
const LIMITER_KEY = Symbol.for('waddlers.dashboardLimiter');
const sharedDashboardLimiter = ((globalThis as Record<symbol, unknown>)[LIMITER_KEY] ??=
  new DashboardLimiter({
    maxConcurrent: DASHBOARD_MAX_CONCURRENT,
    ratePerMinute: DASHBOARD_RATE_PER_MINUTE,
  })) as DashboardLimiter;

/** Per-user token bucket of `tableConfig.save` (S7, audit F2): its own limiter, so saves never eat the dashboard's budget. */
const SAVE_LIMITER_KEY = Symbol.for('waddlers.tableConfigSaveLimiter');
const sharedTableConfigLimiter = ((globalThis as Record<symbol, unknown>)[SAVE_LIMITER_KEY] ??=
  new DashboardLimiter({
    maxConcurrent: TABLE_CONFIG_SAVE_MAX_CONCURRENT,
    ratePerMinute: TABLE_CONFIG_SAVE_RATE_PER_MINUTE,
    burst: TABLE_CONFIG_SAVE_BURST,
  })) as DashboardLimiter;

export function createRouter({
  checkDb = checkDatabase,
  now = () => new Date(),
  log = logError,
  getDb: getDatabase = getDb,
  loginLimiter = new LoginRateLimiter(),
  passwordLimiter = new LoginRateLimiter(),
  dashboardLimiter = sharedDashboardLimiter,
  tableConfigLimiter = sharedTableConfigLimiter,
  clientIp = (headers) => clientIpFrom(headers, getEnv().TRUSTED_PROXY_HEADER),
  authSecret = () => getEnv().AUTH_SECRET,
  authenticate: resolveAuth,
}: RouterDeps = {}) {
  const deps: AuthDeps = {
    getDb: getDatabase,
    now,
    loginLimiter,
    passwordLimiter,
    clientIp,
    authSecret,
  };
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

  /**
   * Space-scoped procedures: `authed` plus an access check on `input.spaceId`, adding
   * `context.space` (a branded `AuthorizedSpace`). Runs BEFORE input validation, so an
   * inaccessible/nonexistent space answers NOT_FOUND and a too-low role FORBIDDEN whatever the rest
   * of the input looks like. The set of procedures taking `spaceId` is enforced by the IDOR matrix
   * test, which enumerates the contract.
   */
  const spaceScoped = (minRole: SpaceRole) =>
    authed.use(async ({ context, next }, input) => {
      const spaceId = (input as { spaceId?: unknown } | null | undefined)?.spaceId;
      const space = await requireSpaceAccess(
        { db: deps.getDb(), userId: context.session.user.id },
        spaceId,
        minRole,
      );
      return next({ context: { space } });
    });

  const dashboardDeps: DashboardDeps = {
    now,
    fxToleranceDays: FX_TOLERANCE_DAYS,
  };

  /**
   * Admission per authenticated user for the CPU-heavy dashboard procedures (concurrency + rate) and
   * for `positions.list` (concurrency only). Runs after the space
   * access check (an inaccessible space still answers NOT_FOUND, never 429) and holds its slot for
   * the whole call, compute included.
   */
  const admitted = async <T>(
    userId: string,
    procedure: 'summary' | 'history' | 'positions.list' | 'positions.facets' | 'tableConfig.save',
    ctx: RpcContext,
    errors: { TOO_MANY_REQUESTS: (options: { data: { retryAfterSeconds: number } }) => Error },
    run: () => Promise<T>,
    policy?: AdmissionPolicy,
    limiter: DashboardLimiter = dashboardLimiter,
  ): Promise<T> => {
    const admission = limiter.acquire(userId, procedure, policy);
    if (!admission.allowed) {
      const seconds = retryAfterSeconds(admission.retryAfterMs);
      ctx.resHeaders?.set('retry-after', String(seconds));
      throw errors.TOO_MANY_REQUESTS({ data: { retryAfterSeconds: seconds } });
    }
    try {
      return await run();
    } finally {
      admission.release();
    }
  };

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
    spaces: {
      list: authed.spaces.list.handler(({ context }) =>
        listSpaces(deps.getDb(), context.session.user.id),
      ),
      get: spaceScoped('viewer').spaces.get.handler(({ context }) =>
        getSpace(deps.getDb(), context.space),
      ),
      setActive: spaceScoped('viewer').spaces.setActive.handler(({ context }) =>
        setActiveSpace(deps.getDb(), context.space),
      ),
    },
    positions: {
      // In-flight cap only (4 per user): no token bucket, typing/sorting/paging must never get a false 429.
      list: spaceScoped('viewer').positions.list.handler(({ context, input, errors }) =>
        admitted(
          context.session.user.id,
          'positions.list',
          context,
          errors,
          () => listSpacePositions(deps.getDb(), context.space, input, now),
          { maxConcurrent: POSITIONS_LIST_MAX_CONCURRENT, rated: false },
        ),
      ),
      // Space-wide choices of the enum filters (S7): every member may read them, like the list itself.
      // Same in-flight cap as the list (4 per user, unrated, own counter).
      facets: spaceScoped('viewer').positions.facets.handler(({ context, errors }) =>
        admitted(
          context.session.user.id,
          'positions.facets',
          context,
          errors,
          () => getPositionFacets(deps.getDb(), context.space),
          { maxConcurrent: POSITIONS_FACETS_MAX_CONCURRENT, rated: false },
        ),
      ),
      setQuantity: spaceScoped('editor').positions.setQuantity.handler(({ context, input }) =>
        setPositionQuantity(deps.getDb(), context.space, input.positionId, input.quantity),
      ),
      remove: spaceScoped('editor').positions.remove.handler(({ context, input }) =>
        removeSpacePosition(deps.getDb(), context.space, input.positionId),
      ),
    },
    // The caller's OWN view of a space (user from the session via context.space.userId, never from input).
    // viewer+: it is personal config, not shared data, so a read-only member keeps their own table view.
    tableConfig: {
      get: spaceScoped('viewer').tableConfig.get.handler(({ context }) =>
        getTableConfig(deps.getDb(), context.space),
      ),
      // Token bucket (30/min, burst 10) after the access check: a debounced UI never reaches it.
      save: spaceScoped('viewer').tableConfig.save.handler(({ context, input, errors }) =>
        admitted(
          context.session.user.id,
          'tableConfig.save',
          context,
          errors,
          async () => {
            try {
              return await saveTableConfig(deps.getDb(), context.space, input.config);
            } catch (error) {
              if (error instanceof TableConfigNewerVersionError) throw errors.CONFLICT();
              throw error;
            }
          },
          undefined,
          tableConfigLimiter,
        ),
      ),
      reset: spaceScoped('viewer').tableConfig.reset.handler(({ context }) =>
        resetTableConfig(deps.getDb(), context.space),
      ),
    },
    dashboard: {
      summary: spaceScoped('viewer').dashboard.summary.handler(({ context, input, errors }) =>
        admitted(context.session.user.id, 'summary', context, errors, () =>
          getSummary(deps.getDb(), context.space, input.period, dashboardDeps),
        ),
      ),
      history: spaceScoped('viewer').dashboard.history.handler(({ context, input, errors }) =>
        admitted(context.session.user.id, 'history', context, errors, () =>
          getHistory(deps.getDb(), context.space, input.period, input.fxMode, dashboardDeps),
        ),
      ),
      movers: spaceScoped('viewer').dashboard.movers.handler(({ context, input }) =>
        getMovers(deps.getDb(), context.space, input.period),
      ),
    },
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
