import { useState } from 'react';
import { ErrorNote, Loading, PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Label, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api, ApiError, useApi } from '@/lib/api';
import { useI18n, useLabel } from '@/lib/i18n';
import { useSite } from '@/lib/session';
import type { Slot, Theme } from '@/lib/types';

function SlotEditor({ slotKey, label, stored }: { slotKey: string; label: string; stored?: Slot }) {
  const { t } = useI18n();
  const site = useSite();
  const [html, setHtml] = useState(stored?.html ?? '');
  const [enabled, setEnabled] = useState(stored?.enabled ?? false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string }>();

  const save = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      await api(site.path(`/slots/${slotKey}`), { method: 'PUT', body: { html, enabled } });
      setDirty(false);
      setMessage({ error: false, text: t('common.saved') });
    } catch (err) {
      setMessage({
        error: true,
        text:
          err instanceof ApiError && err.status === 403 ? t('common.forbidden') : t('common.error'),
      });
    } finally {
      setBusy(false);
    }
  };

  const id = `slot-${slotKey}`;
  return (
    <section className="grid gap-3 border-b border-rule px-4 py-5 md:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Label htmlFor={id} className="font-semibold">
          {label}
        </Label>
        <span className="font-mono text-xs text-muted" translate="no">
          {slotKey}
        </span>
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-[13px]">
          {t('slots.enabled')}
          <Switch
            checked={enabled}
            onCheckedChange={(on) => {
              setEnabled(on);
              setDirty(true);
              setMessage(undefined);
            }}
          />
        </label>
      </div>
      <Textarea
        id={id}
        name={id}
        rows={6}
        spellCheck={false}
        autoComplete="off"
        maxLength={100_000}
        placeholder="<script>…</script>"
        value={html}
        onChange={(e) => {
          setHtml(e.target.value);
          setDirty(true);
          setMessage(undefined);
        }}
        className="font-mono text-[13px]"
      />
      <div className="flex items-center gap-3">
        <Button variant="primary" size="sm" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
        </Button>
        <span
          role={message?.error ? 'alert' : undefined}
          aria-live="polite"
          className={`text-[13px] ${message?.error ? 'text-negative' : 'text-muted'}`}
        >
          {message?.text ?? (dirty ? t('common.unsaved') : '')}
        </span>
      </div>
    </section>
  );
}

/**
 * Raw HTML the active theme places on every page (analytics, verification tags, ad code).
 * Admins only: it is the one place HTML is output unsanitized.
 */
export function Slots() {
  const { t } = useI18n();
  const l = useLabel();
  const site = useSite();
  const theme = useApi<Theme>(site.path('/theme'));
  const stored = useApi<Slot[]>(site.path('/slots'));
  const error = theme.error ?? stored.error;
  if (error) return <ErrorNote error={error} />;
  if (!theme.data || !stored.data) return <Loading />;

  const declared = theme.data.slots;
  // Slots saved under an earlier theme stay editable, so their code can be switched off.
  const orphans = stored.data.filter((s) => !declared.some((d) => d.key === s.key));
  return (
    <>
      <PageHeader title={t('nav.slots')} />
      <p className="max-w-2xl px-4 pb-4 text-sm text-muted md:px-6">{t('slots.hint')}</p>
      <div className="border-t border-rule">
        {declared.length === 0 && orphans.length === 0 && (
          <p className="px-4 py-10 text-sm text-muted md:px-6">{t('slots.none')}</p>
        )}
        {declared.map((d) => (
          <SlotEditor
            key={d.key}
            slotKey={d.key}
            label={l(d.label, d.key)}
            stored={stored.data?.find((s) => s.key === d.key)}
          />
        ))}
        {orphans.map((s) => (
          <SlotEditor key={s.key} slotKey={s.key} label={t('slots.unused')} stored={s} />
        ))}
      </div>
    </>
  );
}
