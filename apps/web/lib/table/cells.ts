import { INSTRUMENT_TYPE_LABELS } from '@waddlers/contracts';
import { normalizeCurrency } from '@waddlers/domain';
import type {
  FxCell,
  MoneyCell,
  PercentCell,
  PerfCell,
  TableCell,
  TableColumnDef,
  TableColumnId,
  TableReason,
} from '@waddlers/contracts';
import {
  displayedSign,
  formatNumericDate,
  formatPct,
  formatRate,
  formatSignedPct,
  NBSP,
  UNAVAILABLE,
} from '@/lib/dashboard/format';
import { formatQuantity } from '@/lib/spaces/quantity';

/**
 * Pure view model of one table cell (specs 18, 34, CLAUDE.md 5). The registry says which shape a
 * column has (`cell`); an unavailable value is `—`, never 0; a pending (S8) column is always `—`
 * with its own tooltip; stale data is flagged, never presented as current.
 */
export const PENDING_TOOLTIP = 'Donnée disponible prochainement';

export type CellTone = 'gain' | 'loss' | 'neutral' | 'muted';
export type CellView = {
  text: string;
  tone: CellTone;
  tooltip: string | null;
  /** Price or rate older than the staleness window: shown with a discreet "ancien" marker. */
  stale: boolean;
  /** `—`: nothing to show. */
  unavailable: boolean;
};

const unavailable = (tooltip: string | null = null, tone: CellTone = 'muted'): CellView => ({
  text: UNAVAILABLE,
  tone,
  tooltip,
  stale: false,
  unavailable: true,
});

/** Typed over the shared codes: a new backend reason fails to compile until it is labelled. */
export const REASON_LABELS: Record<TableReason, string> = {
  metrics_missing: 'Données de marché pas encore disponibles',
  price_missing: 'Cours indisponible',
  price_invalid: 'Cours invalide',
  currency_invalid: 'Devise du cours non reconnue',
  fx_missing: 'Taux de change indisponible',
  rounds_to_zero: 'Montant trop petit pour être affiché',
  watchlist: 'Titre sans quantité (liste de suivi)',
  empty_series: 'Aucun historique de cours',
  history_starts_after_target: 'Historique insuffisant sur la période',
  gap_exceeds_tolerance: 'Historique trop lacunaire au début de la période',
  end_missing: 'Cours actuel indisponible',
  end_invalid: 'Cours actuel invalide',
  history_completeness_unknown: 'Complétude de l’historique inconnue',
  history_gap_at_start: 'Historique lacunaire au début de la période',
  insufficient_history: 'Historique insuffisant sur la période',
};
const reasonLabel = (reason: string | null) =>
  reason ? ((REASON_LABELS as Record<string, string>)[reason] ?? 'Donnée indisponible') : null;

/**
 * Raw listing currency, never read as a major one (F-FE1): a minor unit (GBX, GBp, ZAc) or any
 * code that is not a plain ISO code is never given to `Intl` as a currency ("2 000 GBp" must not
 * become "2 000 £"). Minor units read "2 000 pence (GBp)"; unknown codes "12,5 XYZ1".
 * Fraction digits: 2 for tracked values, 2 to 4 for prices (F-FE2). A positive amount that would
 * still round to zero reads "< 0,01 €" ("< 0,0001 €" for prices), never 0.
 */
export function formatMoney(
  amount: string,
  currency: string,
  opts: { price?: boolean } = {},
): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return UNAVAILABLE;
  const maxFrac = opts.price ? 4 : 2;
  const floor = 10 ** -maxFrac;
  const tiny = n > 0 && n < floor / 2;
  const shown = tiny ? floor : n;
  const prefix = tiny ? '< ' : '';
  const normalized = normalizeCurrency(currency);
  if (!/^[A-Z]{3}$/.test(currency) || normalized === null || normalized.isMinorUnit) {
    const text = new Intl.NumberFormat('fr-FR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxFrac,
    }).format(shown);
    const unit = normalized?.isMinorUnit ? `pence (${currency})` : currency;
    return `${prefix}${text}${NBSP}${unit}`;
  }
  try {
    return `${prefix}${new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: maxFrac,
    }).format(shown)}`;
  } catch {
    return `${prefix}${shown}${NBSP}${currency}`;
  }
}

/** Set by the optimistic quantity edit (lib/spaces/set-quantity.ts): the value is being recomputed. */
export const RECALCULATING_REASON = 'recalculating';
export const RECALCULATING_TEXT = '…';

function moneyView(cell: MoneyCell, price: boolean): CellView {
  if (cell.amount === null && cell.reason === RECALCULATING_REASON) {
    return { ...unavailable('Mise à jour en cours'), text: RECALCULATING_TEXT };
  }
  if (cell.amount === null) return unavailable(reasonLabel(cell.reason));
  const parts = [cell.asOf ? `Cours du ${formatNumericDate(cell.asOf)}` : null];
  if (cell.isStale) parts.push('donnée ancienne');
  return {
    text: formatMoney(cell.amount, cell.currency, { price }),
    tone: 'neutral',
    tooltip: parts.filter(Boolean).join(' : ') || null,
    stale: cell.isStale,
    unavailable: false,
  };
}

function perfView(cell: PerfCell): CellView {
  if (cell.value === null) return unavailable(reasonLabel(cell.reason));
  const text = formatSignedPct(cell.value);
  const sign = displayedSign(cell.value, text);
  const base = cell.baseDate ? `Depuis le ${formatNumericDate(cell.baseDate)}` : null;
  return {
    text,
    tone: sign === 1 ? 'gain' : sign === -1 ? 'loss' : 'neutral',
    tooltip: [base, cell.isStale ? 'donnée ancienne' : null].filter(Boolean).join(' : ') || null,
    stale: cell.isStale,
    unavailable: false,
  };
}

/** Specs 34 direction: "1 USD = 0,8807 EUR". EUR is exactly 1 and has no rate date. */
function fxView(cell: FxCell): CellView {
  if (cell.eurPerUnit === null) return unavailable('Taux de change indisponible');
  const tooltip = cell.rateDate ? `Taux du ${formatNumericDate(cell.rateDate)}` : null;
  return {
    text: `1 ${cell.currency} = ${formatRate(cell.eurPerUnit)} EUR`,
    tone: 'neutral',
    tooltip: cell.isStale ? [tooltip, 'taux ancien'].filter(Boolean).join(' : ') : tooltip,
    stale: cell.isStale,
    unavailable: false,
  };
}

export function cellView(def: TableColumnDef, cell: TableCell | undefined): CellView {
  if (def.availability === 'pending_s8') return unavailable(PENDING_TOOLTIP);
  if (cell === null || cell === undefined) return unavailable();
  if (typeof cell === 'object') {
    switch (cell.kind) {
      case 'money':
        return moneyView(cell, def.id === 'price' || def.id === 'price_eur');
      case 'perf':
        return perfView(cell);
      case 'percent':
        return percentView(cell);
      case 'fx':
        return fxView(cell);
    }
  }
  switch (def.cell) {
    case 'date':
      return plain(formatNumericDate(cell));
    case 'decimal':
      return plain(formatQuantity(cell));
    case 'text':
      return cell === ''
        ? unavailable()
        : plain((INSTRUMENT_TYPE_LABELS as Record<string, string>)[cell] ?? cell);
    default:
      // money/perf/percent/fx always arrive as objects; `row` (quantity) has no `values` entry.
      return unavailable();
  }
}

/** Percentage without a period (debt ratio, dividend yield; S8). */
function percentView(cell: PercentCell): CellView {
  if (cell.value === null) return unavailable(reasonLabel(cell.reason));
  return {
    text: formatPct(cell.value),
    tone: 'neutral',
    tooltip: cell.isStale ? 'donnée ancienne' : null,
    stale: cell.isStale,
    unavailable: false,
  };
}

const plain = (text: string): CellView => ({
  text,
  tone: 'neutral',
  tooltip: null,
  stale: false,
  unavailable: text === UNAVAILABLE,
});

/** Header of "Performance période" follows the global period: "Perf. 1 an". */
export const PERF_PERIOD_HEADERS = {
  '1w': 'Perf. 1 sem.',
  '1m': 'Perf. 1 mois',
  '6m': 'Perf. 6 mois',
  '1y': 'Perf. 1 an',
  '5y': 'Perf. 5 ans',
  max: 'Perf. Max',
} as const;

export function columnHeader(
  def: Pick<TableColumnDef, 'id' | 'label' | 'shortLabel'>,
  period: keyof typeof PERF_PERIOD_HEADERS,
): string {
  if ((def.id as TableColumnId) === 'perf_period') return PERF_PERIOD_HEADERS[period];
  return def.shortLabel ?? def.label;
}

/** Why a header cannot be sorted (shown as its tooltip), `null` when it is sortable or plain. */
export function unsortableReason(def: Pick<TableColumnDef, 'id' | 'availability'>): string | null {
  if (def.availability === 'pending_s8') return PENDING_TOOLTIP;
  if (def.id === 'price')
    return 'Tri impossible : cours en devises différentes. Triez par « Cours EUR ».';
  return null;
}

/** Numeric columns are right-aligned (F-FE6), by the registry's semantic type, quantity included. */
export function isRightAligned(def: Pick<TableColumnDef, 'dataType'>): boolean {
  return def.dataType === 'decimal' || def.dataType === 'money' || def.dataType === 'percent';
}
