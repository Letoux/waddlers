import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv, parseWorkerEnv } from './env';

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
  });

  it('defaults the market-data settings and treats Compose empty strings as unset', () => {
    const env = parseEnv({ ...valid, MARKET_DATA_PROVIDER: '', FX_PROVIDER: '' });
    expect(env).toMatchObject({
      MARKET_DATA_PROVIDER: 'fake',
      FX_PROVIDER: 'fake',
      MARKET_DATA_QUOTE_TTL_MINUTES: 15,
      MARKET_DATA_HISTORY_TTL_HOURS: 12,
      MARKET_DATA_FX_TTL_HOURS: 12,
    });
    expect(env).not.toHaveProperty('EODHD_API_TOKEN');
  });

  it('validates market-data settings without echoing values', () => {
    expect(() => parseEnv({ ...valid, FX_PROVIDER: 'nope' })).toThrow(/FX_PROVIDER/);
    expect(() => parseEnv({ ...valid, MARKET_DATA_QUOTE_TTL_MINUTES: '0' })).toThrow(
      /MARKET_DATA_QUOTE_TTL_MINUTES/,
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

describe('EODHD_API_TOKEN belongs to the worker env only', () => {
  it('the web env neither requires nor accepts it (any value is dropped, never validated)', () => {
    expect(parseEnv(valid)).not.toHaveProperty('EODHD_API_TOKEN');
    const withToken = parseEnv({ ...valid, EODHD_API_TOKEN: 'long-enough-token-value' });
    expect(withToken).not.toHaveProperty('EODHD_API_TOKEN');
    expect(JSON.stringify(withToken)).not.toContain('long-enough-token-value');
    expect(() => parseEnv({ ...valid, EODHD_API_TOKEN: 'x' })).not.toThrow(); // not validated here
  });

  it('the worker env accepts, validates and never echoes it', () => {
    const source = { DATABASE_URL: valid.DATABASE_URL };
    expect(parseWorkerEnv(source).EODHD_API_TOKEN).toBeUndefined();
    expect(parseWorkerEnv({ ...source, EODHD_API_TOKEN: '' }).EODHD_API_TOKEN).toBeUndefined();
    expect(
      parseWorkerEnv({ ...source, EODHD_API_TOKEN: 'long-enough-token' }).EODHD_API_TOKEN,
    ).toBe('long-enough-token');
    let message = '';
    try {
      parseWorkerEnv({ ...source, EODHD_API_TOKEN: 'short' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('EODHD_API_TOKEN');
    expect(message).not.toContain('short');
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
