import type { DashboardPeriod } from '@waddlers/contracts';
import { PERIOD_PARAM } from '@/lib/dashboard/period';

export type SpaceSection = 'dashboard' | 'titres';

const SPACE_PATH = /^\/s\/([^/]+)(?:\/(titres))?\/?$/;

/** Space (and sub-page) shown by a pathname, or null outside `/s/[spaceId]/...`. */
export function parseSpacePath(
  pathname: string,
): { spaceId: string; section: SpaceSection } | null {
  const m = SPACE_PATH.exec(pathname);
  if (!m || !m[1]) return null;
  try {
    return {
      spaceId: decodeURIComponent(m[1]),
      section: m[2] === 'titres' ? 'titres' : 'dashboard',
    };
  } catch {
    return null; // malformed percent-encoding (e.g. /s/%E0%A4%A)
  }
}

/** `period` (an already validated `?periode=` value) is carried so the global period survives navigation. */
export function spaceHref(
  spaceId: string,
  section: SpaceSection = 'dashboard',
  period: DashboardPeriod | null = null,
): string {
  const base = `/s/${encodeURIComponent(spaceId)}`;
  const path = section === 'titres' ? `${base}/titres` : base;
  return period ? `${path}?${PERIOD_PARAM}=${period}` : path;
}

/** Where to go when switching space: the same sub-page in the new space, else its dashboard. */
export function switchSpaceHref(
  pathname: string,
  newSpaceId: string,
  period: DashboardPeriod | null = null,
): string {
  return spaceHref(newSpaceId, parseSpacePath(pathname)?.section ?? 'dashboard', period);
}
