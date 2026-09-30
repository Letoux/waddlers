// Long-running market-data worker: `pnpm worker`. See docs/ai/MARKET-DATA.md.
// SINGLE INSTANCE ONLY (D13): the job lock is in-process. Run one worker per database.
import {
  consoleLogger,
  createDatabase,
  createMarketDataRuntime,
  parseWorkerEnv,
  startWorker,
} from '@waddlers/server/admin';

let env;
try {
  env = parseWorkerEnv(process.env);
} catch (error) {
  // The message names invalid variables, never their values.
  console.error(error instanceof Error ? error.message : 'Invalid environment configuration.');
  process.exit(1);
}

const { db, sql } = createDatabase(env.DATABASE_URL, { max: 4 });
const runtime = createMarketDataRuntime(db, env, { logger: consoleLogger });
if (env.MARKET_DATA_PROVIDER === 'eodhd') {
  consoleLogger.warn(
    'MARKET_DATA_PROVIDER=eodhd but the adapter is not implemented (decision D1): every quote/history call will fail with not_configured.',
  );
}
consoleLogger.info('worker starting', {
  marketDataProvider: env.MARKET_DATA_PROVIDER,
  fxProvider: env.FX_PROVIDER,
});

// The scheduler's timers are unref'd (so tests can exit): keep the process alive explicitly.
const keepAlive = setInterval(() => {}, 2 ** 30);

const worker = startWorker({ ctx: { db, runtime }, logger: consoleLogger });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  consoleLogger.info('worker stopping', { signal });
  // Hard stop if a job ignores the abort signal (a provider call hangs).
  const force = setTimeout(() => {
    consoleLogger.error('worker forced exit after 30s');
    process.exit(1);
  }, 30_000);
  force.unref();
  await worker.stop();
  clearInterval(keepAlive);
  await sql.end({ timeout: 5 });
  consoleLogger.info('worker stopped');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
