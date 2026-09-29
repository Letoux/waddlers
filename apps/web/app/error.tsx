'use client';

import { ErrorState } from '@/components/error-state';

// Catches errors thrown below the root layout that no closer boundary handles: the (app) layout
// (session lookup with the database down) and /login. Renders no technical detail.
export default function RootError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <ErrorState reset={reset} />
    </main>
  );
}
