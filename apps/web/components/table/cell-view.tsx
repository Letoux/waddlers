import { TrendingDown, TrendingUp } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { CellView } from '@/lib/table/cells';
import { cn } from '@/lib/utils';

/**
 * Renders a `CellView`. Colour never stands alone: the sign is in the text and gain/loss also
 * carry an arrow. The tooltip text is repeated as screen-reader text so it is not mouse-only.
 */
export function CellContent({ view, kind }: { view: CellView; kind: 'text' | 'perf' | 'other' }) {
  const Icon =
    kind === 'perf'
      ? view.tone === 'gain'
        ? TrendingUp
        : view.tone === 'loss'
          ? TrendingDown
          : null
      : null;
  const body = (
    <span
      className={cn(
        'inline-flex items-center gap-1',
        view.tone === 'gain' && 'font-medium text-gain',
        view.tone === 'loss' && 'font-medium text-loss',
        view.tone === 'muted' && 'text-muted-foreground',
      )}
      data-stale={view.stale ? 'true' : undefined}
    >
      {Icon && <Icon aria-hidden className="size-3.5 shrink-0" />}
      <span className="tabular-nums" data-testid="cell-value">
        {view.text}
      </span>
      {view.stale && (
        <span
          className="rounded-sm border px-1 text-[10px] font-normal text-muted-foreground"
          data-testid="stale-marker"
        >
          ancien
        </span>
      )}
      {view.tooltip && <span className="sr-only"> ({view.tooltip})</span>}
    </span>
  );
  if (!view.tooltip) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent>{view.tooltip}</TooltipContent>
    </Tooltip>
  );
}
