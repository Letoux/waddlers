import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://user:s3cr3t-pw@db:5432/waddlers',
  APP_ORIGIN: 'http://localhost:3000/',
  MARKET_DATA_PROVIDER: 'fake',
};

describe('parseEnv', () => {
  it('accepts a valid env, defaults NODE_ENV and normalizes APP_ORIGIN', () => {
    const env = parseEnv(valid);
    expect(env.NODE_ENV).toBe('development');
    expect(env.APP_ORIGIN).toBe('http://localhost:3000');
    expect(env.MARKET_DATA_PROVIDER).toBe('fake');
  });

  it('rejects missing variables and names them', () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => parseEnv({ ...valid, MARKET_DATA_PROVIDER: undefined })).toThrow(
      /MARKET_DATA_PROVIDER/,
    );
  });

  it('rejects an unknown provider and a non-postgres URL', () => {
    expect(() => parseEnv({ ...valid, MARKET_DATA_PROVIDER: 'nope' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...valid, DATABASE_URL: 'mysql://u:p@h/db' })).toThrow(/DATABASE_URL/);
  });

  it('never echoes secret values in the error message', () => {
    const secretUrl = 'mysql://user:s3cr3t-pw@db:5432/waddlers';
    let message = '';
    try {
      parseEnv({ ...valid, DATABASE_URL: secretUrl, APP_ORIGIN: 'ftp://s3cr3t-pw' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('APP_ORIGIN');
    expect(message).not.toContain('s3cr3t-pw');
    expect(message).not.toContain('mysql://');
  });
});
