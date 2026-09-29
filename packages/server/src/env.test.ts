import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://user:s3cr3t-pw@db:5432/waddlers',
  APP_ORIGIN: 'http://localhost:3000/',
  MARKET_DATA_PROVIDER: 'fake',
  AUTH_SECRET: 'x'.repeat(32),
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

describe('parseEnv (auth-related)', () => {
  const base = {
    DATABASE_URL: 'postgres://user:pw@db:5432/waddlers',
    MARKET_DATA_PROVIDER: 'fake',
    AUTH_SECRET: 'x'.repeat(32),
  };

  it('requires https in production, except for localhost (Secure __Host- cookie)', () => {
    const prod = { ...base, NODE_ENV: 'production' };
    expect(() => parseEnv({ ...prod, APP_ORIGIN: 'http://waddlers.example.com' })).toThrow(
      /APP_ORIGIN/,
    );
    expect(parseEnv({ ...prod, APP_ORIGIN: 'https://waddlers.example.com' }).APP_ORIGIN).toBe(
      'https://waddlers.example.com',
    );
    expect(parseEnv({ ...prod, APP_ORIGIN: 'http://localhost:3000' }).APP_ORIGIN).toBe(
      'http://localhost:3000',
    );
    // Development is not restricted.
    expect(parseEnv({ ...base, APP_ORIGIN: 'http://192.168.1.10:3000' }).NODE_ENV).toBe(
      'development',
    );
  });

  it('accepts only known proxy headers for TRUSTED_PROXY_HEADER', () => {
    const ok = { ...base, APP_ORIGIN: 'http://localhost:3000' };
    expect(parseEnv({ ...ok, TRUSTED_PROXY_HEADER: 'x-forwarded-for' }).TRUSTED_PROXY_HEADER).toBe(
      'x-forwarded-for',
    );
    expect(parseEnv(ok).TRUSTED_PROXY_HEADER).toBeUndefined();
    expect(parseEnv({ ...ok, TRUSTED_PROXY_HEADER: '' }).TRUSTED_PROXY_HEADER).toBeUndefined();
    expect(() => parseEnv({ ...ok, TRUSTED_PROXY_HEADER: 'host' })).toThrow(/TRUSTED_PROXY_HEADER/);
  });
});

describe('parseEnv (AUTH_SECRET)', () => {
  const base = {
    DATABASE_URL: 'postgres://user:pw@db:5432/waddlers',
    APP_ORIGIN: 'http://localhost:3000',
    MARKET_DATA_PROVIDER: 'fake',
  };

  it('is required and must be at least 32 bytes, without echoing the value', () => {
    expect(() => parseEnv(base)).toThrow(/AUTH_SECRET/);
    let message = '';
    try {
      parseEnv({ ...base, AUTH_SECRET: 'too-short-secret' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('AUTH_SECRET');
    expect(message).not.toContain('too-short-secret');
    expect(parseEnv({ ...base, AUTH_SECRET: 'x'.repeat(32) }).AUTH_SECRET).toHaveLength(32);
    // Bytes, not characters: 16 two-byte characters are 32 bytes.
    expect(parseEnv({ ...base, AUTH_SECRET: 'é'.repeat(16) }).AUTH_SECRET).toHaveLength(16);
  });
});
