import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/auth/login-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { safeNextPath } from '@/lib/auth/safe-next';
import { getCurrentUser } from '@/server/auth';

export const metadata: Metadata = { title: 'Connexion · Waddlers' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const next = safeNextPath((await searchParams).next);
  if (await getCurrentUser()) redirect(next);

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="text-2xl font-semibold tracking-tight">Waddlers</h1>
          </CardTitle>
          <CardDescription>Connectez-vous pour accéder à votre tableau de bord.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm next={next} />
        </CardContent>
      </Card>
    </main>
  );
}
