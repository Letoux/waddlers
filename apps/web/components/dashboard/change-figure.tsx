import { TrendingDown, TrendingUp } from 'lucide-react';
import { displayedSign } from '@/lib/dashboard/format';
import { cn } from '@/lib/utils';

/**
 * A signed figure that never relies on colour alone: the text carries the sign (+ / -) and an
 * icon carries the direction. Unavailable values (`text` is "—") and values that round to zero are neutral: the sign
 * is derived from the displayed text, never from the unrounded value.
 */
export function ChangeFigure({
  raw,
  text,
  className,
  testId,
}: {
  raw: string | null | undefined;
  text: string;
  className?: string;
  testId?: string;
}) {
  const sign = displayedSign(raw, text);
  const Icon = sign === 1 ? TrendingUp : sign === -1 ? TrendingDown : null;
  return (
    <span
      data-testid={testId}
      data-sign={sign ?? 'none'}
      className={cn(
        'inline-flex items-center gap-1 font-medium tabular-nums',
        sign === 1 && 'text-gain',
        sign === -1 && 'text-loss',
        className,
      )}
    >
      {Icon && <Icon aria-hidden className="size-4 shrink-0" />}
      {text}
    </span>
  );
}
