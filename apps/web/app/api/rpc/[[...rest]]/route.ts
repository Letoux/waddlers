import { createRpcHandler, getEnv } from '@waddlers/server';

// Node runtime (postgres.js needs TCP); never cache RPC responses.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Created lazily on first request so `next build` does not need env/database.
let handle: ReturnType<typeof createRpcHandler> | undefined;

async function handler(request: Request): Promise<Response> {
  handle ??= createRpcHandler({ allowedOrigin: () => getEnv().APP_ORIGIN });
  const { matched, response } = await handle(request);
  return matched
    ? response
    : new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

// POST only. Export GET only when a procedure explicitly opts into GET (note that Next adds
// an implicit HEAD when GET is exported; the handler answers 405 for anything but POST/GET).
export { handler as POST };
