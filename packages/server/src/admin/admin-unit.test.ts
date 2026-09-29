import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/create';
import { runAdminCli, type CliIo } from './cli';
import { readSecret } from './prompt';
import { seedDevUser } from './seed';

function sink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { stream, text: () => chunks.join('') };
}

// The DB must never be reached in these tests.
const noDb = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error('db touched');
    },
  },
) as unknown as Database;

describe('readSecret (non-interactive)', () => {
  it('reads the first stdin line, without the newline', async () => {
    const input = Readable.from(['s3cret-pass-phrase\nignored\n']);
    expect(await readSecret('Password: ', { input, output: sink().stream })).toBe(
      's3cret-pass-phrase',
    );
  });

  it('handles CRLF and missing trailing newline', async () => {
    expect(await readSecret('', { input: Readable.from(['abc\r\n']), output: sink().stream })).toBe(
      'abc',
    );
    expect(await readSecret('', { input: Readable.from(['abc']), output: sink().stream })).toBe(
      'abc',
    );
  });
});

describe('admin CLI argument handling', () => {
  function io() {
    const out = sink();
    const err = sink();
    const cliIo: CliIo = {
      out: out.stream,
      err: err.stream,
      readSecret: vi.fn<CliIo['readSecret']>(),
      interactive: false,
    };
    return { cliIo, readSecret: cliIo.readSecret as ReturnType<typeof vi.fn>, out, err };
  }

  it('prints usage and exits 1 without a command or username', async () => {
    const i = io();
    expect(await runAdminCli([], noDb, i.cliIo)).toBe(1);
    expect(await runAdminCli(['user:create'], noDb, i.cliIo)).toBe(1);
    expect(i.err.text()).toContain('Usage');
  });

  it('refuses a password (or anything extra) on the command line and never prompts', async () => {
    const i = io();
    expect(await runAdminCli(['user:create', 'alice', 'hunter2-hunter2'], noDb, i.cliIo)).toBe(1);
    expect(await runAdminCli(['user:create', 'alice', '--password', 'x'], noDb, i.cliIo)).toBe(1);
    expect(await runAdminCli(['user:create', '--password=abc'], noDb, i.cliIo)).toBe(1);
    expect(i.readSecret).not.toHaveBeenCalled();
    expect(i.err.text()).not.toContain('hunter2');
  });

  it('accepts the pnpm "--" separator and rejects unknown commands', async () => {
    const i = io();
    expect(await runAdminCli(['--', 'user:frobnicate', 'alice'], noDb, i.cliIo)).toBe(1);
    expect(i.err.text()).toContain('Unknown command');
  });

  it('rejects an invalid username or weak password before touching the database', async () => {
    const i = io();
    i.readSecret.mockResolvedValue('short');
    expect(await runAdminCli(['user:create', 'a b'], noDb, i.cliIo)).toBe(1);
    expect(i.err.text()).toMatch(/Invalid username|Password rejected/);
    expect(i.err.text()).not.toContain('short');
  });
});

describe('dev seed', () => {
  it('refuses to run in production', async () => {
    await expect(
      seedDevUser(noDb, {
        NODE_ENV: 'production',
        APP_ORIGIN: 'http://localhost:3000',
        SEED_USER_PASSWORD: 'a-long-enough-password',
      }),
    ).rejects.toThrow(/production/);
  });

  it('requires SEED_USER_PASSWORD', async () => {
    await expect(
      seedDevUser(noDb, { NODE_ENV: 'development', APP_ORIGIN: 'http://localhost:3000' }),
    ).rejects.toThrow(/SEED_USER_PASSWORD/);
  });

  it('refuses when APP_ORIGIN is not localhost, unless ALLOW_DEV_SEED=1', async () => {
    const env = { NODE_ENV: 'development', SEED_USER_PASSWORD: 'a-long-enough-password' };
    await expect(
      seedDevUser(noDb, { ...env, APP_ORIGIN: 'https://staging.example.com' }),
    ).rejects.toThrow(/APP_ORIGIN/);
    await expect(seedDevUser(noDb, env)).rejects.toThrow(/APP_ORIGIN/);
    // With the override the guard passes and the (unreachable here) database is touched.
    await expect(
      seedDevUser(noDb, { ...env, APP_ORIGIN: 'https://staging.example.com', ALLOW_DEV_SEED: '1' }),
    ).rejects.toThrow(/db touched/);
  });
});
