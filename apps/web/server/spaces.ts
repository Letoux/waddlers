import 'server-only';
import { ORPCError } from '@orpc/client';
import type { SpaceSummary } from '@waddlers/contracts';
import { notFound, redirect } from 'next/navigation';
import { loginUrlFor } from '@/lib/auth/safe-next';
import { requireUser } from './auth';
import { getServerClient } from './orpc';

/**
 * Validates `[spaceId]` for a page: the caller must be signed in and a member. An unknown,
 * malformed or inaccessible space is the same `notFound()` (existence is never revealed).
 * Pages still re-check access on every procedure call.
 */
export async function requireSpace(spaceId: string): Promise<SpaceSummary> {
  await requireUser();
  const client = await getServerClient();
  try {
    return await client.spaces.get({ spaceId });
  } catch (error) {
    if (error instanceof ORPCError) {
      if (error.code === 'NOT_FOUND') notFound();
      if (error.code === 'UNAUTHORIZED') redirect(loginUrlFor(null));
    }
    throw error;
  }
}
