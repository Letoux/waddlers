'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { AlertCircle } from 'lucide-react';
import type { DashboardPeriod, TableColumnId, TableSort } from '@waddlers/contracts';
import { BlockError, EMPTY_SPACE_MESSAGE } from '@/components/dashboard/block-states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PERIOD_PARAM, resolvePeriod, withPeriodSearch } from '@/lib/dashboard/period';
import { spaceFailureKind } from '@/lib/spaces/errors';
import { resolveVisibleColumns } from '@/lib/table/column-config';
import { useDensity } from '@/lib/table/density';
import { lastPage, noMatchMessage } from '@/lib/table/pagination';
import { useTablePositions } from '@/lib/table/use-table-positions';
import {
  applyTableUrlPatch,
  nextSort,
  PAGE_SIZE,
  parseTableUrlState,
  type TableUrlPatch,
} from '@/lib/table/url-state';
import { PaginationBar } from './pagination-bar';
import { PositionsGrid } from './positions-grid';
import { TableToolbar } from './table-toolbar';

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Titres table (S6). Sort, search, page and period live in the URL (`?tri=`, `?q=`, `?page=`,
 * `?periode=`; replaceState, no history entry, like the dashboard period) and drive one
 * server-side `positions.list` query. The previous page stays on screen while the next loads.
 */
export function PositionsTable({ spaceId, canEdit }: { spaceId: string; canEdit: boolean }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const url = parseTableUrlState(searchParams);
  const period = resolvePeriod(searchParams.get(PERIOD_PARAM));
  const [density, setDensity] = useDensity();
  const [announcement, setAnnouncement] = useState('');
  const regionRef = useRef<HTMLDivElement>(null);
  const focusRegion = useCallback(() => regionRef.current?.focus(), []);

  const columns = useMemo(() => resolveVisibleColumns(), []);
  const columnIds = useMemo(() => columns.map((c) => c.id as TableColumnId), [columns]);

  const update = useCallback(
    (patch: TableUrlPatch, resetPage = false) => {
      const search = applyTableUrlPatch(window.location.search, patch, resetPage);
      window.history.replaceState(null, '', `${pathname}${search}`);
    },
    [pathname],
  );

  // Search: the field is local state; the URL (hence the query) follows 300 ms after typing stops.
  const [searchInput, setSearchInput] = useState(url.q);
  const urlQ = useRef(url.q);
  urlQ.current = url.q;
  const pushedQ = useRef(url.q);
  useEffect(() => {
    if (searchInput === urlQ.current) return;
    const timer = setTimeout(() => {
      pushedQ.current = searchInput;
      update({ q: searchInput });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput, update]);
  // An external URL change (nav link without `?q=`, back/forward) resets the field (F-FE4); the
  // echo of our own debounced update is ignored so it can never overwrite what is being typed.
  useEffect(() => {
    if (url.q === pushedQ.current) return;
    pushedQ.current = url.q;
    setSearchInput(url.q);
  }, [url.q]);

  const setPeriod = (next: DashboardPeriod) => {
    const search = withPeriodSearch(applyTableUrlPatch(window.location.search, {}, true), next);
    window.history.replaceState(null, '', `${pathname}${search}`);
  };
  const onSort = (columnId: TableSort['columnId']) =>
    update({ sort: nextSort(url.sort, columnId) });

  const query = useTablePositions({
    spaceId,
    period,
    search: url.q,
    sort: url.sort,
    page: url.page,
    columns: columnIds,
  });
  const { data } = query;

  // The page no longer exists (last row of the last page removed, hand-written URL): go back.
  useEffect(() => {
    if (data && !query.isPlaceholderData && data.rows.length === 0 && data.total > 0) {
      update({ page: lastPage(data.total) });
    }
  }, [data, query.isPlaceholderData, update]);

  const gone = query.isError && spaceFailureKind(query.error) === 'not_found';
  const stale = query.isError && !gone && !!data;
  const emptySpace = !!data && data.total === 0 && url.q.trim() === '';

  let content;
  if (gone) {
    content = (
      <div className="grid max-w-md gap-4">
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Espace indisponible</AlertTitle>
          <AlertDescription>Cet espace n’est plus disponible.</AlertDescription>
        </Alert>
        <Button asChild variant="outline" className="w-fit">
          <Link href="/espaces">Voir mes espaces</Link>
        </Button>
      </div>
    );
  } else if (query.isPending) {
    content = (
      <div className="grid gap-2" role="status" aria-label="Chargement des titres">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  } else if (query.isError && !data) {
    content = <BlockError query={query} testId="table-error" />;
  } else if (data && emptySpace) {
    content = (
      <p className="text-muted-foreground" data-testid="empty-space">
        {EMPTY_SPACE_MESSAGE}
      </p>
    );
  } else if (data) {
    content = (
      <div className="grid min-w-0 grid-cols-1 gap-3">
        {data.rows.length === 0 && url.q.trim() !== '' ? (
          <p className="py-6 text-muted-foreground" data-testid="no-match">
            {noMatchMessage(url.q)}
          </p>
        ) : (
          <PositionsGrid
            spaceId={spaceId}
            rows={data.rows}
            columns={columns}
            period={period}
            sort={url.sort}
            onSort={onSort}
            canEdit={canEdit}
            density={density}
            onSaved={setAnnouncement}
            onRemoved={focusRegion}
            total={data.total}
            pageSize={PAGE_SIZE}
            pageIndex={url.page - 1}
          />
        )}
        <PaginationBar
          page={url.page}
          rows={data.rows.length}
          total={data.total}
          hasMore={data.hasMore}
          busy={query.isPlaceholderData}
          onPage={(page) => update({ page })}
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
  const toolbar = showToolbar && (
    <TableToolbar
      search={searchInput}
      onSearch={setSearchInput}
      period={period}
      onPeriod={setPeriod}
      density={density}
      onDensity={setDensity}
      total={data?.total ?? null}
    />
  );

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
      {toolbar}
      <div className={query.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
        {content}
      </div>
    </div>
  );
}
