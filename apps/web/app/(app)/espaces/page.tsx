import type { Metadata } from 'next';
import { SpacesList } from '@/components/spaces/spaces-list';
import { requireUser } from '@/server/auth';

export const metadata: Metadata = { title: 'Espaces · Waddlers' };

export default async function SpacesPage() {
  await requireUser();
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Espaces</h1>
      <SpacesList />
    </div>
  );
}
