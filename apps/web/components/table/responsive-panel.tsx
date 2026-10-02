'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useMediaQuery } from '@/lib/use-media-query';

/**
 * A toolbar button opening a panel: a popover from `sm` up, a bottom sheet on a phone (375 px).
 * Both are Radix dialogs: Escape closes, focus is trapped/returned to the button.
 */
export function ResponsivePanel({
  label,
  title,
  description,
  badge,
  testId,
  children,
}: {
  label: string;
  title: string;
  description: string;
  /** Short text after the label, e.g. the number of active filters. */
  badge?: string | undefined;
  testId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wide = useMediaQuery('(min-width: 640px)');
  const trigger = (
    <Button type="button" variant="outline" size="sm" data-testid={testId}>
      {label}
      {badge ? <span className="text-muted-foreground">({badge})</span> : null}
    </Button>
  );

  if (!wide) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">{children}</div>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={title}
        className="max-h-[min(34rem,80dvh)] w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <p className="mb-3 text-sm text-muted-foreground">{description}</p>
        {children}
      </PopoverContent>
    </Popover>
  );
}
