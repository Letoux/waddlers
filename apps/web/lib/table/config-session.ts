import { ORPCError } from '@orpc/client';
import type { TableConfigOutput, TableConfigV1 } from '@waddlers/contracts';
import { spaceFailureKind } from '@/lib/spaces/errors';
import { ConfigSaver, type SaveContext } from './config-saver';
import { CONFIG_CONFLICT_MESSAGE, isConfigConflict } from './save-policy';

export const CONFIG_SAVE_ERROR = 'Impossible d’enregistrer la configuration. Elle a été restaurée.';

type Edit = (config: TableConfigV1) => TableConfigV1;

/** Where the optimistic config of ONE space lives (the TanStack Query cache entry). */
export type ConfigStore = {
  get: () => TableConfigOutput | undefined;
  set: (value: TableConfigOutput) => void;
};

type Deps = {
  store: ConfigStore;
  save: (config: TableConfigV1, context: SaveContext) => Promise<unknown>;
  reset: () => Promise<TableConfigOutput>;
  notifyError: (message: string) => void;
  delayMs?: number;
};

const isUnauthorized = (error: unknown) =>
  error instanceof ORPCError && error.code === 'UNAUTHORIZED';

/**
 * The table config of ONE space for ONE mounted view: optimistic edits, the debounced saver, the
 * last config the server confirmed, reset. Everything that must not leak from a space to another
 * (`confirmed`, the pending edit) is an instance field, and the hook builds one session per
 * `spaceId` (review F-F1).
 */
export class TableConfigSession {
  private confirmed: TableConfigV1 | null = null;
  private halted = false;
  /** Bumped by each reset click: a stale reset answer never overwrites a newer one. */
  private generation = 0;
  /** Edits made after the reset click, replayed on the reset result (null = no reset running). */
  private afterReset: Edit[] | null = null;
  private readonly saver: ConfigSaver;

  constructor(private readonly deps: Deps) {
    this.saver = new ConfigSaver({
      ...(deps.delayMs !== undefined ? { delayMs: deps.delayMs } : {}),
      save: deps.save,
      onSaved: (config) => {
        if (!this.halted) this.confirmed = config;
      },
      onError: (error, _config, hasNewer) => this.onSaveError(error, hasNewer),
    });
  }

  /** Remembers the first config the server gave (no-op once known). */
  seed(config: TableConfigV1) {
    this.confirmed ??= config;
  }

  update(edit: Edit) {
    if (this.halted) return;
    const current = this.deps.store.get();
    if (!current) return;
    const next = edit(current.config);
    if (next === current.config) return;
    this.deps.store.set({ config: next, isDefault: false });
    if (this.afterReset) this.afterReset.push(edit);
    else this.saver.schedule(next);
  }

  /** Sends the waiting edit; resolves when the server has answered. */
  flush(context?: { keepalive?: boolean }): Promise<void> {
    return this.halted ? Promise.resolve() : this.saver.flush(context);
  }

  /** Logout: inert from now on (no request, no toast, no cache write). */
  halt() {
    this.halted = true;
    this.saver.cancel();
  }

  /**
   * Waits for the save in flight, then resets on the server. The edit still waiting for its save is
   * superseded; edits made after the click are replayed on the reset config and saved (last write
   * wins). On failure the last confirmed config comes back, with the edits made after the click.
   */
  async reset(): Promise<TableConfigOutput | null> {
    const generation = ++this.generation;
    this.saver.cancel();
    this.saver.hold();
    this.afterReset = [];
    let output: TableConfigOutput | null = null;
    try {
      await this.saver.idle();
      output = await this.deps.reset();
      if (output) this.confirmed = output.config;
    } finally {
      if (generation === this.generation) this.finishReset(output);
    }
    return output;
  }

  private finishReset(output: TableConfigOutput | null) {
    const edits = this.afterReset ?? [];
    this.afterReset = null;
    this.saver.release();
    if (this.halted) return;
    const base = output?.config ?? this.confirmed ?? this.deps.store.get()?.config;
    if (!base) return;
    const next = edits.reduce((config, edit) => edit(config), base);
    if (next === base && output) this.deps.store.set(output);
    else this.deps.store.set({ config: next, isDefault: false });
    if (next !== base) this.saver.schedule(next);
  }

  private onSaveError(error: unknown, hasNewer: boolean) {
    if (this.halted || isUnauthorized(error)) return; // session over: nothing to say, nothing to restore
    if (isConfigConflict(error)) this.deps.notifyError(CONFIG_CONFLICT_MESSAGE);
    else if (spaceFailureKind(error) !== 'not_found') this.deps.notifyError(CONFIG_SAVE_ERROR);
    if (hasNewer || this.afterReset || !this.confirmed) return;
    this.deps.store.set({ config: this.confirmed, isDefault: false });
  }
}
