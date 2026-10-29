import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { ImageField } from '@/components/media-picker';
import { RichText } from '@/components/rich-text';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useI18n, useLabel } from '@/lib/i18n';
import type { Section, SectionSchema, Setting } from '@/lib/types';
import { plain } from '@/lib/utils';

// Forms generated from theme schemas (theme.json settings, `{% schema %}` blocks) and from
// collection field definitions. One input per declared type.

export type Values = Record<string, unknown>;

export function SettingInput({
  setting,
  value,
  onChange,
  error,
}: {
  setting: Setting;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string;
}) {
  const l = useLabel();
  const id = useId();
  const text = plain(value);
  const placeholder = typeof setting.default === 'string' ? setting.default : undefined;
  let control: ReactNode;
  switch (setting.type) {
    case 'textarea':
      control = (
        <Textarea
          id={id}
          value={text}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case 'richtext':
      control = (
        <div className="rounded-control border border-control px-3 [&_.prose-editor]:min-h-24 [&_.prose-editor]:text-sm">
          <RichText initial={value} srcOf={() => ''} placeholder="" onChange={onChange} />
        </div>
      );
      break;
    case 'boolean':
      return (
        <div className="flex items-center justify-between gap-4">
          <label htmlFor={id} className="text-sm font-medium">
            {l(setting.label, setting.id)}
          </label>
          <Switch
            id={id}
            checked={value === undefined ? setting.default === true : value === true}
            onCheckedChange={onChange}
          />
        </div>
      );
    case 'number':
      control = (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          value={text}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
      break;
    case 'select':
      control = (
        <Select
          id={id}
          value={text || String(setting.default ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          {(setting.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {l(o.label, o.value)}
            </option>
          ))}
        </Select>
      );
      break;
    case 'color':
      control = (
        <div className="flex gap-2">
          <input
            type="color"
            aria-label={l(setting.label, setting.id)}
            value={
              /^#[0-9a-f]{6}$/i.test(text || placeholder || '') ? text || placeholder : '#000000'
            }
            onChange={(e) => onChange(e.target.value)}
            className="h-9 w-12 cursor-pointer rounded-control border border-control bg-sheet p-1"
          />
          <Input
            id={id}
            value={text}
            placeholder={placeholder}
            spellCheck={false}
            className="font-mono"
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
      break;
    case 'image':
      control = (
        <ImageField id={id} value={typeof value === 'string' ? value : null} onChange={onChange} />
      );
      break;
    case 'url':
      control = (
        <Input
          id={id}
          type="text"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          value={text}
          placeholder={placeholder ?? 'https://…'}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    default:
      control = (
        <Input
          id={id}
          value={text}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
  return (
    <Field label={l(setting.label, setting.id)} htmlFor={id} error={error}>
      {control}
    </Field>
  );
}

/** Empty values are left out, so the theme's defaults apply. */
export function compact(values: Values): Values {
  return Object.fromEntries(
    Object.entries(values).filter(([, v]) => v !== '' && v !== null && v !== undefined),
  );
}

export function SettingsFields({
  settings,
  values,
  onChange,
  errors = {},
}: {
  settings: Setting[];
  values: Values;
  onChange: (values: Values) => void;
  errors?: Record<string, string>;
}) {
  return (
    <div className="grid gap-4">
      {settings.map((s) => (
        <SettingInput
          key={s.id}
          setting={s}
          value={values[s.id]}
          error={errors[s.id]}
          onChange={(v) => onChange({ ...values, [s.id]: v })}
        />
      ))}
    </div>
  );
}

export type SectionData = Omit<Section, 'type'>;

/** A section's own settings and its repeatable blocks. */
export function SectionFields({
  schema,
  value,
  onChange,
}: {
  schema: SectionSchema;
  value: SectionData;
  onChange: (value: SectionData) => void;
}) {
  const { t } = useI18n();
  const l = useLabel();
  const kinds = schema.blocks ?? [];
  const blocks = value.blocks;
  const max = schema.max_blocks ?? 50;
  const setBlocks = (next: SectionData['blocks']) => onChange({ ...value, blocks: next });
  const move = (i: number, by: number) => {
    const next = [...blocks];
    const [b] = next.splice(i, 1);
    next.splice(i + by, 0, b!);
    setBlocks(next);
  };
  return (
    <div className="grid gap-4">
      {schema.settings?.length ? (
        <SettingsFields
          settings={schema.settings}
          values={value.settings}
          onChange={(settings) => onChange({ ...value, settings })}
        />
      ) : null}
      {kinds.length > 0 && (
        <div className="grid gap-2">
          <p className="text-sm font-medium">
            {t('theme.blocks')}{' '}
            <span className="font-normal text-muted">· {t('theme.maxBlocks', { n: max })}</span>
          </p>
          {blocks.map((b, i) => {
            const kind = kinds.find((k) => k.type === b.type);
            return (
              <div key={i} className="rounded-card border border-border">
                <div className="flex h-10 items-center gap-1 border-b border-rule pr-1 pl-3">
                  <span className="mr-auto text-[13px] font-medium">
                    {i + 1}. {l(kind?.name, b.type)}
                  </span>
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
                    disabled={i === blocks.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="danger"
                    aria-label={t('common.remove')}
                    onClick={() => setBlocks(blocks.filter((_, j) => j !== i))}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <div className="p-3">
                  <SettingsFields
                    settings={kind?.settings ?? []}
                    values={b.settings}
                    onChange={(settings) =>
                      setBlocks(blocks.map((x, j) => (j === i ? { ...x, settings } : x)))
                    }
                  />
                </div>
              </div>
            );
          })}
          {blocks.length < max && (
            <div className="flex flex-wrap gap-2">
              {kinds.map((k) => (
                <Button
                  key={k.type}
                  size="sm"
                  variant="outline"
                  onClick={() => setBlocks([...blocks, { type: k.type, settings: {} }])}
                >
                  <Plus aria-hidden="true" />
                  {kinds.length > 1 ? l(k.name, k.type) : t('theme.addBlock')}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Strips empty values before saving a section. */
export function compactSection(value: SectionData): SectionData {
  return {
    settings: compact(value.settings),
    blocks: value.blocks.map((b) => ({ type: b.type, settings: compact(b.settings) })),
  };
}
