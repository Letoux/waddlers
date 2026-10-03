'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import {
  COLUMN_GROUPS,
  TABLE_COLUMNS_BY_ID,
  type TableColumnId,
  type TableConfigV1,
} from '@waddlers/contracts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { moveColumn, toggleColumn, visibleColumnIds } from '@/lib/table/config-state';
import { ResponsivePanel } from './responsive-panel';

const labelOf = (id: string) => TABLE_COLUMNS_BY_ID.get(id as never)?.label ?? id;

/** Column chooser (specs 16): order of the shown columns, add/remove by group, reset. */
export function ColumnChooser({
  config,
  onChange,
  onReset,
  resetting,
}: {
  config: TableConfigV1;
  onChange: (edit: (config: TableConfigV1) => TableConfigV1) => void;
  onReset: () => void;
  resetting: boolean;
}) {
  const shown = visibleColumnIds(config);
  const onlyOne = shown.length <= 1;
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const [moved, setMoved] = useState<{ id: TableColumnId; direction: -1 | 1; to: number } | null>(
    null,
  );
  const [announcement, setAnnouncement] = useState('');

  // A disabled button loses focus: after a move, focus goes back to the moved item's button in the
  // same direction, or to the other one when the item reached an end of the list (review F-F5).
  useEffect(() => {
    if (!moved) return;
    const index = shown.indexOf(moved.id);
    if (index !== moved.to) return; // the config update has not reached this render yet
    const atEnd = moved.direction === -1 ? index === 0 : index === shown.length - 1;
    const useUp = (moved.direction === -1) !== atEnd;
    buttons.current.get(`${moved.id}:${useUp ? 'up' : 'down'}`)?.focus();
    setMoved(null);
  }, [moved, shown]);

  const move = (id: TableColumnId, direction: -1 | 1) => {
    const position = visibleColumnIds(moveColumn(config, id, direction)).indexOf(id) + 1;
    setAnnouncement(`${labelOf(id)} déplacée en position ${position}`);
    setMoved({ id, direction, to: position - 1 });
    onChange((c) => moveColumn(c, id, direction));
  };
  return (
    <ResponsivePanel
      label="Colonnes"
      title="Colonnes du tableau"
      description="Choisissez les colonnes affichées et leur ordre. Vos choix sont enregistrés pour cet espace."
      testId="columns-button"
    >
      <div className="grid gap-5" data-testid="column-chooser">
        <section aria-labelledby="col-order">
          <h3 id="col-order" className="mb-2 text-sm font-medium">
            Ordre d’affichage
          </h3>
          <p role="status" aria-live="polite" className="sr-only" data-testid="column-move-status">
            {announcement}
          </p>
          <ol className="grid gap-1" data-testid="column-order">
            {shown.map((id, index) => (
              <li key={id} className="flex items-center justify-between gap-2 text-sm">
                <span>{labelOf(id)}</span>
                <span className="flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    ref={(el) => void buttons.current.set(`${id}:up`, el)}
                    aria-label={`Monter ${labelOf(id)}`}
                    disabled={index === 0}
                    onClick={() => move(id, -1)}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    ref={(el) => void buttons.current.set(`${id}:down`, el)}
                    aria-label={`Descendre ${labelOf(id)}`}
                    disabled={index === shown.length - 1}
                    onClick={() => move(id, 1)}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                </span>
              </li>
            ))}
          </ol>
        </section>
        <section aria-labelledby="col-available" className="grid gap-3">
          <h3 id="col-available" className="text-sm font-medium">
            Colonnes disponibles
          </h3>
          {onlyOne && (
            <p className="text-xs text-muted-foreground">
              Au moins une colonne doit rester affichée.
            </p>
          )}
          {COLUMN_GROUPS.map((group) => {
            const entries = config.columns.filter(
              (c) => TABLE_COLUMNS_BY_ID.get(c.id)?.group === group.id,
            );
            if (entries.length === 0) return null;
            return (
              <div
                key={group.id}
                role="group"
                aria-labelledby={`group-${group.id}`}
                className="grid gap-1.5"
              >
                <p
                  id={`group-${group.id}`}
                  className="mb-1 text-xs font-medium text-muted-foreground uppercase"
                >
                  {group.label}
                </p>
                {entries.map((entry) => {
                  const def = TABLE_COLUMNS_BY_ID.get(entry.id);
                  const pending = def?.availability !== 'available';
                  const last = entry.visible && onlyOne;
                  return (
                    <div key={entry.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`col-${entry.id}`}
                        checked={entry.visible}
                        disabled={(pending && !entry.visible) || last}
                        onCheckedChange={(v) =>
                          onChange((c) => toggleColumn(c, entry.id, v === true))
                        }
                      />
                      <Label
                        htmlFor={`col-${entry.id}`}
                        className="flex-1 text-sm font-normal aria-disabled:opacity-60"
                        aria-disabled={(pending && !entry.visible) || last}
                      >
                        {def?.label ?? entry.id}
                        {pending && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            (bientôt disponible)
                          </span>
                        )}
                      </Label>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </section>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={resetting}
          onClick={onReset}
        >
          Réinitialiser
        </Button>
      </div>
    </ResponsivePanel>
  );
}
