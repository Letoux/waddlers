'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import { COLUMN_GROUPS, TABLE_COLUMNS_BY_ID, type TableConfigV1 } from '@waddlers/contracts';
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
                    aria-label={`Monter ${labelOf(id)}`}
                    disabled={index === 0}
                    onClick={() => onChange((c) => moveColumn(c, id, -1))}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={`Descendre ${labelOf(id)}`}
                    disabled={index === shown.length - 1}
                    onClick={() => onChange((c) => moveColumn(c, id, 1))}
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
