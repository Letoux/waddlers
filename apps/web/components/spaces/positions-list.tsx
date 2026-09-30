'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import type { PositionRow } from '@waddlers/contracts';
import { QuantityCell } from '@/components/spaces/quantity-cell';
import { RemovePositionButton } from '@/components/spaces/remove-position-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { spaceFailureKind } from '@/lib/spaces/errors';
import { isTruncated } from '@/lib/spaces/truncation';
import { usePositionsQuery } from '@/lib/spaces/use-positions';

const TYPE_LABELS = { stock: 'Action', etf: 'ETF' } as const;

function PositionItem({
  spaceId,
  row,
  canEdit,
  onSaved,
  onRemoved,
}: {
  spaceId: string;
  row: PositionRow;
  canEdit: boolean;
  onSaved: (message: string) => void;
  onRemoved: () => void;
}) {
  const { instrument, listing } = row;
  return (
    <tr
      data-testid="position-row"
      className="relative flex flex-col gap-1 border-b py-3 md:table-row md:py-0"
    >
      <td className="block pr-10 md:table-cell md:px-3 md:py-2.5 md:align-top">
        <p className="font-medium">{instrument.name}</p>
        {row.selectionReason && (
          <p className="text-xs text-muted-foreground">{row.selectionReason}</p>
        )}
      </td>
      <td className="hidden text-sm text-muted-foreground md:table-cell md:px-3 md:py-2.5">
        {TYPE_LABELS[instrument.type]}
      </td>
      <td className="block text-sm md:table-cell md:px-3 md:py-2.5">
        <span className="text-muted-foreground md:hidden">{TYPE_LABELS[instrument.type]} · </span>
        <span className="font-mono">{listing.symbol}</span>
        <span className="text-muted-foreground md:hidden">
          {' '}
          · {listing.exchange.name} ({listing.exchange.mic}) · {listing.currency}
        </span>
      </td>
      <td className="hidden text-sm md:table-cell md:px-3 md:py-2.5">
        {listing.exchange.name}{' '}
        <span className="text-muted-foreground">({listing.exchange.mic})</span>
      </td>
      <td className="hidden text-sm md:table-cell md:px-3 md:py-2.5">{listing.currency}</td>
      <td className="flex items-center justify-between gap-2 text-sm md:table-cell md:px-3 md:py-2.5 md:text-right">
        <span className="text-muted-foreground md:hidden">Quantité</span>
        <span data-testid="quantity" className="inline-flex justify-end">
          <QuantityCell spaceId={spaceId} row={row} canEdit={canEdit} onSaved={onSaved} />
        </span>
      </td>
      {canEdit && (
        <td className="absolute top-2 right-0 md:static md:table-cell md:px-1 md:py-1.5 md:text-right">
          <RemovePositionButton spaceId={spaceId} row={row} onRemoved={onRemoved} />
        </td>
      )}
    </tr>
  );
}

/** Simple positions list (S3). The configurable table (TanStack Table) arrives with S6. */
export function PositionsList({ spaceId, canEdit }: { spaceId: string; canEdit: boolean }) {
  const query = usePositionsQuery(spaceId);
  const [announcement, setAnnouncement] = useState('');
  const regionRef = useRef<HTMLDivElement>(null);
  const focusRegion = () => regionRef.current?.focus();

  let content;
  if (query.isPending) {
    content = (
      <div className="grid gap-2" role="status" aria-label="Chargement des titres">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  } else if (query.isError && !query.data) {
    const gone = spaceFailureKind(query.error) === 'not_found';
    content = (
      <div className="grid max-w-md gap-4">
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{gone ? 'Espace indisponible' : 'Une erreur est survenue'}</AlertTitle>
          <AlertDescription>
            {gone
              ? 'Cet espace n’est plus disponible.'
              : 'Les titres ne sont pas disponibles pour le moment. Veuillez réessayer.'}
          </AlertDescription>
        </Alert>
        {gone ? (
          <Button asChild variant="outline" className="w-fit">
            <Link href="/espaces">Voir mes espaces</Link>
          </Button>
        ) : (
          <Button variant="outline" className="w-fit" onClick={() => void query.refetch()}>
            Réessayer
          </Button>
        )}
      </div>
    );
  } else if (query.data && query.data.rows.length === 0) {
    content = <p className="text-muted-foreground">Aucun titre dans cet espace.</p>;
  } else if (query.data) {
    const { rows, total } = query.data;
    const truncated = isTruncated(query.data);
    content = (
      <div className="grid gap-3">
        {truncated && (
          <p role="status" className="text-sm text-muted-foreground">
            Seuls les {rows.length.toLocaleString('fr-FR')} premiers titres sur{' '}
            {total.toLocaleString('fr-FR')} sont affichés.
          </p>
        )}
        <table className="block w-full text-left md:table">
          <caption className="sr-only">Titres de l’espace</caption>
          <thead className="hidden text-xs text-muted-foreground md:table-header-group">
            <tr className="border-b">
              <th scope="col" className="px-3 py-2 font-medium">
                Titre
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Type
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Symbole
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Place
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Devise
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Quantité
              </th>
              {canEdit && (
                <th scope="col" className="px-1 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="block md:table-row-group">
            {rows.map((row) => (
              <PositionItem
                key={row.id}
                spaceId={spaceId}
                row={row}
                canEdit={canEdit}
                onSaved={setAnnouncement}
                onRemoved={focusRegion}
              />
            ))}
          </tbody>
        </table>
        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            Lecture seule : vous êtes lecteur de cet espace.
          </p>
        )}
      </div>
    );
  }

  return (
    <div ref={regionRef} tabIndex={-1} className="outline-none" aria-label="Liste des titres">
      <div role="status" aria-live="polite" className="sr-only" data-testid="save-status">
        {announcement}
      </div>
      {content}
    </div>
  );
}
