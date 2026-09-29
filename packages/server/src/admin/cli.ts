import type { Writable } from 'node:stream';
import { AdminError, createUser, disableUser, resetPassword } from './index';
import type { Database } from '../db/create';

export const USAGE = `Usage: pnpm admin -- <command> <username>

Commands:
  user:create <username>          create a user (password read from a hidden prompt or stdin)
  user:reset-password <username>  set a new password and revoke all sessions
  user:disable <username>         disable the account and revoke all sessions

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

/** Returns the process exit code. Only operator-safe messages are printed. */
export async function runAdminCli(argv: string[], db: Database, io: CliIo): Promise<number> {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const [command, username, ...extra] = args;
  const say = (text: string) => io.out.write(`${text}\n`);
  const fail = (text: string) => {
    io.err.write(`${text}\n`);
    return 1;
  };
  if (!command || !username || extra.length > 0) return fail(USAGE);
  if (username.startsWith('-')) return fail(USAGE);

  try {
    switch (command) {
      case 'user:create': {
        const password = await promptNewPassword(io);
        const user = await createUser(db, { username, password });
        say(`User created: ${user.username} (${user.id})`);
        return 0;
      }
      case 'user:reset-password': {
        const password = await promptNewPassword(io);
        const { revokedSessions } = await resetPassword(db, { username, password });
        say(`Password reset for ${username}; ${revokedSessions} session(s) revoked.`);
        return 0;
      }
      case 'user:disable': {
        const { revokedSessions } = await disableUser(db, { username });
        say(`User disabled: ${username}; ${revokedSessions} session(s) revoked.`);
        return 0;
      }
      default:
        return fail(`Unknown command: ${command}\n\n${USAGE}`);
    }
  } catch (error) {
    if (error instanceof AdminError) return fail(error.message);
    const code = (error as { code?: string } | null)?.code;
    return fail(`Command failed${code ? ` (${code})` : ''}.`);
  }
}

async function promptNewPassword(io: CliIo): Promise<string> {
  const password = await io.readSecret('Password: ');
  if (io.interactive) {
    const confirmation = await io.readSecret('Confirm password: ');
    if (confirmation !== password) throw new AdminError('Passwords do not match.');
  }
  return password;
}
