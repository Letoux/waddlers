// Admin CLI: `pnpm admin -- user:create <username>`. See docs/ai/BACKEND.md.
import { createDatabase, readSecret, runAdminCli } from '@waddlers/server/admin';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const { db, sql } = createDatabase(url, { max: 1 });
try {
  process.exitCode = await runAdminCli(process.argv.slice(2), db, {
    out: process.stdout,
    err: process.stderr,
    readSecret: (prompt) => readSecret(prompt, { input: process.stdin, output: process.stderr }),
    interactive: Boolean(process.stdin.isTTY),
  });
} finally {
  await sql.end({ timeout: 5 });
}
