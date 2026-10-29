import { Dialog as DialogPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  title,
  closeLabel,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  title: string;
  closeLabel: string;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/25" />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_1fr] overflow-hidden overscroll-contain rounded-card border border-border bg-sheet shadow-[0_8px_24px_rgb(0_0_0/0.08)]',
          className,
        )}
        {...props}
      >
        <div className="flex h-12 items-center justify-between border-b border-rule pr-2 pl-4">
          <DialogPrimitive.Title className="text-section font-semibold">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Close
            aria-label={closeLabel}
            className="grid size-8 cursor-pointer place-items-center rounded-control text-muted hover:bg-active hover:text-ink"
          >
            <X className="size-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        </div>
        <div className="overflow-y-auto overscroll-contain">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
