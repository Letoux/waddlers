import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTableConfig, type TableConfigV1 } from '@waddlers/contracts';
import { ConfigSaver } from './config-saver';

const cfg = (density: 'comfortable' | 'compact'): TableConfigV1 => ({
  ...defaultTableConfig(),
  density,
});

describe('ConfigSaver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces: only the last full config within 500 ms is sent', async () => {
    const save = vi.fn().mockResolvedValue({});
    const onSaved = vi.fn();
    const saver = new ConfigSaver({ save, onSaved, onError: vi.fn() });
    saver.schedule(cfg('comfortable'));
    await vi.advanceTimersByTimeAsync(300);
    saver.schedule(cfg('compact'));
    await vi.advanceTimersByTimeAsync(499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      cfg('compact'),
      expect.objectContaining({ keepalive: false }),
    );
    expect(onSaved).toHaveBeenCalledWith(cfg('compact'));
  });

  it('never overlaps requests: an edit during a save is sent after it', async () => {
    let release: () => void = () => {};
    const save = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockResolvedValue({});
    const saver = new ConfigSaver({ save, onSaved: vi.fn(), onError: vi.fn() });
    saver.schedule(cfg('comfortable'));
    await vi.advanceTimersByTimeAsync(500);
    saver.schedule(cfg('compact'));
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(
      cfg('compact'),
      expect.objectContaining({ keepalive: false }),
    );
  });

  it('reports a failure with the config that failed', async () => {
    const error = new Error('boom');
    const onError = vi.fn();
    const saver = new ConfigSaver({
      save: vi.fn().mockRejectedValue(error),
      onSaved: vi.fn(),
      onError,
    });
    saver.schedule(cfg('compact'));
    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalledWith(error, cfg('compact'), false);
    expect(saver.hasPending()).toBe(false);
  });

  it('flush sends at once; cancel drops the waiting edit', async () => {
    const save = vi.fn().mockResolvedValue({});
    const saver = new ConfigSaver({ save, onSaved: vi.fn(), onError: vi.fn() });
    saver.schedule(cfg('compact'));
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
    saver.schedule(cfg('comfortable'));
    saver.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flush awaits a save already in flight (and the edit queued behind it)', async () => {
    let release: () => void = () => {};
    const save = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockResolvedValue({});
    const saver = new ConfigSaver({ save, onSaved: vi.fn(), onError: vi.fn() });
    saver.schedule(cfg('comfortable'));
    await vi.advanceTimersByTimeAsync(500);
    saver.schedule(cfg('compact'));
    let done = false;
    void saver.flush().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('hold suspends sending until release; idle waits for the request in flight', async () => {
    const save = vi.fn().mockResolvedValue({});
    const saver = new ConfigSaver({ save, onSaved: vi.fn(), onError: vi.fn() });
    saver.hold();
    saver.schedule(cfg('compact'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
    saver.release();
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
    await expect(saver.idle()).resolves.toBeUndefined();
  });

  it('a page-hide flush asks for keepalive', async () => {
    const save = vi.fn().mockResolvedValue({});
    const saver = new ConfigSaver({ save, onSaved: vi.fn(), onError: vi.fn() });
    saver.schedule(cfg('compact'));
    await saver.flush({ keepalive: true });
    expect(save).toHaveBeenCalledWith(cfg('compact'), expect.objectContaining({ keepalive: true }));
  });
});
