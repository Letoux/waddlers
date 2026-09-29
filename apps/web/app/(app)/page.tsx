import { requireUser } from '@/server/auth';

export default async function HomePage() {
  await requireUser();
  return (
    <div className="grid gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">Tableau de bord</h1>
      <p className="text-muted-foreground">
        Le suivi de vos espaces apparaîtra ici. Cette page est un espace réservé.
      </p>
    </div>
  );
}
