'use client';

import { useRef, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import type { PositionRow } from '@waddlers/contracts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { spaceFailureKind } from '@/lib/spaces/errors';
import { useRemovePosition } from '@/lib/spaces/use-positions';

export function RemovePositionButton({
  spaceId,
  row,
  onRemoved,
}: {
  spaceId: string;
  row: PositionRow;
  /** The row disappears: the parent moves focus somewhere sensible. */
  onRemoved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const gone = useRef(false);
  const mutation = useRemovePosition(spaceId, row.id);
  const name = row.instrument.name;

  const confirm = () => {
    if (mutation.isPending) return; // double click: one request
    mutation.mutate(
      { spaceId, positionId: row.id },
      {
        onSuccess: () => {
          gone.current = true;
          setOpen(false);
          // The trigger disappears with the row: hand focus to the list region once the dialog
          // has released it.
          requestAnimationFrame(onRemoved);
        },
        onError: (error) => {
          // Already removed elsewhere: same outcome for the user, no error.
          if (spaceFailureKind(error) === 'not_found') {
            gone.current = true;
            setOpen(false);
            requestAnimationFrame(onRemoved);
          }
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && setOpen(next)}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`Retirer ${name} de l’espace`}
        >
          <Trash2 aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent
        onCloseAutoFocus={(event) => {
          // The trigger no longer exists after a removal: `onRemoved` (called on success) moves
          // focus; do not let the dialog restore it to a stale element.
          if (gone.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Retirer ce titre ?</DialogTitle>
          <DialogDescription>
            {name} ({row.listing.symbol}) sera retiré de cet espace. Les autres espaces ne sont pas
            modifiés.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => setOpen(false)}
          >
            Annuler
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={mutation.isPending}
            onClick={confirm}
          >
            {mutation.isPending && <Loader2 className="animate-spin" aria-hidden />}
            Retirer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
