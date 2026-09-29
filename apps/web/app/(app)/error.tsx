'use client';

import { ErrorState } from '@/components/error-state';

// Catches errors thrown by pages under (app), inside the shell. Errors of the (app) layout itself
// (e.g. database down while resolving the session) bubble to app/error.tsx.
export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState reset={reset} />;
}
