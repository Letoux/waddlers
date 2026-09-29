'use client';

import { ErrorState } from '@/components/error-state';
import './globals.css';

// Last resort: replaces the root layout, so it owns <html>/<body>. Neutral French message only.
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="fr">
      <body>
        <main className="flex min-h-screen items-center justify-center px-4 py-8">
          <ErrorState reset={reset} />
        </main>
      </body>
    </html>
  );
}
