import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const fieldClass =
  'w-full min-w-0 rounded-control border border-control bg-sheet px-2.5 text-sm text-ink placeholder:text-muted transition-[border-color] hover:border-[#b5b5b0] focus-visible:border-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:opacity-50 aria-invalid:border-negative';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input data-slot="input" className={cn(fieldClass, 'h-9', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClass, 'min-h-20 py-2 leading-normal', className)}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select data-slot="select" className={cn(fieldClass, 'h-9 pr-8', className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label data-slot="label" className={cn('text-sm font-medium text-ink', className)} {...props} />
  );
}

/** A label, its control and an optional hint or error, stacked. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="text-[13px] text-negative" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
