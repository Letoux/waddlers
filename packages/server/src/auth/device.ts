import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Device cookie (OWASP "device cookie" pattern): after a successful login the browser gets a
 * signed token bound to the username. A login presenting a valid token for that username is
 * throttled on its own per-device budget instead of the shared per-username backoff, so an
 * attacker hammering a username cannot keep the real user locked out on their usual browser.
 * Only someone who already logged in as that user (knows the password) can obtain one; a token
 * is useless for any other username (bound via HMAC).
 */
export const DEVICE_COOKIE_NAME = '__Host-wd_device';
export const DEVICE_TTL_SECONDS = 365 * 24 * 60 * 60;

const VERSION = 'v1';

/** Usernames are citext: normalise exactly like the database compares them. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function sign(secret: string, username: string, deviceId: string): string {
  return createHmac('sha256', secret)
    .update(`${VERSION}\0${normalizeUsername(username)}\0${deviceId}`)
    .digest('base64url');
}

export function newDeviceId(): string {
  return randomBytes(16).toString('base64url');
}

export function serializeDeviceCookie(secret: string, username: string, deviceId: string): string {
  const value = `${VERSION}.${deviceId}.${sign(secret, username, deviceId)}`;
  return `${DEVICE_COOKIE_NAME}=${value}; Max-Age=${DEVICE_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

/**
 * The device id carried by a valid cookie for this username, else undefined (absent, malformed,
 * forged, tampered, or bound to another username are all indistinguishable).
 */
export function readDeviceId(
  secret: string,
  cookieHeader: string | null | undefined,
  username: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== DEVICE_COOKIE_NAME) continue;
    const [version, deviceId, mac, extra] = part
      .slice(eq + 1)
      .trim()
      .split('.');
    if (version !== VERSION || !deviceId || !mac || extra !== undefined) return undefined;
    if (!/^[A-Za-z0-9_-]{22}$/.test(deviceId)) return undefined;
    const expected = Buffer.from(sign(secret, username, deviceId));
    const actual = Buffer.from(mac);
    return actual.length === expected.length && timingSafeEqual(actual, expected)
      ? deviceId
      : undefined;
  }
  return undefined;
}
