import { PAGE_SIZE } from './url-state';

const fr = (n: number) => n.toLocaleString('fr-FR');

/** "1–50 sur 5 000" (en dash); `rows` = rows of the current page. Empty result: "0 sur 0". */
export function rangeLabel(page: number, rows: number, total: number): string {
  if (total === 0 || rows === 0) return `0 sur ${fr(total)}`;
  const from = (page - 1) * PAGE_SIZE + 1;
  return `${fr(from)}–${fr(from + rows - 1)} sur ${fr(total)}`;
}

export const lastPage = (total: number) => Math.max(1, Math.ceil(total / PAGE_SIZE));

/** "1 titre", "2 titres", "5 000 titres". */
export const countLabel = (total: number) => `${fr(total)} titre${total > 1 ? 's' : ''}`;

export const noMatchMessage = (q: string) => `Aucun titre ne correspond à « ${q.trim()} ».`;
