import type { PositionsListOutput } from '@waddlers/contracts';

/**
 * Single place that knows how the API flags a cut list: `hasMore` (formerly `truncated`),
 * i.e. `offset + rows.length < total`. The position count of a space shown
 * elsewhere comes from `spaces.list`'s `positionCount`, never from `total`.
 */
export function isTruncated(result: PositionsListOutput): boolean {
  return result.hasMore;
}
