import { z } from 'zod';

/**
 * `positions.facets` (S7): the choices offered by the `in` filters (specs 21), with counts, over
 * ALL the positions of the space. They deliberately ignore the current search and filters: the
 * choice list must not shrink as the user ticks boxes (multi-select), and it stays one cheap query.
 * `value` is what an `in` filter expects (`stock|etf`, the stored sector, the RAW currency, the
 * MIC); `label` is for display (French type label, exchange name, otherwise the value). A `null`
 * sector (ETF, or unknown) is not a facet value: it can never be filtered on (specs 24).
 */
export const FACET_VALUES_MAX = 200;

export const facetValueSchema = z.object({
  value: z.string(),
  label: z.string(),
  count: z.number().int().min(1),
});
export type FacetValue = z.infer<typeof facetValueSchema>;

export const positionsFacetsInputSchema = z.object({ spaceId: z.uuid() });

export const positionsFacetsOutputSchema = z.object({
  instrument_type: z.array(facetValueSchema),
  sector: z.array(facetValueSchema),
  currency: z.array(facetValueSchema),
  exchange: z.array(facetValueSchema),
});
export type PositionsFacetsOutput = z.infer<typeof positionsFacetsOutputSchema>;
