import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORPCError } from '@orpc/client';
import {
  defaultTableConfig,
  type TableConfigOutput,
  type TableConfigV1,
} from '@waddlers/contracts';
import { TableConfigSession, CONFIG_SAVE_ERROR } from './config-session';

const cfg = (
  density: 'comfortable' | 'compact',
  pageSize?: 25 | 50 | 100 | 200,
): TableConfigV1 => ({
  ...defaultTableConfig(),
  density,
  ...(pageSize ? { pageSize } : {}),
});
const out = (config: TableConfigV1, isDefault = false): TableConfigOutput => ({
  config,
  isDefault,
});
const density = (c: TableConfigV1): TableConfigV1 => ({ ...c, density: 'compact' });
const comfortable = (c: TableConfigV1): TableConfigV1 => ({ ...c, density: 'comfortable' });

/** One cache shared by every session, entries keyed by space (as the TanStack Query cache is). */
function makeCache(initial: Record<string, TableConfigOutput>) {
  const data = new Map(Object.entries(initial));
  const store = (spaceId: string) => ({
    get: () => data.get(spaceId),
    set: (v: TableConfigOutput) => void data.set(spaceId, v),
  });
  return { data, store };
}

describe('TableConfigSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('F-F1: after a space switch, a failing save never restores the other space config', async () => {
    const a = out(cfg('comfortable', 25));
    const b = out(cfg('comfortable', 50));
    const cache = makeCache({ A: a, B: b });
    const make = (spaceId: string, save: () => Promise<unknown>) => {
      const s = new TableConfigSession({
        store: cache.store(spaceId),
        save,
        reset: vi.fn(),
        notifyError: vi.fn(),
      });
      s.seed(cache.data.get(spaceId)!.config);
      return s;
    };
    const sessionA = make('A', vi.fn().mockResolvedValue({}));
    sessionA.update(density);
    await sessionA.flush(); // A confirmed its compact config
    // The user navigates to B (new session, as the hook builds per spaceId), its save fails.
    const sessionB = make('B', vi.fn().mockRejectedValue(new Error('down')));
    sessionB.update(density);
    await sessionB.flush();
    expect(cache.data.get('B')?.config.pageSize).toBe(50);
    expect(cache.data.get('B')?.config.density).toBe('comfortable'); // restored to B's own config
  });

  it('a failed save toasts and restores the last confirmed config', async () => {
    const cache = makeCache({ A: out(cfg('comfortable')) });
    const notifyError = vi.fn();
    const s = new TableConfigSession({
      store: cache.store('A'),
      save: vi.fn().mockRejectedValue(new Error('x')),
      reset: vi.fn(),
      notifyError,
    });
    s.seed(cfg('comfortable'));
    s.update(density);
    expect(cache.data.get('A')?.config.density).toBe('compact');
    await s.flush();
    expect(notifyError).toHaveBeenCalledWith(CONFIG_SAVE_ERROR);
    expect(cache.data.get('A')?.config.density).toBe('comfortable');
  });

  it('P3-1: UNAUTHORIZED neither toasts nor touches the cache; a halted session is inert', async () => {
    const cache = makeCache({ A: out(cfg('comfortable')) });
    const notifyError = vi.fn();
    const save = vi.fn().mockRejectedValue(new ORPCError('UNAUTHORIZED'));
    const s = new TableConfigSession({
      store: cache.store('A'),
      save,
      reset: vi.fn(),
      notifyError,
    });
    s.seed(cfg('comfortable'));
    s.update(density);
    await s.flush();
    expect(notifyError).not.toHaveBeenCalled();
    expect(cache.data.get('A')?.config.density).toBe('compact');

    s.halt();
    s.update(comfortable);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(cache.data.get('A')?.config.density).toBe('compact');
  });

  it('P3-1: halt drops an edit still waiting, and a late failure after halt stays silent', async () => {
    const cache = makeCache({ A: out(cfg('comfortable')) });
    const notifyError = vi.fn();
    let fail: (e: unknown) => void = () => {};
    const save = vi.fn(() => new Promise((_, reject) => (fail = reject)));
    const s = new TableConfigSession({
      store: cache.store('A'),
      save,
      reset: vi.fn(),
      notifyError,
    });
    s.seed(cfg('comfortable'));
    s.update(density);
    void s.flush();
    s.halt();
    fail(new Error('network'));
    await vi.advanceTimersByTimeAsync(0);
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('F-F2: reset waits for the save in flight, then resets; only later edits survive', async () => {
    const calls: string[] = [];
    let finishSave: () => void = () => {};
    const save = vi.fn(() => {
      calls.push('save');
      return new Promise<void>((r) => (finishSave = r));
    });
    let finishReset: (o: TableConfigOutput) => void = () => {};
    const reset = vi.fn(() => {
      calls.push('reset');
      return new Promise<TableConfigOutput>((r) => (finishReset = r));
    });
    const defaults = out(defaultTableConfig(), true);
    const cache = makeCache({ A: out(cfg('comfortable')) });
    const s = new TableConfigSession({
      store: cache.store('A'),
      save,
      reset,
      notifyError: vi.fn(),
    });
    s.seed(cfg('comfortable'));

    s.update((c) => ({ ...c, pageSize: 100 })); // sent, still in flight
    await vi.advanceTimersByTimeAsync(500);
    s.update(density); // waiting for its save: superseded by the reset click
    const resetting = s.reset();
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toEqual(['save']); // reset waits for the in-flight save
    s.update(comfortable); // made after the click: survives (replayed on the reset config)
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1); // nothing sent during the reset
    finishSave();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['save', 'reset']);
    finishReset(defaults);
    await resetting;
    expect(cache.data.get('A')?.config.density).toBe('comfortable');
    expect(cache.data.get('A')?.config.pageSize).toBe(defaultTableConfig().pageSize);
    // the surviving edit is saved after the reset; the superseded one never is
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(
      { ...defaultTableConfig(), density: 'comfortable' },
      { keepalive: false },
    );
  });

  it('reset without later edit stores the reset output; a failed reset restores the confirmed config', async () => {
    const cache = makeCache({ A: out(cfg('compact')) });
    const defaults = out(defaultTableConfig(), true);
    const reset = vi.fn().mockResolvedValueOnce(defaults).mockRejectedValueOnce(new Error('x'));
    const s = new TableConfigSession({
      store: cache.store('A'),
      save: vi.fn().mockResolvedValue({}),
      reset,
      notifyError: vi.fn(),
    });
    s.seed(cfg('compact'));
    await s.reset();
    expect(cache.data.get('A')).toEqual(defaults);
    s.update(density);
    await s.flush();
    await expect(s.reset()).rejects.toThrow('x');
    expect(cache.data.get('A')?.config.density).toBe('compact');
  });
});
