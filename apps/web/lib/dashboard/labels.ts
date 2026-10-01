import type { DashboardPeriod, DashboardSummaryOutput } from '@waddlers/contracts';
import { formatLongDate } from './format';

type MissingReason = DashboardSummaryOutput['missing'][number]['reason'];

/** Why a position is not in the total (D5), in plain French. Raw codes are never shown. */
export const MISSING_REASON_LABELS: Record<MissingReason, string> = {
  price_missing: 'cours indisponible',
  price_invalid: 'cours invalide',
  fx_missing: 'taux de change indisponible',
  currency_invalid: 'devise non reconnue',
  quantity_invalid: 'quantité invalide',
};

export function missingReasonLabel(reason: string): string {
  return (MISSING_REASON_LABELS as Record<string, string>)[reason] ?? 'donnée indisponible';
}

/** "A", "A et B", "A, B et C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} et ${names[names.length - 1]}`;
}

/** Typed 429 of the dashboard caps: `data.retryAfterSeconds`; the server message is never shown. */
export function retryAfterSeconds(error: unknown): number | null {
  const data = (error as { data?: unknown } | null)?.data;
  const v =
    typeof data === 'object' && data !== null
      ? (data as { retryAfterSeconds?: unknown }).retryAfterSeconds
      : null;
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.ceil(v) : null;
}

export function rateLimitedMessage(error: unknown): string {
  const s = retryAfterSeconds(error);
  return s === null
    ? 'Trop de requêtes en peu de temps. Réessayez dans quelques secondes.'
    : `Trop de requêtes en peu de temps. Réessayez dans ${s} seconde${s > 1 ? 's' : ''}.`;
}

export type LeadingNotice =
  { kind: 'short'; text: string } | { kind: 'long'; text: string; names: string[] };

/**
 * D20 notice (positions whose stored history starts after the period start, so the series starts
 * later). It is stored price history, not the listing's creation date: never say "création".
 * Long form (more than 3 names, or `max`, where it is expected): the date from which the whole
 * set has history, the count, and the names left to a disclosure. `baseDate` = the headline's.
 */
export function leadingMissingNotice(
  names: string[],
  baseDate: string | null,
  period: DashboardPeriod,
): LeadingNotice | null {
  if (names.length === 0) return null;
  if (names.length <= 3 && period !== 'max') {
    return {
      kind: 'short',
      text: `Pas de donnée avant le début de l’historique disponible de ${joinNames(names)}.`,
    };
  }
  const since = baseDate ? ` depuis le ${formatLongDate(baseDate)}` : '';
  const count = `${names.length} titre${names.length > 1 ? 's' : ''} sans historique plus ancien`;
  return {
    kind: 'long',
    text: `Historique complet disponible${since} pour l’ensemble des positions — ${count}.`,
    names,
  };
}
