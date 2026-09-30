import { describe, expect, it } from 'vitest';
import { isRefreshWindow, MARKET_HOURS, POST_CLOSE_GRACE_MINUTES } from './market-hours';
import { JobLock, nextDailyRun } from './scheduler';

const PAR = { mic: 'XPAR', timezone: 'Europe/Paris' };
const LON = { mic: 'XLON', timezone: 'Europe/London' };
const NAS = { mic: 'XNAS', timezone: 'America/New_York' };
const at = (iso: string) => new Date(iso);

// 2026-09-30 is a Wednesday, DST in force (CEST = UTC+2, BST = UTC+1, EDT = UTC-4).
describe('isRefreshWindow, summer (DST) weekday', () => {
  it.each([
    ['XPAR', PAR, '2026-09-30T06:59:00Z', false], // 08:59 local
    ['XPAR', PAR, '2026-09-30T07:00:00Z', true], // 09:00 open, inclusive
    ['XPAR', PAR, '2026-09-30T15:30:00Z', true], // 17:30 close
    ['XPAR', PAR, '2026-09-30T16:00:00Z', true], // 18:00 = close + 30 min grace, inclusive
    ['XPAR', PAR, '2026-09-30T16:01:00Z', false],
    ['XLON', LON, '2026-09-30T06:59:00Z', false], // 07:59 local
    ['XLON', LON, '2026-09-30T07:00:00Z', true], // 08:00 open
    ['XLON', LON, '2026-09-30T16:00:00Z', true], // 17:00 = 16:30 + grace
    ['XLON', LON, '2026-09-30T16:01:00Z', false],
    ['XNAS', NAS, '2026-09-30T13:29:00Z', false], // 09:29 local
    ['XNAS', NAS, '2026-09-30T13:30:00Z', true], // 09:30 open
    ['XNAS', NAS, '2026-09-30T20:30:00Z', true], // 16:30 = 16:00 + grace
    ['XNAS', NAS, '2026-09-30T20:31:00Z', false],
  ])('%s at %s -> %s', (_mic, exchange, iso, expected) => {
    expect(isRefreshWindow(at(iso), exchange)).toBe(expected);
  });

  it('one instant can be inside one exchange window and outside another', () => {
    const now = at('2026-09-30T17:00:00Z'); // 19:00 Paris, 18:00 London, 13:00 New York
    expect(isRefreshWindow(now, PAR)).toBe(false);
    expect(isRefreshWindow(now, LON)).toBe(false);
    expect(isRefreshWindow(now, NAS)).toBe(true);
  });
});

describe('isRefreshWindow, winter weekday (offsets shift with DST)', () => {
  // 2026-12-02 Wednesday: CET = UTC+1, GMT = UTC+0, EST = UTC-5.
  it('Paris opens at 08:00Z in winter, not 07:00Z', () => {
    expect(isRefreshWindow(at('2026-12-02T07:59:00Z'), PAR)).toBe(false);
    expect(isRefreshWindow(at('2026-12-02T08:00:00Z'), PAR)).toBe(true);
  });
  it('London opens at 08:00Z in winter', () => {
    expect(isRefreshWindow(at('2026-12-02T07:59:00Z'), LON)).toBe(false);
    expect(isRefreshWindow(at('2026-12-02T08:00:00Z'), LON)).toBe(true);
  });
  it('New York opens at 14:30Z in winter', () => {
    expect(isRefreshWindow(at('2026-12-02T14:29:00Z'), NAS)).toBe(false);
    expect(isRefreshWindow(at('2026-12-02T14:30:00Z'), NAS)).toBe(true);
  });
});

describe('isRefreshWindow, weekends and fallbacks', () => {
  it('is closed all Saturday and Sunday (local date decides, not UTC)', () => {
    expect(isRefreshWindow(at('2026-10-03T10:00:00Z'), PAR)).toBe(false); // Saturday
    expect(isRefreshWindow(at('2026-10-04T14:00:00Z'), NAS)).toBe(false); // Sunday
    // Friday 23:30Z is already Saturday 01:30 in Paris (closed anyway) and Friday 19:30 in NY.
    expect(isRefreshWindow(at('2026-10-02T23:30:00Z'), PAR)).toBe(false);
  });

  it('Monday morning opens by local time: Sunday-evening UTC is still closed', () => {
    expect(isRefreshWindow(at('2026-10-04T22:30:00Z'), PAR)).toBe(false); // Mon 00:30 Paris
    expect(isRefreshWindow(at('2026-10-05T07:00:00Z'), PAR)).toBe(true);
  });

  it('unknown MIC falls back to the generic European session', () => {
    const x = { mic: 'XXXX', timezone: 'Europe/Paris' };
    expect(isRefreshWindow(at('2026-09-30T07:00:00Z'), x)).toBe(true);
    expect(isRefreshWindow(at('2026-09-30T06:00:00Z'), x)).toBe(false);
  });

  it('an invalid timezone never refreshes on a guess', () => {
    expect(
      isRefreshWindow(at('2026-09-30T10:00:00Z'), { mic: 'XPAR', timezone: 'Mars/Base' }),
    ).toBe(false);
  });

  it('table sanity: every session closes after it opens and the grace is 30 minutes', () => {
    for (const h of Object.values(MARKET_HOURS)) expect(h.close > h.open).toBe(true);
    expect(POST_CLOSE_GRACE_MINUTES).toBe(30);
  });
});

describe('nextDailyRun', () => {
  it('is today when the time is still ahead, tomorrow when passed or equal', () => {
    expect(nextDailyRun(at('2026-09-30T03:00:00Z'), 3, 30).toISOString()).toBe(
      '2026-09-30T03:30:00.000Z',
    );
    expect(nextDailyRun(at('2026-09-30T03:30:00Z'), 3, 30).toISOString()).toBe(
      '2026-10-01T03:30:00.000Z',
    );
    expect(nextDailyRun(at('2026-09-30T23:59:00Z'), 3, 30).toISOString()).toBe(
      '2026-10-01T03:30:00.000Z',
    );
  });
  it('rolls over month and year ends', () => {
    expect(nextDailyRun(at('2026-12-31T05:00:00Z'), 3, 30).toISOString()).toBe(
      '2027-01-01T03:30:00.000Z',
    );
  });
});

describe('JobLock', () => {
  it('skips an overlapping run of the same job, allows other jobs, and releases on failure', async () => {
    const lock = new JobLock();
    let release: () => void = () => {};
    const first = lock.run('quotes', () => new Promise<void>((r) => (release = r)));
    expect(lock.isRunning('quotes')).toBe(true);
    expect(await lock.run('quotes', async () => 1)).toEqual({ ran: false });
    expect(await lock.run('nightly', async () => 2)).toEqual({ ran: true, value: 2 });
    release();
    expect(await first).toEqual({ ran: true, value: undefined });
    expect(lock.isRunning('quotes')).toBe(false);

    await expect(lock.run('quotes', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(lock.isRunning('quotes')).toBe(false);
  });
});
