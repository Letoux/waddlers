import type { Metadata } from 'next';
import { SPACE_WRITER_ROLES } from '@waddlers/contracts';
import { PositionsList } from '@/components/spaces/positions-list';
import { ActivateSpace } from '@/components/spaces/activate-space';
import { requireSpace } from '@/server/spaces';

export const metadata: Metadata = { title: 'Titres · Waddlers' };

export default async function SpacePositionsPage({
  params,
}: {
  params: Promise<{ spaceId: string }>;
}) {
  const { spaceId } = await params;
  const space = await requireSpace(spaceId);
  const canEdit = (SPACE_WRITER_ROLES as readonly string[]).includes(space.role);
  return (
    <div className="grid gap-6">
      <ActivateSpace spaceId={space.id} />
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Titres</h1>
        <p className="text-sm text-muted-foreground">Espace {space.name}</p>
      </div>
      <PositionsList spaceId={space.id} canEdit={canEdit} />
    </div>
  );
}
