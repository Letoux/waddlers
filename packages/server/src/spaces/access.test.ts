import { describe, expect, it } from 'vitest';
import type { DbExecutor } from '../db/create';
import { requireSpaceAccess, roleAtLeast, type AuthorizedSpace } from './access';
import { deletePosition, updatePositionQuantity } from './repository';
import { queryTablePage, queryTableTotals, type TableQuery } from './table-query';

const db = {} as DbExecutor;
const query = {} as TableQuery;

describe('AuthorizedSpace is a compile-time requirement of per-space repositories', () => {
  it('rejects plain ids and look-alike objects at compile time', () => {
    // Never executed: these lines only have to fail type-checking (`tsc` fails if any compiles).
    const neverRun = () => {
      // @ts-expect-error a bare space id is not an AuthorizedSpace
      void queryTablePage(db, 'a-space-id', query);
      // @ts-expect-error a bare space id is not an AuthorizedSpace
      void queryTableTotals(db, 'a-space-id', undefined);
      // @ts-expect-error a structurally similar object is not branded
      void deletePosition(db, { id: 'x', role: 'owner', userId: null }, 'p');
      // @ts-expect-error the brand cannot be forged by an object literal
      void updatePositionQuantity(db, { id: 'x', role: 'owner', userId: 'u' }, 'p', '1');
    };
    expect(typeof neverRun).toBe('function');
    const ok = (space: AuthorizedSpace) => queryTablePage(db, space, query);
    expect(typeof ok).toBe('function');
  });
});

describe('roleAtLeast', () => {
  it('orders viewer < editor < owner', () => {
    expect(roleAtLeast('viewer', 'viewer')).toBe(true);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
    expect(roleAtLeast('editor', 'editor')).toBe(true);
    expect(roleAtLeast('editor', 'owner')).toBe(false);
    expect(roleAtLeast('owner', 'viewer')).toBe(true);
  });
});

describe('requireSpaceAccess input handling', () => {
  it.each([undefined, null, 42, '', 'not-a-uuid', "1'; drop table spaces;--", {}])(
    'a malformed space id (%j) is NOT_FOUND and never reaches the database',
    async (bad) => {
      const throwingDb = new Proxy({} as DbExecutor, {
        get() {
          throw new Error('database must not be touched');
        },
      });
      await expect(
        requireSpaceAccess({ db: throwingDb, userId: crypto.randomUUID() }, bad, 'viewer'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    },
  );
});
