import type { TableConfigV1 } from '@waddlers/contracts';

export const SAVE_DEBOUNCE_MS = 500;

type Options = {
  delayMs?: number;
  /** Sends the FULL config. */
  save: (config: TableConfigV1) => Promise<unknown>;
  /** The server confirmed `config`. */
  onSaved: (config: TableConfigV1) => void;
  /** The save of `config` failed; `hasNewer` = a later edit is already waiting. */
  onError: (error: unknown, config: TableConfigV1, hasNewer: boolean) => void;
};

/**
 * Debounced, serial saver of the table config (specs 19, D27). Every edit calls `schedule` with the
 * FULL new config; only the last one within the delay is sent (never diffs). A save in flight is
 * never overlapped: a newer config waits for it, so the server always ends with the last edit.
 */
export class ConfigSaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: TableConfigV1 | null = null;
  private inFlight = false;

  constructor(private readonly options: Options) {}

  schedule(config: TableConfigV1) {
    this.pending = config;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.options.delayMs ?? SAVE_DEBOUNCE_MS);
  }

  hasPending() {
    return this.pending !== null || this.inFlight;
  }

  /** Drops the waiting edit (a reset supersedes it). A request already sent is not recalled. */
  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  /** Sends the waiting edit now (unmount, page hide). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight || !this.pending) return;
    const config = this.pending;
    this.pending = null;
    this.inFlight = true;
    try {
      await this.options.save(config);
      this.options.onSaved(config);
    } catch (error) {
      this.options.onError(error, config, this.pending !== null);
    } finally {
      this.inFlight = false;
    }
    // An edit made during the request was scheduled; send it right away if its timer already fired.
    if (this.pending && !this.timer) await this.flush();
  }
}
