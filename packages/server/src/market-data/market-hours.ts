import { localDate, dayOfWeek } from './dates';

/**
 * Regular trading hours per MIC, in the EXCHANGE's local time (so DST is handled by the
 * timezone, not by this table). Weekdays only. HOLIDAYS ARE NOT MODELED: on a holiday the
 * worker still asks for quotes; the provider answers with the last session's price (the
 * quote's `as_of` says so) and nothing is fabricated.
 */
export interface TradingHours {
  open: string; // HH:MM local
  close: string; // HH:MM local
}

export const MARKET_HOURS: Readonly<Record<string, TradingHours>> = {
  XPAR: { open: '09:00', close: '17:30' },
  XAMS: { open: '09:00', close: '17:30' },
  XBRU: { open: '09:00', close: '17:30' },
  XLIS: { open: '08:00', close: '16:30' },
  XMIL: { open: '09:00', close: '17:30' },
  XMAD: { open: '09:00', close: '17:30' },
  XETR: { open: '09:00', close: '17:30' },
  XFRA: { open: '08:00', close: '22:00' },
  XSWX: { open: '09:00', close: '17:30' },
  XLON: { open: '08:00', close: '16:30' },
  XSTO: { open: '09:00', close: '17:30' },
  XCSE: { open: '09:00', close: '17:00' },
  XHEL: { open: '10:00', close: '18:30' },
  XOSL: { open: '09:00', close: '16:20' },
  XNYS: { open: '09:30', close: '16:00' },
  XNAS: { open: '09:30', close: '16:00' },
  XTSE: { open: '09:30', close: '16:00' },
};

/** Exchanges missing from the table use a generic European session. */
export const DEFAULT_HOURS: TradingHours = { open: '09:00', close: '17:30' };

/** Quotes are still refreshed this long after the close so the final price is captured. */
export const POST_CLOSE_GRACE_MINUTES = 30;

function minutes(hhmm: string): number {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** Minutes since local midnight at `now` in `timeZone`. */
function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return get('hour') * 60 + get('minute');
}

/**
 * True when the exchange is inside [open, close + grace] on a local weekday. An invalid
 * timezone yields false (never refresh on a guess).
 */
export function isRefreshWindow(now: Date, exchange: { mic: string; timezone: string }): boolean {
  try {
    const weekday = dayOfWeek(localDate(now, exchange.timezone));
    if (weekday === 0 || weekday === 6) return false;
    const hours = Object.hasOwn(MARKET_HOURS, exchange.mic)
      ? MARKET_HOURS[exchange.mic]!
      : DEFAULT_HOURS;
    const minute = localMinutes(now, exchange.timezone);
    return (
      minute >= minutes(hours.open) && minute <= minutes(hours.close) + POST_CLOSE_GRACE_MINUTES
    );
  } catch {
    return false;
  }
}
