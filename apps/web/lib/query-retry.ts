import { ORPCError } from '@orpc/client';
import { retryAfterSeconds } from './dashboard/labels';

const DEFINITIVE = new Set([
  'NOT_FOUND',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'BAD_REQUEST',
  'TOO_MANY_REQUESTS',
]);

/**
 * Query retry policy: an answer such as NOT_FOUND (revoked space), FORBIDDEN or TOO_MANY_REQUESTS (auth: an immediate retry would only burn the cap) will not change
 * by asking again, so it is shown at once; transient failures (network, 5xx) get two retries.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ORPCError && DEFINITIVE.has(error.code)) return false;
  return failureCount < 2;
}

const isRateLimited = (error: unknown) =>
  error instanceof ORPCError && error.code === 'TOO_MANY_REQUESTS';

/** Dashboard 429 retries: at most two, each after the server's `retryAfterSeconds`. */
export const DASHBOARD_RATE_LIMIT_RETRIES = 2;
const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 3_000;

/**
 * Retry policy of the dashboard queries only (`summary`, `history`): a normal period change can
 * momentarily touch the server's per-user cap, so a 429 is retried twice, after the wait the
 * server asked for. Everything else follows `shouldRetryQuery` (auth keeps 429 non-retried).
 */
export function shouldRetryDashboardQuery(failureCount: number, error: unknown): boolean {
  if (isRateLimited(error)) return failureCount < DASHBOARD_RATE_LIMIT_RETRIES;
  return shouldRetryQuery(failureCount, error);
}

/** 429: `retryAfterSeconds` clamped to [0.5 s, 3 s]; otherwise TanStack's default backoff. */
export function dashboardRetryDelay(failureCount: number, error: unknown): number {
  if (isRateLimited(error)) {
    const seconds = retryAfterSeconds(error);
    return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, (seconds ?? 0) * 1000));
  }
  return Math.min(1000 * 2 ** failureCount, 30_000);
}
