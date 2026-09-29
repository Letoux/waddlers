import { createRpcHandler, getEnv } from '@waddlers/server';

// Node runtime (postgres.js needs TCP); never cache RPC responses.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Created lazily on first request so `next build` does not need env/database.
let handle: ReturnType<typeof createRpcHandler> | undefined;

async function handler(request: Request): Promise<Response> {
  handle ??= createRpcHandler({ allowedOrigin: () => getEnv().APP_ORIGIN });
  const { matched, response } = await handle(request);
  return matched ? response : new Response('Not found', { status: 404 });
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
