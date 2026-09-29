'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { loginInputSchema, type LoginInput } from '@waddlers/contracts';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { loginFailure } from '@/lib/auth/errors';
import { orpc } from '@/lib/orpc';

/** `next` is already validated server-side (safeNextPath); it is a same-origin path. */
export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginInputSchema),
    defaultValues: { username: '', password: '' },
  });

  const login = useMutation(
    orpc.auth.login.mutationOptions({
      onSuccess: () => {
        // Nothing cached before login may leak into the new session.
        queryClient.clear();
        router.replace(next);
        router.refresh();
      },
      onError: (error) => {
        const failure = loginFailure(error);
        setFormError(failure.message);
        form.setFocus('password');
      },
    }),
  );

  // Stay disabled through the redirect: onSuccess does not end the pending navigation.
  const busy = login.isPending || login.isSuccess;

  return (
    <Form {...form}>
      <form
        noValidate
        className="grid gap-5"
        onSubmit={form.handleSubmit((values) => {
          setFormError(null);
          login.mutate(values);
        })}
      >
        {formError && (
          <Alert variant="destructive" role="alert">
            <AlertCircle />
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}
        <FormField
          control={form.control}
          name="username"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Identifiant</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Mot de passe</FormLabel>
              <FormControl>
                <Input {...field} type="password" autoComplete="current-password" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={busy} aria-busy={busy}>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          {busy ? 'Connexion…' : 'Se connecter'}
        </Button>
      </form>
    </Form>
  );
}
