'use client';

import { useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import type { PositionRow } from '@waddlers/contracts';
import { Input } from '@/components/ui/input';
import {
  formatQuantity,
  parseQuantityInput,
  quantityToEditText,
  UNAVAILABLE,
} from '@/lib/spaces/quantity';
import { useSetQuantity } from '@/lib/spaces/use-positions';

/** Display of a quantity: `—` for a missing value, never 0. */
export function QuantityValue({ quantity }: { quantity: string | null }) {
  return (
    <span className="tabular-nums">
      {formatQuantity(quantity)}
      {quantity === null && <span className="sr-only"> (quantité non renseignée)</span>}
    </span>
  );
}

/**
 * Inline editor: click to edit, Enter or blur saves, Escape cancels. A French comma decimal is
 * accepted; an empty field clears the quantity (`null`, shown as `—`). Read-only when `canEdit`
 * is false (viewers).
 */
export function QuantityCell({
  spaceId,
  row,
  canEdit,
  onSaved,
}: {
  spaceId: string;
  row: PositionRow;
  canEdit: boolean;
  onSaved: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Guards against Enter followed by the blur fired while the input unmounts, and Escape+blur.
  const settled = useRef(false);
  const name = row.instrument.name;
  const mutation = useSetQuantity(spaceId, row.id, () =>
    onSaved(`Quantité de ${name} mise à jour.`),
  );

  if (!canEdit) return <QuantityValue quantity={row.quantity} />;

  const close = (refocus: boolean) => {
    setEditing(false);
    setError(null);
    if (refocus) requestAnimationFrame(() => buttonRef.current?.focus());
  };

  // `viaEnter`: only the Enter path may pull focus back to the field; on blur the user has
  // already moved on (Tab, click), so an invalid value just keeps its message visible.
  const commit = (viaEnter: boolean) => {
    if (settled.current) return;
    const parsed = parseQuantityInput(inputRef.current?.value ?? '');
    if (!parsed.ok) {
      setError(parsed.message);
      if (viaEnter) inputRef.current?.focus();
      return;
    }
    settled.current = true;
    if (parsed.value !== row.quantity) {
      mutation.mutate({ spaceId, positionId: row.id, quantity: parsed.value });
    }
    close(viaEnter);
  };

  if (editing) {
    const errorId = `qty-error-${row.id}`;
    return (
      <div className="grid gap-1">
        <Input
          ref={inputRef}
          autoFocus
          inputMode="decimal"
          autoComplete="off"
          aria-label={`Quantité de ${name}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          defaultValue={quantityToEditText(row.quantity)}
          className="h-8 w-32 text-right tabular-nums"
          onFocus={(e) => e.currentTarget.select()}
          onChange={() => setError(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              settled.current = true;
              close(true);
            }
          }}
          onBlur={() => commit(false)}
        />
        <p id={errorId} aria-live="polite" className="max-w-56 text-xs text-destructive">
          {error}
        </p>
      </div>
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={`Modifier la quantité de ${name} (actuelle : ${
        row.quantity === null ? UNAVAILABLE : formatQuantity(row.quantity)
      })`}
      className="group inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 -mx-1.5 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      onClick={() => {
        settled.current = false;
        setEditing(true);
      }}
    >
      <QuantityValue quantity={row.quantity} />
      <Pencil
        aria-hidden
        className="size-3 text-muted-foreground opacity-60 group-hover:opacity-100"
      />
    </button>
  );
}
