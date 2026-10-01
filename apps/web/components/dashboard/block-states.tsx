'use client';

import { ORPCError } from '@orpc/client';
import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { rateLimitedMessage } from '@/lib/dashboard/labels';
import { Skeleton } from '@/components/ui/skeleton';

/** Specs 36 wording; the technical error is never shown. */
export const EMPTY_SPACE_MESSAGE = 'Aucun titre dans cet espace.';
export const UNAVAILABLE_MESSAGE = 'Les données financières ne sont actuellement pas disponibles.';

export const RATE_LIMITED_MESSAGE =
  'Trop de requêtes en peu de temps. Réessayez dans quelques secondes.';

/** Only the error CODE is read (429 from the dashboard caps); the message is never rendered. */
export function BlockError({
  query,
  testId,
}: {
  query: { error: unknown; refetch: () => unknown };
  testId?: string;
}) {
  const rateLimited = query.error instanceof ORPCError && query.error.code === 'TOO_MANY_REQUESTS';
  return (
    <Alert variant="destructive" role="alert" data-testid={testId}>
      <AlertCircle />
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{rateLimited ? rateLimitedMessage(query.error) : UNAVAILABLE_MESSAGE}</span>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          Réessayer
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function BlockSkeleton({ lines = 3, label }: { lines?: number; label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="grid gap-2">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className="h-6 w-full" />
      ))}
    </div>
  );
}

export function EmptyNote({ children }: { children: string }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/** Never present stale data as current: shown next to any figure built from old prices or rates. */
export function StaleBadge({ testId }: { testId?: string }) {
  return (
    <span
      data-testid={testId}
      className="rounded-full border border-loss px-2 py-0.5 text-xs font-medium text-loss"
    >
      Données anciennes
    </span>
  );
}
