import type { Metadata } from 'next';
import { ActivateSpace } from '@/components/spaces/activate-space';
import { Dashboard } from '@/components/dashboard/dashboard';
import { ROLE_LABELS } from '@/lib/spaces/errors';
import { requireSpace } from '@/server/spaces';

export const metadata: Metadata = { title: 'Dashboard · Waddlers' };

export default async function SpaceDashboardPage({
  params,
}: {
  params: Promise<{ spaceId: string }>;
}) {
  const { spaceId } = await params;
  const space = await requireSpace(spaceId);
  return (
    <div className="grid grid-cols-1 gap-6">
      <ActivateSpace spaceId={space.id} />
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{space.name}</h1>
        <p className="text-sm text-muted-foreground">
          Rôle : <span data-testid="space-role">{ROLE_LABELS[space.role]}</span>
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        Titres suivis :{' '}
        <span data-testid="tracked-count">{space.positionCount.toLocaleString('fr-FR')}</span>
      </p>
      <Dashboard spaceId={space.id} positionCount={space.positionCount} />
    </div>
  );
}
