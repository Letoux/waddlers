import { Button } from '@/components/ui/button';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-start justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">Waddlers</h1>
      <p className="text-muted-foreground">
        Tableau de bord de suivi financier. Cette page est un espace réservé.
      </p>
      <Button>Commencer</Button>
    </main>
  );
}
