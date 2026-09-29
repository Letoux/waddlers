import { describe, expect, it } from 'vitest';
import { assertSafeDatabase } from './safe-database';

describe('assertSafeDatabase', () => {
  it('accepts local test databases', () => {
    expect(() =>
      assertSafeDatabase('postgres://u:p@localhost:5433/waddlers_test', false),
    ).not.toThrow();
    expect(() => assertSafeDatabase('postgres://u:p@127.0.0.1:5433/test', false)).not.toThrow();
    expect(() => assertSafeDatabase('postgres://u:p@localhost/test_e2e', false)).not.toThrow();
  });
  it('rejects names that merely contain "test"', () => {
    for (const name of ['latest', 'contest', 'waddlers', 'testing', 'waddlers-test']) {
      expect(() => assertSafeDatabase(`postgres://u:p@localhost/${name}`, false)).toThrow();
    }
  });
  it('rejects remote hosts unless CI', () => {
    const url = 'postgres://u:p@db.example.com/waddlers_test';
    expect(() => assertSafeDatabase(url, false)).toThrow(/not local/);
    expect(() => assertSafeDatabase(url, true)).not.toThrow();
  });
});
