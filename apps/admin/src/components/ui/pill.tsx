import { cn } from '@/lib/utils';

const tones = {
  positive: 'bg-pill-positive text-pill-positive-ink',
  warning: 'bg-pill-warning text-pill-warning-ink',
  neutral: 'bg-pill-neutral text-pill-neutral-ink',
};

export function Pill({
  tone = 'neutral',
  children,
}: {
  tone?: keyof typeof tones;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-full px-2 text-xs font-medium',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}
