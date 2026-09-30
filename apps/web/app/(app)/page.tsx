import { redirect } from 'next/navigation';
import { requireUser } from '@/server/auth';
import { getServerClient } from '@/server/orpc';
import { spaceHref } from '@/lib/spaces/nav';

export default async function HomePage() {
  await requireUser();
  const { activeSpaceId } = await (await getServerClient()).spaces.list();
  if (activeSpaceId) redirect(spaceHref(activeSpaceId));
  return (
    <div className="grid gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">Aucun espace</h1>
      <p className="text-muted-foreground">Aucun espace disponible. Contactez l’administrateur.</p>
    </div>
  );
}
