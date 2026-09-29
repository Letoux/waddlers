import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { SimpleCsrfProtectionLinkPlugin } from '@orpc/client/plugins';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { ContractRouterClient } from '@orpc/contract';
import type { Contract } from '@waddlers/contracts';

// BROWSER-ONLY client (same-origin fetch). SSR/RSC code must use `@/server/orpc`
// (in-process router client that forwards the request cookies) instead.
const link = new RPCLink({
  url: () => {
    if (typeof window === 'undefined') {
      throw new Error('The browser oRPC client cannot be used on the server; use @/server/orpc.');
    }
    return `${window.location.origin}/api/rpc`;
  },
  plugins: [new SimpleCsrfProtectionLinkPlugin()],
});

export const rpc: ContractRouterClient<Contract> = createORPCClient(link);

/** TanStack Query helpers, e.g. `useQuery(orpc.auth.me.queryOptions())`. */
export const orpc = createTanstackQueryUtils(rpc);
