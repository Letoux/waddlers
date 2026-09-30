import type { Metadata } from 'next';
import { ActivateSpace } from '@/components/spaces/activate-space';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ROLE_LABELS } from '@/lib/spaces/errors';
import { formatQuantity } from '@/lib/spaces/quantity';
import { requireSpace } from '@/server/spaces';

export const metadata: Metadata = { title: 'Dashboard · Waddlers' };

// Placeholder: the real dashboard (performance, charts, movers) arrives with S5.
export default async function SpaceDashboardPage({
  params,
}: {
  params: Promise<{ spaceId: string }>;
}) {
  const { spaceId } = await params;
  const space = await requireSpace(spaceId);
  return (
    <div className="grid gap-6">
      <ActivateSpace spaceId={space.id} />
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{space.name}</h1>
        <p className="text-sm text-muted-foreground">
          Rôle : <span data-testid="space-role">{ROLE_LABELS[space.role]}</span>
        </p>
      </div>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h2>Titres suivis</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          <p className="text-3xl font-semibold" data-testid="tracked-count">
            {formatQuantity(String(space.positionCount))}
          </p>
          <p className="text-sm text-muted-foreground">
            Le tableau de bord (performance, graphiques, variations) arrive bientôt.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
