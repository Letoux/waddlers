'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Menu } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { SpacesListOutput } from '@waddlers/contracts';
import { orpc } from '@/lib/orpc';
import { LogoutButton } from '@/components/auth/logout-button';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { PERIOD_PARAM, parsePeriodParam } from '@/lib/dashboard/period';
import { parseSpacePath, spaceHref, switchSpaceHref } from '@/lib/spaces/nav';
import { useSpacesQuery } from '@/lib/spaces/use-spaces';
import { cn } from '@/lib/utils';

type NavItem = { href: string; label: string; active: boolean };

function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <>
      {items.map((item) => (
        <Link
          key={item.href + item.label}
          href={item.href}
          {...(onNavigate ? { onClick: onNavigate } : {})}
          aria-current={item.active ? 'page' : undefined}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm underline-offset-4 hover:bg-accent',
            item.active ? 'bg-accent font-medium' : 'text-muted-foreground',
          )}
        >
          {item.label}
        </Link>
      ))}
    </>
  );
}

export function AppHeader({
  username,
  initialSpaces,
}: {
  username: string;
  initialSpaces: SpacesListOutput;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // The global period (specs 11) follows the user across spaces and space pages.
  const period = parsePeriodParam(useSearchParams().get(PERIOD_PARAM));
  const [menuOpen, setMenuOpen] = useState(false);
  const { data = initialSpaces } = useSpacesQuery({ initialData: initialSpaces });
  const queryClient = useQueryClient();
  const [switching, startTransition] = useTransition();

  const fromPath = parseSpacePath(pathname);
  const candidate = fromPath?.spaceId ?? data.activeSpaceId;
  const selected = data.spaces.find((s) => s.id === candidate)?.id ?? '';
  // Links of the space section follow the URL space (when we know it), else the active space;
  // none without a space.
  const navSpaceId = selected || data.activeSpaceId || null;

  // The URL names a space the cached list does not have (granted since the shell loaded, or an
  // inaccessible id): refresh the list once, quietly. Opening the space records it as active.
  const refreshedFor = useRef<string | null>(null);
  const urlSpaceId = fromPath?.spaceId;
  const urlSpaceKnown = !urlSpaceId || data.spaces.some((s) => s.id === urlSpaceId);
  useEffect(() => {
    if (urlSpaceKnown || !urlSpaceId || refreshedFor.current === urlSpaceId) return;
    refreshedFor.current = urlSpaceId;
    void queryClient.invalidateQueries({ queryKey: orpc.spaces.list.key() });
  }, [urlSpaceKnown, urlSpaceId, queryClient]);

  const items: NavItem[] = [
    ...(navSpaceId
      ? [
          {
            href: spaceHref(navSpaceId, 'dashboard', period),
            label: 'Dashboard',
            active: fromPath?.section === 'dashboard',
          },
          {
            href: spaceHref(navSpaceId, 'titres', period),
            label: 'Titres',
            active: fromPath?.section === 'titres',
          },
        ]
      : []),
    { href: '/espaces', label: 'Espaces', active: pathname.startsWith('/espaces') },
    { href: '/settings', label: 'Paramètres', active: pathname.startsWith('/settings') },
  ];

  const switchTo = (spaceId: string) => {
    if (spaceId === selected) return;
    // The destination page records the active space (ActivateSpace); nothing to send here.
    startTransition(() => router.push(switchSpaceHref(pathname, spaceId, period)));
  };

  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Waddlers
        </Link>
        <nav aria-label="Navigation principale" className="ml-2 hidden items-center gap-1 md:flex">
          <NavLinks items={items} />
        </nav>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          {data.spaces.length > 0 && (
            <Select value={selected} onValueChange={switchTo} disabled={switching}>
              <SelectTrigger
                aria-label="Espace"
                data-testid="space-selector"
                aria-busy={switching || undefined}
                className="w-40 max-w-full min-w-0 sm:w-56"
              >
                <SelectValue placeholder="Espace" />
              </SelectTrigger>
              <SelectContent>
                {data.spaces.map((space) => (
                  <SelectItem key={space.id} value={space.id}>
                    {space.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="hidden items-center gap-3 text-sm md:flex">
            <span data-testid="current-user" className="text-muted-foreground">
              <span className="sr-only">Connecté en tant que </span>
              {username}
            </span>
            <LogoutButton />
          </div>
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="shrink-0 md:hidden"
                aria-label="Menu"
              >
                <Menu aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72">
              <SheetTitle className="px-4 pt-4">Menu</SheetTitle>
              <SheetDescription className="sr-only">Navigation principale</SheetDescription>
              <nav aria-label="Navigation mobile" className="grid gap-1 px-4">
                <NavLinks items={items} onNavigate={() => setMenuOpen(false)} />
              </nav>
              <div className="mt-auto grid gap-3 border-t p-4 text-sm">
                <span className="text-muted-foreground">
                  <span className="sr-only">Connecté en tant que </span>
                  {username}
                </span>
                <LogoutButton />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
