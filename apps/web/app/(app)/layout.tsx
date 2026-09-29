import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppHeader } from '@/components/app-header';
import { loginUrlFor } from '@/lib/auth/safe-next';
import { getCurrentUser } from '@/server/auth';

/** Route guard: every page in this group requires a valid session (checked server-side). */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) {
    const requested = (await headers()).get('x-waddlers-path');
    redirect(loginUrlFor(requested));
  }
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader username={user.username} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
