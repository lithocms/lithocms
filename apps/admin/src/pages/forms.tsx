import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ErrorNote, Loading, PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Pill } from '@/components/ui/pill';
import { api, ApiError, useApi } from '@/lib/api';
import { useFormat, useI18n, useLabel } from '@/lib/i18n';
import { useSite } from '@/lib/session';
import type { Form, FormField, Submission } from '@/lib/types';
import { cn, plain } from '@/lib/utils';

const FIELD_TYPES: FormField['type'][] = [
  'text',
  'textarea',
  'email',
  'tel',
  'number',
  'select',
  'checkbox',
  'date',
];

function Submissions({ form }: { form: Form }) {
  const { t } = useI18n();
  const l = useLabel();
  const fmt = useFormat();
  const site = useSite();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'new';
  const list = useApi<Submission[]>(
    site.path(
      `/forms/${form.key}/submissions?limit=200${status === 'all' ? '' : `&status=${status}`}`,
    ),
  );
  const [open, setOpen] = useState<Submission>();
  const columns = form.fields.slice(0, 2);
  const mark = async (s: Submission, next: Submission['status']) => {
    await api(site.path(`/submissions/${s.id}`), { method: 'PATCH', body: { status: next } });
    setOpen(undefined);
    list.reload();
  };
  const show = (v: unknown) => plain(v) || '—';
  return (
    <>
      <div className="-mb-px flex gap-4 px-4 md:px-6" role="tablist">
        {(['new', 'read', 'spam', 'all'] as const).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={status === f}
            onClick={() => setParams({ tab: 'submissions', status: f }, { replace: true })}
            className={cn(
              'h-9 cursor-pointer border-b-2 border-transparent text-sm text-muted hover:text-ink',
              status === f && 'border-ink font-medium text-ink',
            )}
          >
            {t(`status.${f}`)}
          </button>
        ))}
      </div>
      <div className="border-t border-rule">
        {list.error ? (
          <ErrorNote error={list.error} />
        ) : !list.data ? (
          <Loading />
        ) : list.data.length === 0 ? (
          <p className="px-4 py-10 text-sm text-muted md:px-6">{t('forms.noSubmissions')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="h-10 border-b border-rule text-left text-xs text-muted">
                <th className="w-44 pl-4 font-normal md:pl-6">{t('forms.received')}</th>
                {columns.map((c, i) => (
                  <th key={c.key} className={cn('font-normal', i > 0 && 'hidden md:table-cell')}>
                    {l(c.label, c.key)}
                  </th>
                ))}
                <th className="w-24 pr-6 font-normal">{t('posts.status')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr
                  key={s.id}
                  className="h-12 cursor-pointer border-b border-rule hover:bg-raised"
                  onClick={() => setOpen(s)}
                >
                  <td className="pl-4 whitespace-nowrap md:pl-6">
                    <button
                      className={cn(
                        'cursor-pointer hover:underline',
                        s.status === 'new' && 'font-medium',
                      )}
                    >
                      {fmt.dateTime(s.createdAt)}
                    </button>
                  </td>
                  {columns.map((c, i) => (
                    <td
                      key={c.key}
                      className={cn(
                        'max-w-0 truncate pr-3',
                        i > 0 && 'hidden text-muted md:table-cell',
                      )}
                    >
                      {show(s.data[c.key])}
                    </td>
                  ))}
                  <td className="pr-6">
                    <Pill tone={s.status === 'new' ? 'warning' : 'neutral'}>
                      {t(`status.${s.status}`)}
                    </Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <Dialog open={Boolean(open)} onOpenChange={(o) => !o && setOpen(undefined)}>
        {open && (
          <DialogContent title={fmt.dateTime(open.createdAt)} closeLabel={t('common.cancel')}>
            <dl className="grid gap-3 p-4">
              {form.fields.map((f) => (
                <div key={f.key} className="grid gap-0.5">
                  <dt className="text-xs text-muted">{l(f.label, f.key)}</dt>
                  <dd className="text-sm break-words whitespace-pre-wrap">
                    {show(open.data[f.key])}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="flex gap-2 border-t border-rule p-4">
              {open.status !== 'read' && (
                <Button variant="primary" onClick={() => void mark(open, 'read')}>
                  {t('forms.markRead')}
                </Button>
              )}
              {open.status !== 'spam' && (
                <Button variant="ghost" onClick={() => void mark(open, 'spam')}>
                  {t('forms.markSpam')}
                </Button>
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

function FormSettings({ form, onSaved }: { form: Form; onSaved: () => void }) {
  const { t, locale } = useI18n();
  const l = useLabel();
  const site = useSite();
  const [fields, setFields] = useState(form.fields);
  const [notify, setNotify] = useState(form.notifyEmails.join('\n'));
  const [success, setSuccess] = useState(form.successMessage);
  const [consent, setConsent] = useState(form.consentText);
  const [state, setState] = useState('');
  const [busy, setBusy] = useState(false);
  const setField = (i: number, patch: Partial<FormField>) =>
    setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const save = async () => {
    setBusy(true);
    try {
      await api(site.path(`/forms/${form.key}`), {
        method: 'PUT',
        body: {
          fields: fields.map((f) => ({
            ...f,
            options: f.type === 'select' ? (f.options ?? []) : undefined,
          })),
          notifyEmails: notify.split(/\s+/).filter(Boolean),
          successMessage: success,
          consentText: consent,
        },
      });
      setState(t('common.saved'));
      onSaved();
    } catch (err) {
      setState(
        err instanceof ApiError
          ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · ') || err.message
          : t('common.error'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid max-w-3xl gap-6 px-4 py-6 md:px-6">
      <section className="grid gap-2">
        <h2 className="text-section font-semibold">{t('forms.fields')}</h2>
        {fields.map((f, i) => (
          <div
            key={i}
            className="grid gap-2 rounded-card border border-border p-3 sm:grid-cols-[1fr_9rem_8rem_auto] sm:items-center"
          >
            <Input
              aria-label={t('menus.label')}
              value={l(f.label)}
              onChange={(e) =>
                setField(i, {
                  label:
                    typeof f.label === 'string'
                      ? e.target.value
                      : { ...f.label, [locale]: e.target.value },
                })
              }
            />
            <Input
              aria-label="key"
              value={f.key}
              spellCheck={false}
              className="font-mono text-[13px]"
              onChange={(e) => setField(i, { key: e.target.value })}
            />
            <Select
              aria-label={t('posts.status')}
              value={f.type}
              onChange={(e) => setField(i, { type: e.target.value as FormField['type'] })}
            >
              {FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
            <span className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[13px]">
                <input
                  type="checkbox"
                  className="size-4 accent-ink"
                  checked={f.required ?? false}
                  onChange={(e) => setField(i, { required: e.target.checked })}
                />
                *
              </label>
              <Button
                size="icon-sm"
                variant="danger"
                aria-label={t('common.remove')}
                onClick={() => setFields(fields.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </span>
            {f.type === 'select' && (
              <Input
                aria-label="options"
                className="sm:col-span-4"
                placeholder="a, b, c"
                value={(f.options ?? []).map((o) => o.value).join(', ')}
                onChange={(e) =>
                  setField(i, {
                    options: e.target.value
                      .split(',')
                      .map((v) => v.trim())
                      .filter(Boolean)
                      .map((value) => ({ value })),
                  })
                }
              />
            )}
          </div>
        ))}
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setFields([...fields, { key: `field_${fields.length + 1}`, label: '', type: 'text' }])
            }
          >
            <Plus aria-hidden="true" />
            {t('common.add')}
          </Button>
        </div>
      </section>
      <Field label={t('forms.notify')} hint={t('forms.notifyHint')} htmlFor="notify">
        <Textarea
          id="notify"
          value={notify}
          spellCheck={false}
          onChange={(e) => setNotify(e.target.value)}
          className="font-mono text-[13px]"
        />
      </Field>
      <Field label={t('forms.success')} htmlFor="success">
        <Textarea id="success" value={success} onChange={(e) => setSuccess(e.target.value)} />
      </Field>
      <Field label={t('forms.consent')} hint={t('forms.consentHint')} htmlFor="consent">
        <Textarea id="consent" value={consent} onChange={(e) => setConsent(e.target.value)} />
      </Field>
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
        </Button>
        <span aria-live="polite" className="text-[13px] text-muted">
          {state}
        </span>
      </div>
    </div>
  );
}

export function Forms() {
  const { t } = useI18n();
  const { key } = useParams();
  const site = useSite();
  const [params, setParams] = useSearchParams();
  const list = useApi<Form[]>(site.path('/forms'));
  if (list.error) return <ErrorNote error={list.error} />;
  if (!list.data) return <Loading />;
  const form = list.data.find((f) => f.key === key);
  if (!form) {
    return (
      <>
        <PageHeader title={t('nav.forms')} />
        {list.data.length === 0 ? (
          <p className="px-4 py-10 text-sm text-muted md:px-6">{t('forms.none')}</p>
        ) : (
          <ul className="border-t border-rule">
            {list.data.map((f) => (
              <li key={f.key} className="border-b border-rule">
                <Link
                  to={site.to(`/forms/${f.key}`)}
                  className="flex h-12 items-center gap-3 px-4 hover:bg-raised md:px-6"
                >
                  <span className="font-mono font-medium">{f.key}</span>
                  <span className="ml-auto text-[13px] text-muted">
                    {t('forms.fieldCount', { n: f.fields.length })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }
  const tab = params.get('tab') === 'settings' ? 'settings' : 'submissions';
  return (
    <>
      <PageHeader title={form.key} />
      <div className="-mb-px flex gap-4 border-b border-rule px-4 md:px-6" role="tablist">
        {(['submissions', 'settings'] as const).map((x) => (
          <button
            key={x}
            role="tab"
            aria-selected={tab === x}
            onClick={() => setParams({ tab: x }, { replace: true })}
            className={cn(
              'h-9 cursor-pointer border-b-2 border-transparent text-sm text-muted hover:text-ink',
              tab === x && 'border-ink font-medium text-ink',
            )}
          >
            {t(x === 'submissions' ? 'forms.submissions' : 'forms.settings')}
          </button>
        ))}
      </div>
      {tab === 'submissions' ? (
        <Submissions form={form} />
      ) : (
        <FormSettings form={form} onSaved={list.reload} />
      )}
    </>
  );
}
