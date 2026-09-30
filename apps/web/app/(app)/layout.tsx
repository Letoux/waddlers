import type { ReactNode } from 'react';
import { AppHeader } from '@/components/app-header';
import { requireUser } from '@/server/auth';
import { getServerClient } from '@/server/orpc';

/** UX redirect only: the security boundary is `requireUser()` in each page (see FRONTEND.md). */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const spaces = await (await getServerClient()).spaces.list();
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader username={user.username} initialSpaces={spaces} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
