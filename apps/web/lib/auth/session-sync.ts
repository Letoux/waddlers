/**
 * Multi-tab session changes (audit P3-2). A login or logout in one tab tells the others, which drop
 * their query cache and hard-reload: a tab must never keep showing (or saving) another user's data.
 * `BroadcastChannel` when available, a `storage` event otherwise (it fires in the OTHER tabs only).
 */
export const SESSION_CHANNEL = 'waddlers-auth';
export type SessionChange = 'login' | 'logout';

/**
 * A `BroadcastChannel` also delivers to the OTHER channel objects of the sender's own tab (the
 * listener in `Providers`), so every message carries its sender and a tab ignores its own.
 */
export const TAB_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : String(Math.random());

export type SessionMessage = { change: SessionChange; from: string };

type Env = {
  BroadcastChannel?: typeof BroadcastChannel | undefined;
  localStorage?: Pick<Storage, 'setItem' | 'removeItem'> | undefined;
};

const isMessage = (value: unknown): value is SessionMessage => {
  if (typeof value !== 'object' || value === null) return false;
  const { change, from } = value as Partial<SessionMessage>;
  return (change === 'login' || change === 'logout') && typeof from === 'string';
};

function currentEnv(): Env {
  const env: Env = {};
  if (typeof BroadcastChannel !== 'undefined') env.BroadcastChannel = BroadcastChannel;
  try {
    env.localStorage = window.localStorage;
  } catch {
    // storage blocked: the channel (or nothing) is all there is
  }
  return env;
}

export function broadcastSessionChange(change: SessionChange, env: Env = currentEnv()): void {
  try {
    if (env.BroadcastChannel) {
      const channel = new env.BroadcastChannel(SESSION_CHANNEL);
      channel.postMessage({ change, from: TAB_ID } satisfies SessionMessage);
      channel.close();
      return;
    }
    // A fresh value each time: `storage` only fires when the value changes.
    env.localStorage?.setItem(
      SESSION_CHANNEL,
      `${change}:${TAB_ID}:${Date.now()}:${Math.random()}`,
    );
    env.localStorage?.removeItem(SESSION_CHANNEL);
  } catch {
    // best effort: the other tabs discover the change on their next request (401 -> /login)
  }
}

/** What another tab's session change does here: clear the cache, then reload. */
export function makeSessionChangeHandler(
  actions: { clear: () => void; reload: () => void },
  self: string = TAB_ID,
) {
  return (message: unknown) => {
    if (!isMessage(message) || message.from === self) return;
    actions.clear();
    actions.reload();
  };
}

/** Subscribes `handler`; returns the unsubscribe. */
export function listenSessionChange(
  handler: (message: unknown) => void,
  env: Env = currentEnv(),
): () => void {
  if (env.BroadcastChannel) {
    const channel = new env.BroadcastChannel(SESSION_CHANNEL);
    channel.onmessage = (event: MessageEvent) => handler(event.data);
    return () => channel.close();
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SESSION_CHANNEL || event.newValue === null) return;
    const [change, from] = event.newValue.split(':');
    handler({ change, from });
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
