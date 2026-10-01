import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { dashboardRetryDelay, shouldRetryDashboardQuery, shouldRetryQuery } from './query-retry';

describe('shouldRetryQuery', () => {
  it('never retries definitive answers', () => {
    for (const code of [
      'NOT_FOUND',
      'FORBIDDEN',
      'UNAUTHORIZED',
      'BAD_REQUEST',
      'TOO_MANY_REQUESTS',
    ]) {
      expect(shouldRetryQuery(0, new ORPCError(code))).toBe(false);
    }
  });
  it('retries transient failures twice', () => {
    expect(shouldRetryQuery(0, new TypeError('fetch failed'))).toBe(true);
    expect(shouldRetryQuery(1, new ORPCError('INTERNAL_SERVER_ERROR'))).toBe(true);
    expect(shouldRetryQuery(2, new ORPCError('INTERNAL_SERVER_ERROR'))).toBe(false);
  });
});

describe('dashboard retry policy', () => {
  const limited = (seconds?: number) =>
    new ORPCError('TOO_MANY_REQUESTS', {
      data: seconds === undefined ? undefined : { retryAfterSeconds: seconds },
    });

  it('retries a 429 twice, never the auth-style default', () => {
    expect(shouldRetryDashboardQuery(0, limited(1))).toBe(true);
    expect(shouldRetryDashboardQuery(1, limited(1))).toBe(true);
    expect(shouldRetryDashboardQuery(2, limited(1))).toBe(false);
    expect(shouldRetryQuery(0, limited(1))).toBe(false);
  });

  it('keeps the other definitive codes and transient failures as before', () => {
    expect(shouldRetryDashboardQuery(0, new ORPCError('NOT_FOUND'))).toBe(false);
    expect(shouldRetryDashboardQuery(0, new TypeError('fetch failed'))).toBe(true);
    expect(shouldRetryDashboardQuery(2, new TypeError('fetch failed'))).toBe(false);
  });

  it('waits retryAfterSeconds, between 0.5 s and 3 s', () => {
    expect(dashboardRetryDelay(0, limited(2))).toBe(2000);
    expect(dashboardRetryDelay(0, limited(1))).toBe(1000);
    expect(dashboardRetryDelay(0, limited(30))).toBe(3000);
    expect(dashboardRetryDelay(0, limited())).toBe(500);
    expect(dashboardRetryDelay(1, new TypeError('x'))).toBe(2000);
  });
});
