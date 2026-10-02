import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { rangeLabel } from '@/lib/table/pagination';

export function PaginationBar({
  page,
  rows,
  total,
  pageSize,
  hasMore,
  busy,
  onPage,
}: {
  page: number;
  rows: number;
  total: number;
  pageSize: number;
  hasMore: boolean;
  busy: boolean;
  onPage: (page: number) => void;
}) {
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground" data-testid="page-range">
        {rangeLabel(page, rows, total, pageSize)}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1 || busy}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft aria-hidden />
          Précédent
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasMore || busy}
          onClick={() => onPage(page + 1)}
        >
          Suivant
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
