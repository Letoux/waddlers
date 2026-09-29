import type { Metadata } from 'next';
import { ChangePasswordForm } from '@/components/auth/change-password-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Paramètres · Waddlers' };

export default function SettingsPage() {
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Paramètres</h1>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h2>Mot de passe</h2>
          </CardTitle>
          <CardDescription>
            Après le changement, vos autres sessions seront déconnectées.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
    </div>
  );
}
