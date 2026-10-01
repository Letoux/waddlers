import { describe, expect, it } from 'vitest';
import { DASHBOARD_PERIODS } from '@waddlers/contracts';
import {
  DEFAULT_PERIOD,
  PERIOD_LABELS,
  PERIOD_OPTIONS,
  parsePeriodParam,
  resolvePeriod,
  withPeriodSearch,
} from './period';

describe('period URL parameter', () => {
  it('accepts exactly the contract ids', () => {
    for (const id of DASHBOARD_PERIODS) expect(parsePeriodParam(id)).toBe(id);
  });

  it('rejects anything else', () => {
    for (const bad of ['', '1M', 'week', '1w ', '__proto__', 'constructor', '1w,1m'])
      expect(parsePeriodParam(bad)).toBeNull();
    expect(parsePeriodParam(null)).toBeNull();
    expect(parsePeriodParam(undefined)).toBeNull();
    expect(parsePeriodParam(['1w', '1m'])).toBeNull();
  });

  it('falls back to the default', () => {
    expect(resolvePeriod('nope')).toBe(DEFAULT_PERIOD);
    expect(resolvePeriod(null)).toBe('1m');
    expect(resolvePeriod('5y')).toBe('5y');
  });

  it('has a French label for every period, in contract order', () => {
    expect(PERIOD_OPTIONS.map((o) => o.id)).toEqual([...DASHBOARD_PERIODS]);
    expect(PERIOD_LABELS['1w']).toBe('Semaine');
    expect(PERIOD_LABELS.max).toBe('Max');
  });

  it('rewrites the query string keeping other params', () => {
    expect(withPeriodSearch('', '6m')).toBe('?periode=6m');
    expect(withPeriodSearch('?a=1&periode=1w', '1y')).toBe('?a=1&periode=1y');
    expect(withPeriodSearch('?periode=1w', null)).toBe('');
  });
});
