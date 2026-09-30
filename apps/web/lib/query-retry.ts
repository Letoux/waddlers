import { ORPCError } from '@orpc/client';

const DEFINITIVE = new Set(['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED', 'BAD_REQUEST']);

/**
 * Query retry policy: an answer such as NOT_FOUND (revoked space) or FORBIDDEN will not change
 * by asking again, so it is shown at once; transient failures (network, 5xx) get two retries.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ORPCError && DEFINITIVE.has(error.code)) return false;
  return failureCount < 2;
}
