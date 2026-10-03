import { ORPCError } from '@orpc/client';
import { describe, expect, it, vi } from 'vitest';
import { isConfigConflict, saveWithRetry } from './save-policy';

const tooMany = (seconds: number) =>
  new ORPCError('TOO_MANY_REQUESTS', { data: { retryAfterSeconds: seconds } });

describe('saveWithRetry', () => {
  it('returns the first answer when there is no error', async () => {
    const save = vi.fn().mockResolvedValue('ok');
    await expect(saveWithRetry(save)).resolves.toBe('ok');
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('retries a 429 once, after the server delay clamped to 0.5-3 s', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const save = vi.fn().mockRejectedValueOnce(tooMany(2)).mockResolvedValue('ok');
    await expect(saveWithRetry(save, undefined, sleep)).resolves.toBe('ok');
    expect(sleep).toHaveBeenCalledWith(2000);
    const long = vi.fn().mockRejectedValueOnce(tooMany(60)).mockResolvedValue('ok');
    await saveWithRetry(long, undefined, sleep);
    expect(sleep).toHaveBeenLastCalledWith(3000);
  });
  it('gives up after the second 429 and never retries other errors', async () => {
    const twice = vi.fn().mockRejectedValue(tooMany(1));
    await expect(
      saveWithRetry(twice, undefined, vi.fn().mockResolvedValue(undefined)),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(twice).toHaveBeenCalledTimes(2);
    const boom = vi.fn().mockRejectedValue(new ORPCError('INTERNAL_SERVER_ERROR'));
    await expect(saveWithRetry(boom)).rejects.toBeInstanceOf(ORPCError);
    expect(boom).toHaveBeenCalledTimes(1);
  });
  it('does not retry when shouldContinue is false after the sleep', async () => {
    const save = vi.fn().mockRejectedValue(tooMany(1));
    await expect(
      saveWithRetry(save, () => false, vi.fn().mockResolvedValue(undefined)),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('recognises the 409 conflict', () => {
    expect(isConfigConflict(new ORPCError('CONFLICT'))).toBe(true);
    expect(isConfigConflict(new Error('x'))).toBe(false);
  });
});
