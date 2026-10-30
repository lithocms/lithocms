import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { useI18n, useLabel } from '@/lib/i18n';
import type { FieldDef, FormField, Label } from '@/lib/types';

interface FieldLike {
  key: string;
  label: Label;
  type: FieldDef['type'] | FormField['type'];
  required?: boolean;
  options?: { value: string; label?: Label }[];
}

const TR: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' };

/**
 * A key as it is being typed: lowercase ASCII, anything else becomes `sep`. The separator a
 * person just typed stays, so "test başvuru" can be typed letter by letter.
 */
export function typedKey(value: string, sep: '_' | '-'): string {
  return value
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşü]/g, (c) => TR[c]!)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, sep)
    .replace(/^[-_]+/, '')
    .slice(0, 60);
}

/** A finished key from a label: "Şube adı" → `sube_adi`. */
export function toKey(label: string, prefix = 'field', sep: '_' | '-' = '_'): string {
  const key = typedKey(label, sep).replace(/[-_]+$/, '');
  return /^[a-z]/.test(key) ? key : key ? `${prefix}${sep}${key}` : '';
}

/** Comma-separated choices; the text is kept as typed so spaces and commas can be entered. */
function OptionsInput({
  options,
  placeholder,
  onChange,
}: {
  options: { value: string }[];
  placeholder: string;
  onChange: (options: { value: string }[]) => void;
}) {
  const [text, setText] = useState(() => options.map((o) => o.value).join(', '));
  return (
    <Input
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(
          e.target.value
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
            .map((value) => ({ value })),
        );
      }}
    />
  );
}

/**
 * Edits a flat list of typed fields (a form's inputs, a collection's columns). The key follows
 * the label until it is edited by hand; keys are what themes and submissions refer to.
 */
export function FieldListEditor<F extends FieldLike>({
  fields,
  types,
  onChange,
  errorFor,
}: {
  fields: F[];
  types: readonly F['type'][];
  onChange: (fields: F[]) => void;
  /** Validation message for a field, by index. */
  errorFor?: (index: number) => string | undefined;
}) {
  const { t, locale } = useI18n();
  const l = useLabel();
  const set = (i: number, patch: Partial<FieldLike>) =>
    onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, by: number) => {
    const next = [...fields];
    const [f] = next.splice(i, 1);
    next.splice(i + by, 0, f!);
    onChange(next);
  };

  return (
    <div className="grid gap-2">
      {fields.map((f, i) => {
        const label = l(f.label);
        // A choice field without choices fails as "array too small"; say what to do.
        const error =
          errorFor?.(i) &&
          (f.type === 'select' && !f.options?.length ? t('fields.needOptions') : errorFor(i));
        return (
          <div
            key={i}
            className="grid gap-2 rounded-card border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_9rem_auto] sm:items-end"
          >
            <label className="grid gap-1 text-[13px] text-muted">
              {t('fields.label')}
              <Input
                value={label}
                required
                onChange={(e) => {
                  const next = e.target.value;
                  set(i, {
                    label: typeof f.label === 'string' ? next : { ...f.label, [locale]: next },
                    // The key follows the label until it has been changed by hand.
                    ...(f.key === toKey(label) || f.key === '' ? { key: toKey(next) } : {}),
                  });
                }}
              />
            </label>
            <label className="grid gap-1 text-[13px] text-muted">
              {t('fields.key')}
              <Input
                value={f.key}
                spellCheck={false}
                autoComplete="off"
                translate="no"
                className="font-mono text-[13px]"
                onChange={(e) => set(i, { key: typedKey(e.target.value, '_') })}
              />
            </label>
            <label className="grid gap-1 text-[13px] text-muted">
              {t('fields.type')}
              <Select
                value={f.type}
                onChange={(e) => {
                  const type = e.target.value as F['type'];
                  set(i, {
                    type,
                    options: type === 'select' ? (f.options ?? []) : undefined,
                  });
                }}
              >
                {types.map((type) => (
                  <option key={type} value={type}>
                    {t(`fieldType.${type}`)}
                  </option>
                ))}
              </Select>
            </label>
            <span className="flex h-9 items-center gap-1">
              <label className="mr-1 flex cursor-pointer items-center gap-1.5 text-[13px]">
                <input
                  type="checkbox"
                  className="size-4 accent-ink"
                  checked={f.required ?? false}
                  onChange={(e) => set(i, { required: e.target.checked })}
                />
                {t('fields.required')}
              </label>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('common.moveUp')}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('common.moveDown')}
                disabled={i === fields.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                size="icon-sm"
                variant="danger"
                aria-label={t('fields.removeName', { name: label || f.key })}
                onClick={() => onChange(fields.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </span>
            {f.type === 'select' && (
              <label className="grid gap-1 text-[13px] text-muted sm:col-span-4">
                {t('fields.options')}
                <OptionsInput
                  // Rows are matched by position; remount when this one moves.
                  key={`${i}:${f.key}`}
                  options={f.options ?? []}
                  placeholder={t('fields.optionsHint')}
                  onChange={(options) => set(i, { options })}
                />
              </label>
            )}
            {error && (
              <p role="alert" className="text-[13px] text-negative sm:col-span-4">
                {error}
              </p>
            )}
          </div>
        );
      })}
      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onChange([...fields, { key: '', label: '', type: types[0] } as F])}
        >
          <Plus aria-hidden="true" />
          {t('fields.add')}
        </Button>
      </div>
    </div>
  );
}
