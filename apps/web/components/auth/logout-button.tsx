'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { orpc } from '@/lib/orpc';

export function LogoutButton() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const leave = () => {
    queryClient.clear();
    router.replace('/login');
    router.refresh();
  };

  const logout = useMutation(
    orpc.auth.logout.mutationOptions({
      onSuccess: leave,
      onError: (error) => {
        // Already signed out (expired session): the goal is reached.
        if (typeof error === 'object' && error !== null && 'code' in error) {
          if (error.code === 'UNAUTHORIZED') return leave();
        }
        toast.error('Impossible de se déconnecter. Veuillez réessayer.');
      },
    }),
  );

  const busy = logout.isPending || logout.isSuccess;
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => logout.mutate(undefined)}>
      {busy && <Loader2 className="animate-spin" aria-hidden />}
      Se déconnecter
    </Button>
  );
}
