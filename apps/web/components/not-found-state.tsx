import Link from 'next/link';
import { Button } from '@/components/ui/button';

/** Same page for unknown and inaccessible resources: existence is never revealed. */
export function NotFoundState() {
  return (
    <div className="grid max-w-md gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Page introuvable</h1>
      <p className="text-muted-foreground">Cette page n’existe pas ou vous n’y avez pas accès.</p>
      <Button asChild variant="outline" className="w-fit">
        <Link href="/">Retour à l’accueil</Link>
      </Button>
    </div>
  );
}
