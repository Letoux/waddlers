import { describe, expect, it } from 'vitest';
import { TABLE_COLUMNS_BY_ID, type TableColumnId } from '@waddlers/contracts';
import {
  cellView,
  formatMoney,
  isRightAligned,
  REASON_LABELS,
  columnHeader,
  PENDING_TOOLTIP,
  RECALCULATING_TEXT,
  unsortableReason,
} from './cells';

const def = (id: TableColumnId) => {
  const d = TABLE_COLUMNS_BY_ID.get(id);
  if (!d) throw new Error(id);
  return d;
};
const NBSP = ' ';

describe('pending (S8) columns', () => {
  it.each(['market_cap_eur', 'dividend_yield', 'main_holders'] as const)(
    '%s is a dash with the "bientôt" tooltip, whatever the value',
    (id) => {
      for (const value of [
        null,
        undefined,
        '12',
        { kind: 'perf' as const, value: '3', baseDate: null },
      ] as never[]) {
        const v = cellView(def(id), value);
        expect(v.text).toBe('—');
        expect(v.unavailable).toBe(true);
        expect(v.tooltip).toBe(PENDING_TOOLTIP);
      }
    },
  );
});

describe('null is a dash, never zero', () => {
  it.each(['name', 'price_eur', 'perf_1y', 'fx_rate', 'quantity', 'price_date'] as const)(
    '%s',
    (id) => {
      expect(cellView(def(id), null).text).toBe('—');
      expect(cellView(def(id), undefined).text).toBe('—');
    },
  );
});

describe('money', () => {
  it('formats EUR and keeps a raw currency, with the price date', () => {
    const eur = cellView(def('price_eur'), {
      kind: 'money' as const,
      amount: '1234.5',
      currency: 'EUR',
      asOf: '2026-09-29',
      isStale: false,
      reason: null,
    });
    expect(eur.text).toBe(`1${' '}234,50${NBSP}€`);
    expect(eur.tooltip).toBe('Cours du 29/09/2026');
    expect(eur.stale).toBe(false);
  });
  it('flags a stale price', () => {
    const v = cellView(def('price_eur'), {
      kind: 'money' as const,
      amount: '10',
      currency: 'EUR',
      asOf: '2026-09-01',
      isStale: true,
      reason: null,
    });
    expect(v.stale).toBe(true);
    expect(v.tooltip).toContain('donnée ancienne');
  });
  it('an unavailable amount is a dash with a French reason', () => {
    const v = cellView(def('tracked_value_eur'), {
      kind: 'money' as const,
      amount: null,
      currency: 'EUR',
      asOf: null,
      isStale: false,
      reason: 'watchlist',
    });
    expect(v.text).toBe('—');
    expect(v.tooltip).toBe('Titre sans quantité (liste de suivi)');
  });
  it('a real zero amount stays 0', () => {
    expect(
      cellView(def('tracked_value_eur'), {
        kind: 'money' as const,
        amount: '0',
        currency: 'EUR',
        asOf: null,
        isStale: false,
        reason: null,
      }).text,
    ).toContain('0,00');
  });
});

describe('perf', () => {
  const perf = (value: string | null, extra = {}) => ({
    kind: 'perf' as const,
    value,
    baseDate: '2025-09-29',
    reason: null,
    asOf: '2026-09-29',
    isStale: false,
    ...extra,
  });
  it('shows sign, tone and the base date', () => {
    const up = cellView(def('perf_1y'), perf('10.74'));
    expect(up.text).toBe(`+10,7${NBSP}%`);
    expect(up.tone).toBe('gain');
    expect(up.tooltip).toBe('Depuis le 29/09/2025');
    const down = cellView(def('perf_1y'), perf('-3.2'));
    expect(down.text).toContain('3,2');
    expect(down.tone).toBe('loss');
  });
  it('a value that rounds to zero is neutral', () => {
    expect(cellView(def('perf_1y'), perf('0.01')).tone).toBe('neutral');
  });
  it('null with a reason is a dash and the reason', () => {
    const v = cellView(
      def('perf_1y'),
      perf(null, { baseDate: null, reason: 'insufficient_history' }),
    );
    expect(v.text).toBe('—');
    expect(v.tooltip).toBe('Historique insuffisant sur la période');
  });
  it('flags stale', () => {
    expect(cellView(def('perf_1y'), perf('1', { isStale: true })).stale).toBe(true);
  });
});

describe('fx (specs 34 direction)', () => {
  it('reads "1 USD = 0,8807 EUR" with the rate date', () => {
    const v = cellView(def('fx_rate'), {
      kind: 'fx' as const,
      eurPerUnit: '0.88070',
      currency: 'USD',
      rateDate: '2026-09-29',
      isStale: false,
    });
    expect(v.text).toBe('1 USD = 0,8807 EUR');
    expect(v.tooltip).toBe('Taux du 29/09/2026');
  });
  it('a missing rate is a dash, not 1', () => {
    const v = cellView(def('fx_rate'), {
      kind: 'fx' as const,
      eurPerUnit: null,
      currency: 'USD',
      rateDate: null,
      isStale: false,
    });
    expect(v.text).toBe('—');
  });
});

describe('text, decimal and date', () => {
  it('formats a date and a decimal in fr-FR, labels the type', () => {
    expect(cellView(def('price_date'), '2026-09-29').text).toBe('29/09/2026');
    expect(cellView({ ...def('quantity'), cell: 'decimal' }, '1234.5').text).toBe(`1${' '}234,5`);
    expect(cellView(def('instrument_type'), 'etf').text).toBe('ETF');
    expect(cellView(def('name'), 'LVMH').text).toBe('LVMH');
    expect(cellView(def('sector'), '').text).toBe('—');
  });
});

describe('columnHeader', () => {
  it('Performance période carries the period label, others their short label', () => {
    expect(columnHeader(def('perf_period'), '1y')).toBe('Perf. 1 an');
    expect(columnHeader(def('perf_period'), '1w')).toBe('Perf. 1 sem.');
    expect(columnHeader(def('price_eur'), '1y')).toBe('Cours EUR');
    expect(columnHeader(def('name'), '1y')).toBe('Société');
  });
});

describe('recalculating tracked value (optimistic quantity edit)', () => {
  it('shows an ellipsis, never a number or zero', () => {
    const v = cellView(def('tracked_value_eur'), {
      kind: 'money' as const,
      amount: null,
      currency: 'EUR',
      asOf: null,
      isStale: false,
      reason: 'recalculating',
    });
    expect(v.text).toBe(RECALCULATING_TEXT);
    expect(v.tooltip).toBe('Mise à jour en cours');
  });
});

describe('unsortableReason', () => {
  it('explains the local-currency price and pending columns', () => {
    expect(unsortableReason(def('price'))).toContain('Cours EUR');
    expect(unsortableReason(def('market_cap_eur'))).toBe(PENDING_TOOLTIP);
    expect(unsortableReason(def('price_eur'))).toBeNull();
    expect(unsortableReason(def('name'))).toBeNull();
  });
});

describe('formatMoney', () => {
  it('never reads a minor unit as pounds or rand (F-FE1)', () => {
    for (const code of ['GBp', 'GBX']) {
      const t = formatMoney('2000', code);
      expect(t).toBe(`2\u202f000${NBSP}pence (${code})`);
      expect(t).not.toContain('£');
    }
    const za = formatMoney('1500', 'ZAc');
    expect(za).toContain('pence (ZAc)');
    expect(za).not.toMatch(/R|ZAR/);
  });
  it('formats major currencies', () => {
    expect(formatMoney('1234.5', 'EUR')).toBe(`1\u202f234,50${NBSP}€`);
    expect(formatMoney('12.5', 'USD')).toContain('12,50');
  });
  it('an unknown code is shown raw, never as a currency', () => {
    expect(formatMoney('12.5', 'XYZ1')).toBe(`12,5${NBSP}XYZ1`);
  });
  it('a positive amount never renders as 0 (F-FE2)', () => {
    expect(formatMoney('0.0042', 'EUR', { price: true })).toBe(`0,0042${NBSP}€`);
    expect(formatMoney('0.1234', 'USD', { price: true })).toContain('0,1234');
    expect(formatMoney('0.00001', 'EUR', { price: true })).toBe(`< 0,0001${NBSP}€`);
    expect(formatMoney('0.004', 'EUR')).toBe(`< 0,01${NBSP}€`);
    expect(formatMoney('0.00001', 'GBp', { price: true })).toContain('< 0,0001');
  });
  it('a real zero stays 0', () => {
    expect(formatMoney('0', 'EUR')).toBe(`0,00${NBSP}€`);
    expect(formatMoney('0', 'EUR', { price: true })).toBe(`0,00${NBSP}€`);
  });
});

describe('reason labels', () => {
  it('every shared reason code has a French label', () => {
    for (const label of Object.values(REASON_LABELS)) expect(label.length).toBeGreaterThan(3);
    expect(REASON_LABELS.fx_missing).toBe('Taux de change indisponible');
    expect(REASON_LABELS.rounds_to_zero).toBe('Montant trop petit pour être affiché');
  });
});

describe('alignment (F-FE6)', () => {
  it('numeric columns are right-aligned, text and dates are not', () => {
    for (const id of [
      'quantity',
      'price',
      'price_eur',
      'fx_rate',
      'perf_1y',
      'tracked_value_eur',
    ] as const)
      expect(isRightAligned(def(id)), id).toBe(true);
    for (const id of ['name', 'symbol', 'currency', 'price_date', 'sector'] as const)
      expect(isRightAligned(def(id)), id).toBe(false);
  });
});
