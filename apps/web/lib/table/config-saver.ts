import type { TableConfigV1 } from '@waddlers/contracts';

export const SAVE_DEBOUNCE_MS = 500;

/** `keepalive`: the page is being hidden; the request must outlive it. */
export type SaveContext = { keepalive: boolean };

type Options = {
  delayMs?: number;
  /** Sends the FULL config. */
  save: (config: TableConfigV1, context: SaveContext) => Promise<unknown>;
  /** The server confirmed `config`. */
  onSaved: (config: TableConfigV1) => void;
  /** The save of `config` failed; `hasNewer` = a later edit is already waiting. */
  onError: (error: unknown, config: TableConfigV1, hasNewer: boolean) => void;
};

/**
 * Debounced, serial saver of the table config (specs 19, D27). Every edit calls `schedule` with the
 * FULL new config; only the last one within the delay is sent (never diffs). A save in flight is
 * never overlapped: a newer config waits for it, so the server always ends with the last edit.
 * `hold()` suspends sending (a reset runs meanwhile); `idle()` resolves once nothing is in flight.
 */
export class ConfigSaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: TableConfigV1 | null = null;
  private running: Promise<void> | null = null;
  private held = false;
  private keepalive = false;

  constructor(private readonly options: Options) {}

  schedule(config: TableConfigV1) {
    this.pending = config;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.options.delayMs ?? SAVE_DEBOUNCE_MS);
  }

  hasPending() {
    return this.pending !== null || this.running !== null;
  }

  /** Drops the waiting edit (a reset supersedes it). A request already sent is not recalled. */
  cancel() {
    this.clearTimer();
    this.pending = null;
  }

  /** Suspends sending; the request already in flight finishes. */
  hold() {
    this.held = true;
  }

  release() {
    this.held = false;
  }

  /** Resolves when no request is in flight. */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /**
   * Sends the waiting edit now (unmount, page hide, logout) and resolves once it, and any edit made
   * meanwhile, has been answered. A save already in flight is awaited, not duplicated.
   */
  flush(context: { keepalive?: boolean } = {}): Promise<void> {
    this.clearTimer();
    if (context.keepalive) this.keepalive = true;
    if (this.running) return this.running;
    if (this.held || !this.pending) return Promise.resolve();
    const run = this.drain().finally(() => {
      this.running = null;
      this.keepalive = false;
    });
    this.running = run;
    return run;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async drain() {
    // An edit made during a request is sent right away if its timer already fired (timer === null).
    while (!this.held && this.pending) {
      const config = this.pending;
      this.pending = null;
      try {
        await this.options.save(config, { keepalive: this.keepalive });
        this.options.onSaved(config);
      } catch (error) {
        this.options.onError(error, config, this.pending !== null);
      }
      if (this.timer) break;
    }
  }
}
