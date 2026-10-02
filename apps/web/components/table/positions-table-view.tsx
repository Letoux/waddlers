'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import type { DashboardPeriod, Filter, TableConfigV1, TableSort } from '@waddlers/contracts';
import { BlockError, EMPTY_SPACE_MESSAGE } from '@/components/dashboard/block-states';
import { Button } from '@/components/ui/button';
import { PERIOD_PARAM, resolvePeriod, withPeriodSearch } from '@/lib/dashboard/period';
import { spaceFailureKind } from '@/lib/spaces/errors';
import { resolveVisibleColumns } from '@/lib/table/column-config';
import {
  configDensity,
  configFilters,
  configPageSize,
  effectiveSort,
  visibleColumnIds,
  withDensity,
  withFilters,
  withPageSize,
  withSort,
  type Density,
  type PageSize,
} from '@/lib/table/config-state';
import { lastPage, noResultsMessage } from '@/lib/table/pagination';
import { usePositionsFacets } from '@/lib/table/use-facets';
import { useSearchInput } from '@/lib/table/use-search-input';
import { useTablePositions } from '@/lib/table/use-table-positions';
import {
  applyTableUrlPatch,
  nextSort,
  parseTableUrlState,
  type TableUrlPatch,
} from '@/lib/table/url-state';
import { ColumnChooser } from './column-chooser';
import { FilterChips } from './filter-chips';
import { FiltersPanel } from './filters-panel';
import { PaginationBar } from './pagination-bar';
import { PositionsGrid } from './positions-grid';
import { SpaceGone, TableSkeleton } from './table-states';
import { TableToolbar } from './table-toolbar';

type Props = {
  spaceId: string;
  canEdit: boolean;
  config: TableConfigV1;
  update: (edit: (config: TableConfigV1) => TableConfigV1) => void;
  reset: () => void;
  resetting: boolean;
};

export function PositionsTableView({ spaceId, canEdit, config, update, reset, resetting }: Props) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const url = parseTableUrlState(searchParams);
  const period = resolvePeriod(searchParams.get(PERIOD_PARAM));
  const [announcement, setAnnouncement] = useState('');
  const regionRef = useRef<HTMLDivElement>(null);
  const focusRegion = useCallback(() => regionRef.current?.focus(), []);

  // Depends on `config.columns` only: a filter or sort edit keeps the same array.
  const columnIds = useMemo(() => visibleColumnIds(config), [config.columns]);
  const columns = useMemo(() => resolveVisibleColumns(columnIds), [columnIds]);
  const filters = configFilters(config);
  const pageSize = configPageSize(config);
  const density = configDensity(config);
  // A shared `?tri=` wins over the saved sort; a click on a header writes both (config-state.ts).
  const sort = effectiveSort(config, url.sort);

  const setUrl = useCallback(
    (patch: TableUrlPatch, resetPage = false) => {
      const search = applyTableUrlPatch(window.location.search, patch, resetPage);
      window.history.replaceState(null, '', `${pathname}${search}`);
    },
    [pathname],
  );
  const pushSearch = useCallback((q: string) => setUrl({ q }), [setUrl]);
  const [searchInput, setSearchInput] = useSearchInput(url.q, pushSearch);

  const setPeriod = (next: DashboardPeriod) => {
    const search = withPeriodSearch(applyTableUrlPatch(window.location.search, {}, true), next);
    window.history.replaceState(null, '', `${pathname}${search}`);
  };
  const onSort = (columnId: TableSort['columnId']) => {
    const next = nextSort(sort, columnId);
    update((c) => withSort(c, next));
    setUrl({ sort: next });
  };
  const setFilters = (next: readonly Filter[]) => {
    update((c) => withFilters(c, next));
    setUrl({ page: 1 });
  };
  const onPageSize = (size: PageSize) => {
    update((c) => withPageSize(c, size));
    setUrl({ page: 1 });
  };
  const onDensity = (next: Density) => update((c) => withDensity(c, next));
  const onReset = () => {
    reset();
    setUrl({ sort: null, page: 1 });
  };

  const facets = usePositionsFacets(spaceId);
  const query = useTablePositions({
    spaceId,
    period,
    search: url.q,
    sort,
    page: url.page,
    columns: columnIds,
    filters,
    pageSize,
  });
  const { data } = query;

  // The page no longer exists (last row removed, filter narrowed, hand-written URL): go back.
  useEffect(() => {
    if (data && !query.isPlaceholderData && data.rows.length === 0 && data.total > 0) {
      setUrl({ page: lastPage(data.total, pageSize) });
    }
  }, [data, query.isPlaceholderData, setUrl, pageSize]);

  const gone = query.isError && spaceFailureKind(query.error) === 'not_found';
  const stale = query.isError && !gone && !!data;
  const hasFilters = filters.length > 0;
  const emptySpace = !!data && data.total === 0 && url.q.trim() === '' && !hasFilters;

  let content;
  if (gone) content = <SpaceGone />;
  else if (query.isPending) content = <TableSkeleton />;
  else if (query.isError && !data) content = <BlockError query={query} testId="table-error" />;
  else if (data && emptySpace) {
    content = (
      <p className="text-muted-foreground" data-testid="empty-space">
        {EMPTY_SPACE_MESSAGE}
      </p>
    );
  } else if (data) {
    content = (
      <div className="grid min-w-0 grid-cols-1 gap-3">
        {data.rows.length === 0 && (url.q.trim() !== '' || hasFilters) ? (
          <p className="py-6 text-muted-foreground" data-testid="no-match">
            {noResultsMessage(url.q, hasFilters)}
          </p>
        ) : (
          <PositionsGrid
            spaceId={spaceId}
            rows={data.rows}
            columns={columns}
            period={period}
            sort={sort}
            onSort={onSort}
            canEdit={canEdit}
            density={density}
            onSaved={setAnnouncement}
            onRemoved={focusRegion}
            total={data.total}
            pageSize={pageSize}
            pageIndex={url.page - 1}
          />
        )}
        <PaginationBar
          page={url.page}
          rows={data.rows.length}
          total={data.total}
          pageSize={pageSize}
          hasMore={data.hasMore}
          busy={query.isPlaceholderData}
          onPage={(page) => setUrl({ page })}
        />
        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            Lecture seule : vous êtes lecteur de cet espace.
          </p>
        )}
      </div>
    );
  }

  const showToolbar = (!!data && !emptySpace && !gone) || (query.isError && !data && !gone);
  return (
    <div
      ref={regionRef}
      role="region"
      tabIndex={-1}
      className="grid min-w-0 grid-cols-1 gap-3 outline-none"
      aria-label="Liste des titres"
      aria-busy={query.isPlaceholderData}
    >
      <div role="status" aria-live="polite" className="sr-only" data-testid="save-status">
        {announcement}
      </div>
      {stale && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm text-muted-foreground"
        >
          <span>Données non actualisées.</span>
          <Button
            variant="outline"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Réessayer
          </Button>
        </div>
      )}
      {showToolbar && (
        <TableToolbar
          search={searchInput}
          onSearch={setSearchInput}
          period={period}
          onPeriod={setPeriod}
          density={density}
          onDensity={onDensity}
          pageSize={pageSize}
          onPageSize={onPageSize}
          total={data?.total ?? null}
          panels={
            <>
              <ColumnChooser
                config={config}
                onChange={update}
                onReset={onReset}
                resetting={resetting}
              />
              <FiltersPanel
                filters={filters}
                period={period}
                facets={{
                  data: facets.data,
                  isPending: facets.isPending,
                  isError: facets.isError,
                  refetch: () => void facets.refetch(),
                }}
                onChange={setFilters}
              />
            </>
          }
        />
      )}
      <FilterChips
        filters={filters}
        facets={facets.data}
        period={period}
        onRemove={(columnId) => setFilters(filters.filter((f) => f.columnId !== columnId))}
        onClear={() => setFilters([])}
      />
      <div className={query.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
        {content}
      </div>
    </div>
  );
}
