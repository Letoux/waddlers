'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'react-toastify';
import { z } from 'zod';
import {
  PASSWORD_MIN_LENGTH,
  changePasswordInputSchema,
  type ChangePasswordInput,
} from '@waddlers/contracts';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { changePasswordFailure } from '@/lib/auth/errors';
import { orpc } from '@/lib/orpc';
import { frenchIssueMessage } from '@/lib/zod-fr';

// The password rules come from the contract; only the confirmation field is UI-specific.
const formSchema = changePasswordInputSchema
  .and(z.object({ confirmPassword: z.string() }))
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Les mots de passe ne correspondent pas.',
  });
type FormValues = ChangePasswordInput & { confirmPassword: string };

const EMPTY: FormValues = { currentPassword: '', newPassword: '', confirmPassword: '' };

export function ChangePasswordForm() {
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema, { error: frenchIssueMessage }),
    defaultValues: EMPTY,
  });

  const change = useMutation(
    orpc.auth.changePassword.mutationOptions({
      onSuccess: () => {
        form.reset(EMPTY);
        toast.success('Mot de passe modifié.');
      },
      onError: (error) => {
        const failure = changePasswordFailure(error);
        if (failure.target === 'currentPassword') {
          form.setError('currentPassword', { type: 'server', message: failure.message });
          form.setFocus('currentPassword');
        } else {
          setFormError(failure.message);
        }
      },
    }),
  );

  return (
    <Form {...form}>
      <form
        noValidate
        className="grid gap-5"
        onSubmit={form.handleSubmit(({ currentPassword, newPassword }) => {
          setFormError(null);
          change.mutate({ currentPassword, newPassword });
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
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Mot de passe actuel</FormLabel>
              <FormControl>
                <Input {...field} type="password" autoComplete="current-password" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="newPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nouveau mot de passe</FormLabel>
              <FormControl>
                <Input {...field} type="password" autoComplete="new-password" />
              </FormControl>
              <FormDescription>{PASSWORD_MIN_LENGTH} caractères minimum.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Confirmer le nouveau mot de passe</FormLabel>
              <FormControl>
                <Input {...field} type="password" autoComplete="new-password" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={change.isPending} aria-busy={change.isPending}>
          {change.isPending && <Loader2 className="animate-spin" aria-hidden />}
          {change.isPending ? 'Enregistrement…' : 'Modifier le mot de passe'}
        </Button>
      </form>
    </Form>
  );
}
