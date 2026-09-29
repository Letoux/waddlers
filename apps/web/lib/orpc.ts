import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { SimpleCsrfProtectionLinkPlugin } from '@orpc/client/plugins';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { ContractRouterClient } from '@orpc/contract';
import type { Contract } from '@waddlers/contracts';

const link = new RPCLink({
  // Same-origin only; the browser never talks to a provider directly.
  url: () =>
    `${typeof window === 'undefined' ? 'http://localhost:3000' : window.location.origin}/api/rpc`,
  plugins: [new SimpleCsrfProtectionLinkPlugin()],
});

export const rpc: ContractRouterClient<Contract> = createORPCClient(link);

/** TanStack Query helpers, e.g. `useQuery(orpc.health.queryOptions())`. */
export const orpc = createTanstackQueryUtils(rpc);
