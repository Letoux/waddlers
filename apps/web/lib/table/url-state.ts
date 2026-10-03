import {
  POSITIONS_SEARCH_MAX,
  isStorableText,
  tableSortSchema,
  type TableSort,
} from '@waddlers/contracts';

/**
 * Table state kept in the URL (specs 20, 22): `?q=` search, `?tri=<column>:<asc|desc>` sort,
 * `?page=` (1-based). The period is `?periode=` (lib/dashboard/period.ts). Everything coming from
 * the URL is untrusted: the sort is validated against the contract whitelist, the page is a
 * bounded positive integer, the search is cut at the contract maximum.
 */
export const SEARCH_PARAM = 'q';
export const SORT_PARAM = 'tri';
export const PAGE_PARAM = 'page';
/** Default page size (the saved config's `pageSize` overrides it). */
export const PAGE_SIZE = 50;
/** Far beyond any real space; keeps a hand-written offset small. */
const MAX_PAGE = 10_000;

export type TableUrlState = { q: string; sort: TableSort | null; page: number };
type Params = { get(name: string): string | null };

export function parseSortParam(raw: string | null | undefined): TableSort | null {
  if (typeof raw !== 'string') return null;
  const at = raw.lastIndexOf(':');
  if (at <= 0) return null;
  const parsed = tableSortSchema.safeParse({
    columnId: raw.slice(0, at),
    direction: raw.slice(at + 1),
  });
  return parsed.success ? parsed.data : null;
}

export const serializeSort = (sort: TableSort) => `${sort.columnId}:${sort.direction}`;

export function parsePageParam(raw: string | null | undefined): number {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,4}$/.test(raw)) return 1;
  return Math.min(Number(raw), MAX_PAGE);
}

/**
 * Search text from the URL: NUL removed (refused by the API), cut at the maximum length WITHOUT
 * splitting a surrogate pair (a lone high surrogate at the cut is dropped: the API refuses it), and
 * ignored altogether when it is still not storable (audit P3-3).
 */
export function sanitizeSearch(raw: string | null | undefined): string {
  let text = (raw ?? '').replaceAll('\u0000', '').slice(0, POSITIONS_SEARCH_MAX);
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  return isStorableText(text) ? text : '';
}

export function parseTableUrlState(params: Params): TableUrlState {
  return {
    q: sanitizeSearch(params.get(SEARCH_PARAM)),
    sort: parseSortParam(params.get(SORT_PARAM)),
    page: parsePageParam(params.get(PAGE_PARAM)),
  };
}

/** What `positions.list` receives: a blank search is no search. */
export const searchForApi = (q: string): string | undefined => q.trim() || undefined;

export const pageOffset = (page: number, pageSize: number = PAGE_SIZE) => (page - 1) * pageSize;

/** Click on a sortable header: none -> asc -> desc -> none; another column starts at asc. */
export function nextSort(current: TableSort | null, columnId: TableSort['columnId']) {
  if (!current || current.columnId !== columnId) return { columnId, direction: 'asc' } as const;
  return current.direction === 'asc' ? ({ columnId, direction: 'desc' } as const) : null;
}

export type TableUrlPatch = Partial<{ q: string; sort: TableSort | null; page: number }>;

/**
 * `search` (e.g. `window.location.search`) with the patch applied; other parameters (`periode`)
 * are kept. Defaults are omitted. A change of search or sort drops the page (back to the first);
 * `extraResetPage` is for a period change.
 */
export function applyTableUrlPatch(
  search: string,
  patch: TableUrlPatch,
  extraResetPage = false,
): string {
  const params = new URLSearchParams(search);
  if (patch.q !== undefined) {
    if (patch.q.trim()) params.set(SEARCH_PARAM, patch.q);
    else params.delete(SEARCH_PARAM);
  }
  if (patch.sort !== undefined) {
    if (patch.sort) params.set(SORT_PARAM, serializeSort(patch.sort));
    else params.delete(SORT_PARAM);
  }
  if (patch.page !== undefined && patch.page > 1) params.set(PAGE_PARAM, String(patch.page));
  else if (patch.page !== undefined || extraResetPage || 'q' in patch || 'sort' in patch) {
    params.delete(PAGE_PARAM);
  }
  const out = params.toString();
  return out ? `?${out}` : '';
}
