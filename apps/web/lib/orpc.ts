import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { SimpleCsrfProtectionLinkPlugin } from '@orpc/client/plugins';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { ContractRouterClient } from '@orpc/contract';
import type { Contract } from '@waddlers/contracts';

// BROWSER-ONLY client (same-origin fetch). SSR/RSC code must use `@/server/orpc`
// (in-process router client that forwards the request cookies) instead.
const url = () => {
  if (typeof window === 'undefined') {
    throw new Error('The browser oRPC client cannot be used on the server; use @/server/orpc.');
  }
  return `${window.location.origin}/api/rpc`;
};
const link = new RPCLink({ url, plugins: [new SimpleCsrfProtectionLinkPlugin()] });

export const rpc: ContractRouterClient<Contract> = createORPCClient(link);

/**
 * Same client with `keepalive: true`: only for the last save when the page is being hidden (the
 * browser lets such a request outlive the page; the body must stay under 64 KB, a table config is
 * far below).
 */
const keepaliveLink = new RPCLink({
  url,
  plugins: [new SimpleCsrfProtectionLinkPlugin()],
  fetch: (request, init) => globalThis.fetch(request, { ...init, keepalive: true }),
});
export const rpcKeepalive: ContractRouterClient<Contract> = createORPCClient(keepaliveLink);

/** TanStack Query helpers, e.g. `useQuery(orpc.auth.me.queryOptions())`. */
export const orpc = createTanstackQueryUtils(rpc);
