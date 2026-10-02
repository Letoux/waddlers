'use client';

import { useMemo } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import {
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
} from '@tanstack/react-table';
import type {
  DashboardPeriod,
  TableColumnDef,
  TablePositionRow,
  TableSort,
} from '@waddlers/contracts';
import { QuantityCell } from '@/components/spaces/quantity-cell';
import { RemovePositionButton } from '@/components/spaces/remove-position-button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cellView, columnHeader, isRightAligned, unsortableReason } from '@/lib/table/cells';
import { isSortable } from '@/lib/table/column-config';
import type { Density } from '@/lib/table/density';
import { cn } from '@/lib/utils';
import { CellContent } from './cell-view';

// Sorting and pagination are done by the server (manual mode): the table only models state.
const features = tableFeatures({ rowSortingFeature, rowPaginationFeature });
type RowColumn = ColumnDef<typeof features, TablePositionRow>;
const NO_ROWS: TablePositionRow[] = [];

const ACTIONS_ID = 'actions';

type GridProps = {
  spaceId: string;
  rows: readonly TablePositionRow[] | undefined;
  columns: readonly TableColumnDef[];
  period: DashboardPeriod;
  sort: TableSort | null;
  onSort: (columnId: TableSort['columnId']) => void;
  canEdit: boolean;
  density: Density;
  onSaved: (message: string) => void;
  onRemoved: () => void;
  /** Total of the whole result, for the table state (pages are computed by the server). */
  total: number;
  pageSize: number;
  pageIndex: number;
};

export function PositionsGrid(props: GridProps) {
  const { spaceId, columns, period, sort, canEdit, density, onSaved, onRemoved } = props;

  const columnDefs = useMemo(() => {
    const defs: RowColumn[] = columns.map((def): RowColumn => ({
      id: def.id,
      accessorFn: (row) => row.values[def.id as keyof TablePositionRow['values']] ?? null,
      enableSorting: isSortable(def),
      header: () => columnHeader(def, period),
      cell: ({ row }) => {
        const original = row.original;
        if (def.id === 'quantity') {
          return (
            <span data-testid="quantity" className="inline-flex justify-end">
              <QuantityCell spaceId={spaceId} row={original} canEdit={canEdit} onSaved={onSaved} />
            </span>
          );
        }
        const view = cellView(def, original.values[def.id as keyof typeof original.values]);
        if (def.id === 'name') {
          return (
            <>
              <span className="font-medium" data-testid="cell-value">
                {view.text}
              </span>
              {original.selectionReason && (
                <span className="sr-only"> ({original.selectionReason})</span>
              )}
            </>
          );
        }
        return (
          <CellContent
            view={view}
            kind={def.cell === 'perf' ? 'perf' : def.cell === 'text' ? 'text' : 'other'}
          />
        );
      },
    }));
    if (canEdit) {
      defs.push({
        id: ACTIONS_ID,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <RemovePositionButton spaceId={spaceId} row={row.original} onRemoved={onRemoved} />
        ),
      });
    }
    return defs;
  }, [columns, period, spaceId, canEdit, onSaved, onRemoved]);

  const table = useTable({
    features,
    columns: columnDefs,
    data: (props.rows as TablePositionRow[] | undefined) ?? NO_ROWS,
    getRowId: (row) => row.id,
    manualSorting: true,
    manualPagination: true,
    rowCount: props.total,
    state: {
      sorting: sort ? [{ id: sort.columnId, desc: sort.direction === 'desc' }] : [],
      pagination: { pageIndex: props.pageIndex, pageSize: props.pageSize },
    },
  });

  const pad = density === 'compact' ? 'px-2 py-1 text-xs' : 'px-3 py-2.5 text-sm';
  const defById = new Map(columns.map((c) => [c.id as string, c]));

  return (
    <TooltipProvider>
      <div
        className="relative min-w-0 max-w-full overflow-x-auto rounded-md border"
        data-testid="table-scroll"
        // Scrollable region: keyboard users can scroll it.
        tabIndex={0}
        role="group"
        aria-label="Tableau des titres, défilement horizontal"
      >
        <table className="w-full min-w-max border-collapse text-left" data-density={density}>
          <caption className="sr-only">Titres de l’espace</caption>
          <thead className="text-xs text-muted-foreground">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id} className="border-b">
                {group.headers.map((header, index) => {
                  const def = defById.get(header.column.id);
                  const sortable = !!def && header.column.getCanSort();
                  const dir = header.column.getIsSorted();
                  const right = !!def && isRightAligned(def);
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        sortable
                          ? dir === 'asc'
                            ? 'ascending'
                            : dir === 'desc'
                              ? 'descending'
                              : 'none'
                          : undefined
                      }
                      className={cn(
                        pad,
                        'font-medium whitespace-nowrap',
                        right && 'text-right',
                        index === 0 && 'sticky left-0 z-10 border-r bg-background',
                      )}
                    >
                      {sortable && def ? (
                        <button
                          type="button"
                          title={def.label}
                          className={cn(
                            '-mx-1 inline-flex items-center gap-1 rounded px-1 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                            dir && 'text-foreground',
                          )}
                          onClick={() => props.onSort(def.id as TableSort['columnId'])}
                        >
                          <table.FlexRender header={header} />
                          {dir === 'asc' ? (
                            <ArrowUp aria-hidden className="size-3" />
                          ) : dir === 'desc' ? (
                            <ArrowDown aria-hidden className="size-3" />
                          ) : (
                            <ArrowUpDown aria-hidden className="size-3 opacity-50" />
                          )}
                        </button>
                      ) : (
                        <span title={(def && unsortableReason(def)) ?? def?.label}>
                          <table.FlexRender header={header} />
                          {def && unsortableReason(def) && (
                            <span className="sr-only"> ({unsortableReason(def)})</span>
                          )}
                        </span>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} data-testid="position-row" className="border-b last:border-b-0">
                {row.getAllCells().map((cell, index) => {
                  const def = defById.get(cell.column.id);
                  // First column = the row header (screen readers announce the company per cell).
                  const Cell = index === 0 ? 'th' : 'td';
                  return (
                    <Cell
                      key={cell.id}
                      scope={index === 0 ? 'row' : undefined}
                      className={cn(
                        pad,
                        'whitespace-nowrap',
                        index === 0 && 'font-normal',
                        def && isRightAligned(def) && 'text-right',
                        cell.column.id === ACTIONS_ID && 'text-right',
                        index === 0 && 'sticky left-0 z-10 border-r bg-background',
                      )}
                    >
                      <table.FlexRender cell={cell} />
                    </Cell>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TooltipProvider>
  );
}
