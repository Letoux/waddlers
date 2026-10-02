'use client';

import type { TableConfigOutput } from '@waddlers/contracts';
import { BlockError } from '@/components/dashboard/block-states';
import { spaceFailureKind } from '@/lib/spaces/errors';
import { useTableConfig } from '@/lib/table/use-table-config';
import { PositionsTableView } from './positions-table-view';
import { SpaceGone, TableSkeleton } from './table-states';

/**
 * Titres table (S6, S7). Loads the user's saved view of the space (`tableConfig.get`, seeded by
 * the server page) and hands it to the view. Search, period, page (and a shared `?tri=`) live in
 * the URL; columns, filters, sort, density and page size come from the saved config (D27).
 */
export function PositionsTable({
  spaceId,
  canEdit,
  initialConfig,
}: {
  spaceId: string;
  canEdit: boolean;
  initialConfig?: TableConfigOutput;
}) {
  const { query, config, update, reset, resetting } = useTableConfig(spaceId, initialConfig);

  if (query.isError && spaceFailureKind(query.error) === 'not_found') return <SpaceGone />;
  if (query.isPending) return <TableSkeleton />;
  if (!config) return <BlockError query={query} testId="table-config-error" />;
  return (
    <PositionsTableView
      spaceId={spaceId}
      canEdit={canEdit}
      config={config}
      update={update}
      reset={reset}
      resetting={resetting}
    />
  );
}
