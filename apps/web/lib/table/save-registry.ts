/**
 * The table-config savers that exist in this tab. Logout must send the last edit BEFORE the session
 * ends (a save sent after it is UNAUTHORIZED), then silence every saver (D27, audit P3-1).
 */
type Entry = { flush: () => Promise<void>; halt: () => void };

const entries = new Set<Entry>();

export function registerSaveEntry(entry: Entry): () => void {
  entries.add(entry);
  return () => void entries.delete(entry);
}

export const LOGOUT_FLUSH_MS = 1000;

/** Waits for every saver to send its last edit, at most `timeoutMs`. Never rejects. */
export async function flushPendingSaves(timeoutMs = LOGOUT_FLUSH_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const flushed = Promise.all([...entries].map((e) => e.flush().catch(() => undefined)));
  await Promise.race([flushed, timeout]);
  clearTimeout(timer);
}

/** After logout: no saver sends, toasts or writes the cache any more. */
export function haltPendingSaves(): void {
  for (const entry of entries) entry.halt();
}
