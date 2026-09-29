import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="grid gap-4" role="status" aria-label="Chargement">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="h-40 w-full max-w-md" />
    </div>
  );
}
