import type { Metadata } from 'next';
import { SPACE_WRITER_ROLES } from '@waddlers/contracts';
import { PositionsTable } from '@/components/table/positions-table';
import { ActivateSpace } from '@/components/spaces/activate-space';
import { getServerClient } from '@/server/orpc';
import { requireSpace } from '@/server/spaces';

export const metadata: Metadata = { title: 'Titres · Waddlers' };

export default async function SpacePositionsPage({
  params,
}: {
  params: Promise<{ spaceId: string }>;
}) {
  const { spaceId } = await params;
  const space = await requireSpace(spaceId);
  // Seeds the client cache so the saved view shows without a second round trip; if this read
  // fails the client query asks again (and shows its own error state).
  const initialConfig = await (
    await getServerClient()
  ).tableConfig
    .get({ spaceId: space.id })
    .catch(() => undefined);
  const canEdit = (SPACE_WRITER_ROLES as readonly string[]).includes(space.role);
  return (
    <div className="grid grid-cols-1 gap-6">
      <ActivateSpace spaceId={space.id} />
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Titres</h1>
        <p className="text-sm text-muted-foreground">Espace {space.name}</p>
      </div>
      <PositionsTable
        spaceId={space.id}
        canEdit={canEdit}
        {...(initialConfig ? { initialConfig } : {})}
      />
    </div>
  );
}
