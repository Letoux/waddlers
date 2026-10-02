import { PAGE_SIZE } from './url-state';

const fr = (n: number) => n.toLocaleString('fr-FR');

/** "1–50 sur 5 000" (en dash); `rows` = rows of the current page. Empty result: "0 sur 0". */
export function rangeLabel(
  page: number,
  rows: number,
  total: number,
  pageSize: number = PAGE_SIZE,
): string {
  if (total === 0 || rows === 0) return `0 sur ${fr(total)}`;
  const from = (page - 1) * pageSize + 1;
  return `${fr(from)}–${fr(from + rows - 1)} sur ${fr(total)}`;
}

export const lastPage = (total: number, pageSize: number = PAGE_SIZE) =>
  Math.max(1, Math.ceil(total / pageSize));

/** "1 titre", "2 titres", "5 000 titres". */
export const countLabel = (total: number) => `${fr(total)} titre${total > 1 ? 's' : ''}`;

export const noMatchMessage = (q: string) => `Aucun titre ne correspond à « ${q.trim()} ».`;

/** Empty result of a search and/or active filters (never the "empty space" message). */
export function noResultsMessage(q: string, hasFilters: boolean): string {
  const hasSearch = q.trim() !== '';
  if (hasSearch && hasFilters) return `Aucun résultat pour « ${q.trim()} » avec ces filtres.`;
  return hasSearch ? noMatchMessage(q) : 'Aucun résultat pour ces filtres.';
}
