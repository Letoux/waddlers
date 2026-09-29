'use client';

import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

// Never render error.message: technical errors are not exposed (specs section 36).
export default function ErrorState({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="grid max-w-md gap-4">
      <Alert variant="destructive" role="alert">
        <AlertCircle />
        <AlertTitle>Une erreur est survenue</AlertTitle>
        <AlertDescription>
          Cette page n’est pas disponible pour le moment. Veuillez réessayer.
        </AlertDescription>
      </Alert>
      <Button variant="outline" className="w-fit" onClick={reset}>
        Réessayer
      </Button>
    </div>
  );
}
