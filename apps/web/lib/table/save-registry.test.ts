import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPendingSaves, haltPendingSaves, registerSaveEntry } from './save-registry';

describe('save registry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flush waits for every registered saver', async () => {
    let release: () => void = () => {};
    const slow = vi.fn(() => new Promise<void>((r) => (release = r)));
    const off = registerSaveEntry({ flush: slow, halt: vi.fn() });
    let done = false;
    void flushPendingSaves(1000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    off();
  });

  it('is bounded: a hung save does not block the logout past the timeout', async () => {
    const off = registerSaveEntry({ flush: () => new Promise<void>(() => {}), halt: vi.fn() });
    let done = false;
    void flushPendingSaves(1000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    off();
  });

  it('a failing flush does not reject; halt reaches every saver; unregistered ones are left', async () => {
    const halt = vi.fn();
    const gone = vi.fn();
    const off = registerSaveEntry({ flush: () => Promise.reject(new Error('x')), halt });
    registerSaveEntry({ flush: async () => {}, halt: gone })();
    await expect(flushPendingSaves(1000)).resolves.toBeUndefined();
    haltPendingSaves();
    expect(halt).toHaveBeenCalledTimes(1);
    expect(gone).not.toHaveBeenCalled();
    off();
  });
});
