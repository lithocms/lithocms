import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// The primary action is near-black; colour stays on data.
const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-control text-sm font-medium transition-[background-color,border-color,color] touch-manipulation disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-ink text-white hover:bg-[#33332f]',
        secondary: 'bg-active text-ink hover:bg-[#dededa]',
        outline: 'border border-control bg-sheet text-ink hover:bg-raised',
        ghost: 'text-ink hover:bg-active',
        danger: 'text-negative hover:bg-[#ffedea]',
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 px-2.5 text-[13px]',
        icon: 'size-8',
        'icon-sm': 'size-7',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = 'button',
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      data-slot="button"
      type={asChild ? undefined : type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
