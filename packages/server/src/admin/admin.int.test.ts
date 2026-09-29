import { Readable, Writable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { sessions, users } from '../db/schema';
import {
  createApp,
  PASSWORD,
  releaseTestEnv,
  resetAuthTables,
  useTestEnv,
} from '../../test/auth-harness';
import { hashPassword, verifyPassword } from '../auth/password';
import { runAdminCli, type CliIo } from './cli';
import { AdminError, createUser, disableUser, resetPassword } from './index';
import { readSecret } from './prompt';
import { seedDevUser } from './seed';

beforeAll(useTestEnv);
afterAll(releaseTestEnv);
beforeEach(resetAuthTables);

describe('admin user management', () => {
  it('creates a user with an argon2id hash (never the plaintext)', async () => {
    const created = await createUser(getDb(), { username: 'Alice', password: PASSWORD });
    const [row] = await getDb().select().from(users).where(eq(users.id, created.id));
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row?.passwordHash).not.toContain(PASSWORD);
    expect(await verifyPassword(row!.passwordHash, PASSWORD)).toBe(true);
    expect(row?.disabledAt).toBeNull();
  });

  it('rejects duplicates case-insensitively, weak passwords and bad usernames', async () => {
    await createUser(getDb(), { username: 'alice', password: PASSWORD });
    await expect(createUser(getDb(), { username: 'ALICE', password: PASSWORD })).rejects.toThrow(
      'already exists',
    );
    await expect(
      createUser(getDb(), { username: 'carol', password: 'short' }),
    ).rejects.toBeInstanceOf(AdminError);
    await expect(createUser(getDb(), { username: 'x y', password: PASSWORD })).rejects.toThrow(
      /username/i,
    );
    expect(await getDb().select().from(users)).toHaveLength(1);
  });

  it('reset-password sets the new password and revokes every session', async () => {
    await createUser(getDb(), { username: 'alice', password: PASSWORD });
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    await loginAs('alice');
    const result = await resetPassword(getDb(), {
      username: 'alice',
      password: 'brand new passphrase!',
    });
    expect(result.revokedSessions).toBe(2);
    expect(await getDb().select().from(sessions)).toHaveLength(0);
    expect((await rpc('auth.me', undefined, { cookie })).status).toBe(401);
    expect((await rpc('auth.login', { username: 'alice', password: PASSWORD })).status).toBe(401);
    expect(
      (await rpc('auth.login', { username: 'alice', password: 'brand new passphrase!' })).status,
    ).toBe(200);
    await expect(resetPassword(getDb(), { username: 'ghost', password: PASSWORD })).rejects.toThrow(
      'not found',
    );
  });

  it('disable revokes sessions, blocks login and is idempotent', async () => {
    await createUser(getDb(), { username: 'alice', password: PASSWORD });
    const { rpc, loginAs } = createApp();
    const cookie = await loginAs('alice');
    expect((await disableUser(getDb(), { username: 'alice' })).revokedSessions).toBe(1);
    const [first] = await getDb().select().from(users);
    expect(first?.disabledAt).not.toBeNull();
    await disableUser(getDb(), { username: 'alice' });
    const [second] = await getDb().select().from(users);
    expect(second?.disabledAt?.getTime()).toBe(first?.disabledAt?.getTime());
    expect((await rpc('auth.me', undefined, { cookie })).status).toBe(401);
    expect((await rpc('auth.login', { username: 'alice', password: PASSWORD })).status).toBe(401);
  });

  it('upgrades a weaker stored hash on successful login', async () => {
    await createUser(getDb(), { username: 'alice', password: PASSWORD });
    const { hash } = await import('@node-rs/argon2');
    const weak = await hash(PASSWORD, {
      algorithm: 2,
      memoryCost: 4096,
      timeCost: 1,
      parallelism: 1,
    });
    await getDb().update(users).set({ passwordHash: weak });
    const { rpc } = createApp();
    expect((await rpc('auth.login', { username: 'alice', password: PASSWORD })).status).toBe(200);
    const [row] = await getDb().select().from(users);
    expect(row?.passwordHash).not.toBe(weak);
    expect(row?.passwordHash).toContain('m=19456,t=2,p=1');
  });
});

describe('admin CLI end to end (stdin password)', () => {
  function cli(secrets: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const sink = (into: string[]) =>
      new Writable({ write: (chunk, _e, done) => (into.push(String(chunk)), done()) });
    const io: CliIo = {
      out: sink(out),
      err: sink(err),
      interactive: false,
      readSecret: (prompt) =>
        readSecret(prompt, {
          input: Readable.from([`${secrets.shift() ?? ''}\n`]),
          output: sink([]),
        }),
    };
    return { io, out: () => out.join(''), err: () => err.join('') };
  }

  it('user:create then user:reset-password then user:disable', async () => {
    const created = cli([PASSWORD]);
    expect(await runAdminCli(['--', 'user:create', 'alice'], getDb(), created.io)).toBe(0);
    expect(created.out()).toContain('User created: alice');
    expect(created.out() + created.err()).not.toContain(PASSWORD);

    const dup = cli([PASSWORD]);
    expect(await runAdminCli(['user:create', 'alice'], getDb(), dup.io)).toBe(1);
    expect(dup.err()).toContain('already exists');

    expect(
      await runAdminCli(
        ['user:reset-password', 'alice'],
        getDb(),
        cli(['a whole new passphrase']).io,
      ),
    ).toBe(0);
    const disabled = cli([]);
    expect(await runAdminCli(['user:disable', 'alice'], getDb(), disabled.io)).toBe(0);
    expect(await runAdminCli(['user:disable', 'ghost'], getDb(), cli([]).io)).toBe(1);
  });
});

describe('dev seed', () => {
  it('creates the dev user once and does not reset an existing password', async () => {
    const env = {
      NODE_ENV: 'development',
      SEED_USER_PASSWORD: PASSWORD,
      SEED_USER_USERNAME: 'devuser',
    };
    expect(await seedDevUser(getDb(), env)).toEqual({ status: 'created', username: 'devuser' });
    const [before] = await getDb().select().from(users);
    expect(
      await seedDevUser(getDb(), { ...env, SEED_USER_PASSWORD: 'a different passphrase' }),
    ).toEqual({
      status: 'exists',
      username: 'devuser',
    });
    const [after] = await getDb().select().from(users);
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(await verifyPassword(after!.passwordHash, PASSWORD)).toBe(true);
    void hashPassword;
  });
});
