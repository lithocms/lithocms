import type { ReactNode } from 'react';

/** Settings in two columns: what the section is on the left, its panel on the right. */
export function SettingsRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4 border-b border-rule py-8 last:border-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,700px)] lg:gap-10">
      <div className="lg:pt-2">
        <h2 className="text-section font-medium">{title}</h2>
        {hint && <div className="mt-1 text-sm text-muted">{hint}</div>}
      </div>
      <div className="grid gap-4 rounded-sheet bg-[#fafaf9] p-4">{children}</div>
    </section>
  );
}

export function SaveBar({
  busy,
  state,
  onSave,
  label,
}: {
  busy: boolean;
  state: string;
  onSave: () => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        disabled={busy}
        onClick={onSave}
        className="inline-flex h-8 cursor-pointer items-center rounded-control bg-ink px-3 text-sm font-medium text-white transition-[background-color] hover:bg-[#33332f] disabled:opacity-50"
      >
        {label}
      </button>
      <span aria-live="polite" className="text-[13px] text-muted">
        {state}
      </span>
    </div>
  );
}
