import type { Writable } from 'node:stream';
import { pgErrorCode } from '../db/errors';
import { AdminError } from './errors';
import { createUser, disableUser, resetPassword } from './index';
import {
  addPosition,
  createSpace,
  grantSpace,
  listAllSpaces,
  renameSpace,
  revokeSpace,
} from './spaces';
import type { Database } from '../db/create';
import type { MarketDataRuntime } from '../market-data/runtime';
import {
  formatMarketStatus,
  formatRefreshReport,
  marketRefresh,
  marketStatus,
  parseMarketFlags,
} from './market';

export const USAGE = `Usage: pnpm admin -- <command> [arguments]

Users:
  user:create <username>          create a user (password read from a hidden prompt or stdin)
  user:reset-password <username>  set a new password and revoke all sessions
  user:disable <username>         disable the account and revoke all sessions

Spaces (created and shared by the admin only; quote names containing spaces):
  space:create <name>                        create a space (reference currency EUR)
  space:rename <space> <new name>            rename a space
  space:grant <space> <username> <role>      give access (owner|editor|viewer); repeating changes the role
  space:revoke <space> <username>            remove access
  space:list                                 list all spaces with member and position counts
  position:add <space> <symbol>.<MIC> [quantity]
                                             track a listing already in the reference data
                                             (e.g. AI.XPAR 10.5); no quantity = watchlist entry

Market data (provider from MARKET_DATA_PROVIDER / FX_PROVIDER; needs no HTTP server):
  market:refresh [--quotes] [--history] [--fx] [--metrics] [<symbol>.<MIC>]
                                             refresh past the TTLs (backoff and daily quota still apply);
                                             no flag = all four; no listing = every held listing
  market:status                              cache/backoff state per kind, failing entries, provider usage

The password is never accepted as an argument. Non-interactive:
  printf '%s\\n' "$PASSWORD" | pnpm admin -- user:create alice`;

export interface CliIo {
  out: Writable;
  err: Writable;
  /** Prompts for a secret (hidden on a TTY, first stdin line otherwise). */
  readSecret: (prompt: string) => Promise<string>;
  /** True when secrets are typed interactively (ask for confirmation). */
  interactive: boolean;
}

export interface CliServices {
  /** Builds the market-data runtime on demand (reads provider settings from the environment). */
  market?: () => MarketDataRuntime;
}

/** Returns the process exit code. Only operator-safe messages are printed. */
export async function runAdminCli(
  argv: string[],
  db: Database,
  io: CliIo,
  services: CliServices = {},
): Promise<number> {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const [command, ...rawParams] = args;
  let params = rawParams;
  const say = (text: string) => io.out.write(`${text}\n`);
  const fail = (text: string) => {
    io.err.write(`${text}\n`);
    return 1;
  };
  if (!command) return fail(USAGE);
  // Only `market:refresh` takes options; everywhere else a dash-prefixed argument is refused
  // (a password or name must never be mistaken for an option).
  const flags = command === 'market:refresh' ? params.filter((p) => p.startsWith('-')) : [];
  if (command !== 'market:refresh' && params.some((p) => p.startsWith('-'))) return fail(USAGE);
  params = params.filter((p) => !flags.includes(p));
  const arity = Object.hasOwn(ARITY, command) ? ARITY[command] : undefined;
  if (!arity) return fail(`Unknown command: ${command}\n\n${USAGE}`);
  if (params.length < arity[0] || params.length > arity[1]) return fail(USAGE);
  const [p1 = '', p2 = '', p3 = ''] = params;

  try {
    switch (command) {
      case 'user:create': {
        const password = await promptNewPassword(io);
        const user = await createUser(db, { username: p1, password });
        say(`User created: ${user.username} (${user.id})`);
        return 0;
      }
      case 'user:reset-password': {
        const password = await promptNewPassword(io);
        const { revokedSessions } = await resetPassword(db, { username: p1, password });
        say(`Password reset for ${p1}; ${revokedSessions} session(s) revoked.`);
        return 0;
      }
      case 'user:disable': {
        const { revokedSessions } = await disableUser(db, { username: p1 });
        say(`User disabled: ${p1}; ${revokedSessions} session(s) revoked.`);
        return 0;
      }
      case 'space:create': {
        const space = await createSpace(db, { name: p1 });
        say(`Space created: ${space.name} (${space.id})`);
        return 0;
      }
      case 'space:rename': {
        await renameSpace(db, { space: p1, newName: p2 });
        say(`Space renamed: ${p1} -> ${p2.trim()}`);
        return 0;
      }
      case 'space:grant': {
        const { created, role } = await grantSpace(db, { space: p1, username: p2, role: p3 });
        say(`${created ? 'Granted' : 'Updated'}: ${p2} is ${role} of ${p1}.`);
        return 0;
      }
      case 'space:revoke': {
        const { removed } = await revokeSpace(db, { space: p1, username: p2 });
        say(
          removed
            ? `Revoked: ${p2} no longer has access to ${p1}.`
            : `${p2} had no access to ${p1}.`,
        );
        return 0;
      }
      case 'space:list': {
        const rows = await listAllSpaces(db);
        if (rows.length === 0) say('No space.');
        for (const r of rows)
          say(`${r.id}  ${r.name}  members=${r.members}  positions=${r.positions}`);
        return 0;
      }
      case 'position:add': {
        await addPosition(db, {
          space: p1,
          listing: p2,
          // Branch on the argument count, not the value: an explicit "" is invalid, not "absent".
          ...(params.length === 3 ? { quantity: p3 } : {}),
        });
        say(
          `Position added to ${p1}: ${p2}${params.length === 3 ? ` x ${p3}` : ' (watchlist, no quantity)'}.`,
        );
        return 0;
      }
      case 'market:refresh': {
        const runtime = services.market?.();
        if (!runtime) return fail('Market data is not available in this context.');
        const report = await marketRefresh(db, runtime, {
          scopes: parseMarketFlags(flags),
          ...(params.length === 1 ? { listing: p1 } : {}),
        });
        for (const line of formatRefreshReport(report)) say(line);
        return 0;
      }
      case 'market:status': {
        for (const line of formatMarketStatus(await marketStatus(db, new Date()))) say(line);
        return 0;
      }
      default:
        return fail(`Unknown command: ${command}\n\n${USAGE}`);
    }
  } catch (error) {
    if (error instanceof AdminError) return fail(error.message);
    const code = pgErrorCode(error);
    return fail(`Command failed${code ? ` (${code})` : ''}.`);
  }
}

/** Allowed argument counts per command: [min, max]. */
const ARITY: Record<string, readonly [number, number]> = {
  'user:create': [1, 1],
  'user:reset-password': [1, 1],
  'user:disable': [1, 1],
  'space:create': [1, 1],
  'space:rename': [2, 2],
  'space:grant': [3, 3],
  'space:revoke': [2, 2],
  'space:list': [0, 0],
  'position:add': [2, 3],
  'market:refresh': [0, 1],
  'market:status': [0, 0],
};

async function promptNewPassword(io: CliIo): Promise<string> {
  const password = await io.readSecret('Password: ');
  if (io.interactive) {
    const confirmation = await io.readSecret('Confirm password: ');
    if (confirmation !== password) throw new AdminError('Passwords do not match.');
  }
  return password;
}
