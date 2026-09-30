export type SpaceSection = 'dashboard' | 'titres';

const SPACE_PATH = /^\/s\/([^/]+)(?:\/(titres))?\/?$/;

/** Space (and sub-page) shown by a pathname, or null outside `/s/[spaceId]/...`. */
export function parseSpacePath(
  pathname: string,
): { spaceId: string; section: SpaceSection } | null {
  const m = SPACE_PATH.exec(pathname);
  if (!m || !m[1]) return null;
  return { spaceId: decodeURIComponent(m[1]), section: m[2] === 'titres' ? 'titres' : 'dashboard' };
}

export function spaceHref(spaceId: string, section: SpaceSection = 'dashboard'): string {
  const base = `/s/${encodeURIComponent(spaceId)}`;
  return section === 'titres' ? `${base}/titres` : base;
}

/** Where to go when switching space: the same sub-page in the new space, else its dashboard. */
export function switchSpaceHref(pathname: string, newSpaceId: string): string {
  return spaceHref(newSpaceId, parseSpacePath(pathname)?.section ?? 'dashboard');
}
