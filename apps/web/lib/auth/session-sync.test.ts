import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_CHANNEL,
  TAB_ID,
  broadcastSessionChange,
  makeSessionChangeHandler,
} from './session-sync';

describe('session sync', () => {
  it('a login or logout message clears the cache then reloads; anything else is ignored', () => {
    const order: string[] = [];
    const handle = makeSessionChangeHandler(
      { clear: () => order.push('clear'), reload: () => order.push('reload') },
      'me',
    );
    handle({ change: 'logout', from: 'other' });
    handle({ change: 'login', from: 'other' });
    handle('logout');
    handle({ change: 'hello', from: 'other' });
    handle(undefined);
    expect(order).toEqual(['clear', 'reload', 'clear', 'reload']);
  });

  it('ignores the echo of its own message (BroadcastChannel also delivers inside the sender tab)', () => {
    const actions = { clear: vi.fn(), reload: vi.fn() };
    makeSessionChangeHandler(actions, 'me')({ change: 'logout', from: 'me' });
    expect(actions.clear).not.toHaveBeenCalled();
    expect(actions.reload).not.toHaveBeenCalled();
  });

  it('broadcasts on the BroadcastChannel when there is one', () => {
    const postMessage = vi.fn();
    const close = vi.fn();
    const ctor = vi.fn(function (this: unknown) {
      Object.assign(this as object, { postMessage, close });
    }) as unknown as typeof BroadcastChannel;
    broadcastSessionChange('logout', { BroadcastChannel: ctor });
    expect(ctor).toHaveBeenCalledWith(SESSION_CHANNEL);
    expect(postMessage).toHaveBeenCalledWith({ change: 'logout', from: TAB_ID });
    expect(close).toHaveBeenCalled();
  });

  it('falls back to a storage write with a fresh value each time, and never throws', () => {
    const setItem = vi.fn();
    const removeItem = vi.fn();
    broadcastSessionChange('login', { localStorage: { setItem, removeItem } });
    broadcastSessionChange('login', { localStorage: { setItem, removeItem } });
    const [first, second] = setItem.mock.calls.map((c) => c[1] as string);
    expect(setItem.mock.calls[0]?.[0]).toBe(SESSION_CHANNEL);
    expect(first).toMatch(/^login:/);
    expect(first).not.toBe(second);
    expect(() =>
      broadcastSessionChange('login', {
        localStorage: {
          setItem: () => {
            throw new Error('blocked');
          },
          removeItem,
        },
      }),
    ).not.toThrow();
  });
});
