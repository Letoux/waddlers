import { addDays, compareDates, diffDays, type PlainDate } from '@waddlers/domain';
import { isWeekday } from './dates';
import { unit, type FakeFailure } from './fake-provider';
import { FX_LIMIT, toPositiveDecimalString } from './normalize';
import {
  fail,
  ok,
  type CallOptions,
  type Clock,
  type FxBatch,
  type FxProvider,
  type ProviderResult,
} from './types';

/** Plausible EUR-based levels (`1 EUR = x CCY`); the fake only wobbles around them. */
const BASE_RATES: Readonly<Record<string, number>> = {
  USD: 1.1,
  GBP: 0.86,
  CHF: 0.95,
  JPY: 165,
  CAD: 1.5,
  AUD: 1.65,
  SEK: 11.3,
  NOK: 11.0,
  DKK: 7.46,
  PLN: 4.3,
  HKD: 8.6,
  CNY: 7.7,
  ZAR: 19.5,
};

export interface FakeFxProviderOptions {
  clock?: Clock;
  failure?: FakeFailure;
}

/** Deterministic FX: publication days are weekdays, value depends only on (date, currency). */
export class FakeFxProvider implements FxProvider {
  readonly name = 'fake';
  failure: FakeFailure;
  readonly calls = { rates: 0 };
  private readonly clock: Clock;

  constructor(options: FakeFxProviderOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.failure = options.failure ?? { mode: 'none' };
  }

  setFailure(failure: FakeFailure): void {
    this.failure = failure;
  }

  async getDailyRates(
    from: PlainDate,
    to: PlainDate,
    options?: CallOptions,
  ): Promise<ProviderResult<FxBatch>> {
    this.calls.rates += 1;
    if (this.failure.mode === 'error')
      return fail(this.name, this.failure.code, 'injected failure');
    if (this.failure.mode === 'hang') {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        options?.signal?.addEventListener('abort', () => resolve());
      });
      return fail(this.name, 'timeout', 'injected hang aborted');
    }
    const today = this.clock().toISOString().slice(0, 10);
    const end = compareDates(to, today) > 0 ? today : to;
    const rates: FxBatch['rates'] = [];
    let rejectedRows = 0;
    let n = 0;
    for (let date = from; compareDates(date, end) <= 0; date = addDays(date, 1)) {
      if (!isWeekday(date)) continue;
      const days = diffDays('2000-01-01', date);
      for (const [currency, base] of Object.entries(BASE_RATES)) {
        const wave = Math.sin((2 * Math.PI * days) / 700 + unit(currency, 'phase') * 6.28) * 0.06;
        const noise = (unit(currency, date) - 0.5) * 0.008;
        let raw: unknown = (base * (1 + wave + noise)).toFixed(5);
        if (this.failure.mode === 'malformed' && n % 7 === 0)
          raw = [0, -1, Number.NaN, ''][((n / 7) % 4) | 0];
        n += 1;
        const ratePerEur = toPositiveDecimalString(raw, FX_LIMIT);
        if (ratePerEur === null) rejectedRows += 1;
        else rates.push({ date, currency, ratePerEur });
      }
    }
    return ok(this.name, { rates, rejectedRows }, this.clock());
  }
}
