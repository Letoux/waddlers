import { ORPCError } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { INTERNAL_ERROR_MESSAGE, safeErrorInterceptor, toSafeError } from './errors';

describe('toSafeError', () => {
  it('preserves known ORPCErrors', () => {
    const known = new ORPCError('NOT_FOUND', { message: 'Space not found' });
    const log = vi.fn();
    expect(toSafeError(known, log)).toBe(known);
    expect(log).not.toHaveBeenCalled();
  });

  it('maps unknown errors to a neutral INTERNAL_SERVER_ERROR and logs the original', () => {
    const raw = new Error('relation "users" does not exist at postgres://u:pw@host/db');
    const log = vi.fn();
    const safe = toSafeError(raw, log);
    expect(safe).toBeInstanceOf(ORPCError);
    expect(safe.code).toBe('INTERNAL_SERVER_ERROR');
    expect(safe.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(JSON.stringify(safe.toJSON())).not.toMatch(/relation|postgres|pw/);
    expect(safe.cause).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.any(String), raw);
  });

  it('interceptor rethrows the safe error and returns successful results untouched', async () => {
    const interceptor = safeErrorInterceptor(() => {});
    await expect(interceptor({ next: async () => 42 })).resolves.toBe(42);
    await expect(
      interceptor({
        next: async () => {
          throw new TypeError('boom');
        },
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: INTERNAL_ERROR_MESSAGE });
  });
});
