import { describe, expect, it } from 'vitest';
import {
  DEVICE_COOKIE_NAME,
  newDeviceId,
  normalizeUsername,
  readDeviceId,
  serializeDeviceCookie,
} from './device';

const SECRET = 'unit-test-secret-0123456789abcdef0123456789';

function jar(setCookie: string): string {
  return setCookie.split(';')[0]!;
}

describe('device cookie', () => {
  it('has hardened attributes and a one year lifetime', () => {
    const cookie = serializeDeviceCookie(SECRET, 'alice', newDeviceId());
    expect(cookie.startsWith(`${DEVICE_COOKIE_NAME}=v1.`)).toBe(true);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=31536000']) {
      expect(cookie).toContain(attr);
    }
    expect(cookie).not.toMatch(/domain=/i);
    expect(cookie).not.toContain('alice'); // no username in the clear
  });

  it('round-trips for the same user, case- and whitespace-insensitively', () => {
    const id = newDeviceId();
    const header = jar(serializeDeviceCookie(SECRET, 'Alice', id));
    expect(readDeviceId(SECRET, header, 'alice')).toBe(id);
    expect(readDeviceId(SECRET, `x=1; ${header}; y=2`, ' ALICE ')).toBe(id);
    expect(normalizeUsername(' ALICE ')).toBe('alice');
  });

  it('treats a cookie bound to another username as absent', () => {
    const header = jar(serializeDeviceCookie(SECRET, 'alice', newDeviceId()));
    expect(readDeviceId(SECRET, header, 'bob')).toBeUndefined();
  });

  it('treats forged, tampered, re-keyed and malformed cookies as absent', () => {
    const id = newDeviceId();
    const valid = jar(serializeDeviceCookie(SECRET, 'alice', id));
    const [name, value] = valid.split('=') as [string, string];
    const [v, , mac] = value.split('.') as [string, string, string];
    const cases = [
      `${name}=${v}.${newDeviceId()}.${mac}`, // id swapped, mac kept
      `${name}=${v}.${id}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`, // mac flipped
      `${name}=${v}.${id}.`, // no mac
      `${name}=v2.${id}.${mac}`, // wrong version
      `${name}=${value}.extra`,
      `${name}=garbage`,
      `${name}=`,
      jar(serializeDeviceCookie('another-secret-0123456789abcdef0123456789', 'alice', id)), // other key
    ];
    for (const header of cases)
      expect(readDeviceId(SECRET, header, 'alice'), header).toBeUndefined();
    expect(readDeviceId(SECRET, null, 'alice')).toBeUndefined();
    expect(readDeviceId(SECRET, 'theme=dark', 'alice')).toBeUndefined();
  });
});
