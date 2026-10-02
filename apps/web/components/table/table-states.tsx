import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function SpaceGone() {
  return (
    <div className="grid max-w-md gap-4">
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Espace indisponible</AlertTitle>
        <AlertDescription>Cet espace n’est plus disponible.</AlertDescription>
      </Alert>
      <Button asChild variant="outline" className="w-fit">
        <Link href="/espaces">Voir mes espaces</Link>
      </Button>
    </div>
  );
}

export function TableSkeleton() {
  return (
    <div className="grid gap-2" role="status" aria-label="Chargement des titres">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}
