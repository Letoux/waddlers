import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { shouldRetryQuery } from './query-retry';

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
