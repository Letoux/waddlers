import { createRouterClient } from '@orpc/server';
import { contract, PUBLIC_PROCEDURES } from '@waddlers/contracts';
import { traverseContractProcedures } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import { createRouter } from '../router';

/** Every path of the contract, e.g. `auth.me`. The router must implement all of them. */
function allProcedurePaths(): string[] {
  const paths: string[] = [];
  traverseContractProcedures({ path: [], router: contract }, ({ path }) => {
    paths.push(path.join('.'));
  });
  return paths.sort();
}

type Callable = (input?: unknown) => Promise<unknown>;

function resolve(client: unknown, path: string): Callable {
  return path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], client) as Callable;
}

describe('authentication guard', () => {
  const log = () => {};
  const paths = allProcedurePaths();
  // No database is configured or reachable: an anonymous request must be rejected before any query.
  const router = createRouter({
    log,
    getDb: () => {
      throw new Error('database must not be touched for anonymous requests');
    },
  });

  it('finds the expected procedures (sanity check on the enumeration)', () => {
    expect(paths).toEqual(
      expect.arrayContaining([
        'health',
        'systemStatus',
        'auth.login',
        'auth.logout',
        'auth.me',
        'auth.changePassword',
      ]),
    );
  });

  it('the public allowlist only names existing procedures', () => {
    for (const path of PUBLIC_PROCEDURES) expect(paths).toContain(path);
  });

  const protectedPaths = allProcedurePaths().filter(
    (p) => !(PUBLIC_PROCEDURES as readonly string[]).includes(p),
  );

  it.each(protectedPaths)('%s rejects anonymous calls with UNAUTHORIZED', async (path) => {
    for (const headers of [
      new Headers(),
      new Headers({ cookie: 'theme=dark' }),
      new Headers({ cookie: '__Host-wd_session=not a valid token' }),
    ]) {
      const client = createRouterClient(router, { context: { headers } });
      // Deliberately invalid input: authentication must win over validation.
      await expect(resolve(client, path)({ nonsense: true })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        status: 401,
      });
    }
  });
});
