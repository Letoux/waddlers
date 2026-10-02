import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupAppRole } from './roles';

const ROLE = 'waddlers_app_it';
const PASSWORD = 'it-role-password-0123456789';

function urlFor(user: string, password: string): string {
  const url = new URL(process.env.DATABASE_URL_TEST!);
  url.username = user;
  url.password = password;
  return url.toString();
}

describe('DML-only application role', () => {
  const owner = postgres(process.env.DATABASE_URL_TEST!, { max: 1, onnotice: () => {} });
  let app: postgres.Sql;

  beforeAll(async () => {
    await setupAppRole(process.env.DATABASE_URL_TEST!, { role: ROLE, password: PASSWORD });
    // Idempotent: a second run (as in every deploy) must not fail.
    await setupAppRole(process.env.DATABASE_URL_TEST!, { role: ROLE, password: PASSWORD });
    app = postgres(urlFor(ROLE, PASSWORD), { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await app.end({ timeout: 5 });
    await owner.unsafe('drop table if exists it_late_table');
    await owner.end({ timeout: 5 });
  });

  it('is not a superuser and cannot create roles or databases', async () => {
    const [row] =
      await owner`select rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = ${ROLE}`;
    expect(row).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false });
  });

  it('has a statement timeout and an idle-in-transaction timeout (applied to new sessions)', async () => {
    const [row] = await app`show statement_timeout`;
    expect(row).toEqual({ statement_timeout: '10s' });
    const [idle] = await app`show idle_in_transaction_session_timeout`;
    expect(idle).toEqual({ idle_in_transaction_session_timeout: '30s' });
    // The owner session is not limited (migrations and backfills may run long).
    const [ownerRow] = await owner`show statement_timeout`;
    expect(ownerRow).toEqual({ statement_timeout: '0' });
  });

  it('can read and write application tables', async () => {
    await app`delete from users where username = 'roles-it'`;
    await app`insert into users (username, password_hash) values ('roles-it', 'x')`;
    await app`update users set updated_at = now() where username = 'roles-it'`;
    const rows = await app`select username from users where username = 'roles-it'`;
    expect(rows).toHaveLength(1);
    await app`delete from users where username = 'roles-it'`;
  });

  it('can read and write table_configs (S7), through its membership FK', async () => {
    await app`delete from users where username in ('roles-it-cfg')`;
    await app`delete from spaces where name = 'roles-it-space'`;
    const [u] =
      await app`insert into users (username, password_hash) values ('roles-it-cfg', 'x') returning id`;
    const [sp] = await app`insert into spaces (name) values ('roles-it-space') returning id`;
    await app`insert into space_members (space_id, user_id, role) values (${sp!.id}, ${u!.id}, 'viewer')`;
    await app`insert into table_configs (user_id, space_id, version, config)
      values (${u!.id}, ${sp!.id}, 1, ${app.json({ columns: [] })})`;
    await app`update table_configs set updated_at = now() where user_id = ${u!.id}`;
    expect(await app`select 1 from table_configs where user_id = ${u!.id}`).toHaveLength(1);
    await app`delete from table_configs where user_id = ${u!.id}`;
    await app`delete from spaces where id = ${sp!.id}`;
    await app`delete from users where id = ${u!.id}`;
  });

  it('can call unaccent (migration 0006: the table search runs as the app role)', async () => {
    const [row] = await app`select unaccent(lower('Électricité d’Hermès')) as folded`;
    expect(row).toEqual({ folded: "electricite d'hermes" });
  });

  it('cannot run DDL, truncate, or touch the migration history', async () => {
    const denied = async (statement: string) => {
      await expect(app.unsafe(statement)).rejects.toMatchObject({ code: '42501' });
    };
    await denied('create table it_forbidden (id int)');
    await denied('drop table sessions');
    await denied('alter table users add column nope text');
    await denied('truncate table users');
    await denied('select * from drizzle.__drizzle_migrations');
  });

  it('automatically gets DML on tables created later by the owner (future migrations)', async () => {
    await owner.unsafe('create table it_late_table (id int primary key)');
    await app`insert into it_late_table (id) values (1)`;
    expect(await app`select id from it_late_table`).toHaveLength(1);
  });

  it('rejects a password that is not URL-safe or too short', async () => {
    await expect(
      setupAppRole(process.env.DATABASE_URL_TEST!, { role: ROLE, password: 'short' }),
    ).rejects.toThrow(/APP_DB_PASSWORD/);
    await expect(
      setupAppRole(process.env.DATABASE_URL_TEST!, {
        role: ROLE,
        password: 'has@special:chars/0123456789',
      }),
    ).rejects.toThrow(/URL-safe/);
    await expect(
      setupAppRole(process.env.DATABASE_URL_TEST!, { role: 'Bad Role;', password: PASSWORD }),
    ).rejects.toThrow(/role/i);
  });
});
