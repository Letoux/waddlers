'use client';

import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ROLE_LABELS } from '@/lib/spaces/errors';
import { spaceHref } from '@/lib/spaces/nav';
import { useSetActiveSpace, useSpacesQuery } from '@/lib/spaces/use-spaces';

/** Spaces the user can access, with role and count. Creating/renaming is admin-only. */
export function SpacesList() {
  const query = useSpacesQuery({ fresh: true });
  const setActive = useSetActiveSpace();

  if (query.isPending) {
    return (
      <div className="grid gap-3" role="status" aria-label="Chargement">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (query.isError && !query.data) {
    return (
      <div className="grid max-w-md gap-4">
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Une erreur est survenue</AlertTitle>
          <AlertDescription>Vos espaces ne sont pas disponibles pour le moment.</AlertDescription>
        </Alert>
        <Button variant="outline" className="w-fit" onClick={() => void query.refetch()}>
          Réessayer
        </Button>
      </div>
    );
  }
  const { spaces, activeSpaceId } = query.data;
  if (spaces.length === 0) {
    return (
      <p className="text-muted-foreground">Aucun espace disponible. Contactez l’administrateur.</p>
    );
  }
  return (
    <ul className="grid gap-3" aria-label="Espaces accessibles">
      {spaces.map((space) => {
        const active = space.id === activeSpaceId;
        return (
          <li
            key={space.id}
            data-testid="space-item"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
          >
            <div className="grid gap-1">
              <p className="font-medium">
                {space.name}
                {active && (
                  <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-xs font-normal">
                    Espace actif
                  </span>
                )}
              </p>
              <p className="text-sm text-muted-foreground">
                {ROLE_LABELS[space.role]} · {space.positionCount} titre
                {space.positionCount > 1 ? 's' : ''}
              </p>
            </div>
            <Button asChild variant={active ? 'outline' : 'default'} size="sm">
              <Link
                href={spaceHref(space.id)}
                onClick={() => {
                  if (!active) setActive.mutate({ spaceId: space.id });
                }}
                aria-label={`Ouvrir l’espace ${space.name}`}
              >
                Ouvrir
              </Link>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
