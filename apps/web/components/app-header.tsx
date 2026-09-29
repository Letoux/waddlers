import Link from 'next/link';
import { LogoutButton } from '@/components/auth/logout-button';

export function AppHeader({ username }: { username: string }) {
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Waddlers
        </Link>
        <nav aria-label="Compte" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span data-testid="current-user" className="text-muted-foreground">
            <span className="sr-only">Connecté en tant que </span>
            {username}
          </span>
          <Link href="/settings" className="underline-offset-4 hover:underline">
            Paramètres
          </Link>
          <LogoutButton />
        </nav>
      </div>
    </header>
  );
}
