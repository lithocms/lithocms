import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { ErrorNote, Loading, PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Pill } from '@/components/ui/pill';
import { api, ApiError, useApi, type Issue } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSite } from '@/lib/session';
import type { Redirect } from '@/lib/types';

const LIMIT = 200;

function RedirectForm({ redirect, onDone }: { redirect?: Redirect; onDone: () => void }) {
  const { t } = useI18n();
  const site = useSite();
  const [fromPath, setFromPath] = useState(redirect?.fromPath ?? '');
  const [to, setTo] = useState(redirect?.to ?? '');
  const [code, setCode] = useState<Redirect['code']>(redirect?.code ?? 301);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const fail = (err: unknown) =>
    setIssues(
      err instanceof ApiError
        ? err.issues.length
          ? err.issues
          : [{ path: [], message: err.status === 409 ? t('redirects.exists') : err.message }]
        : [{ path: [], message: t('common.error') }],
    );

  const save = async () => {
    setBusy(true);
    setIssues([]);
    try {
      const body = { fromPath, to: code === 410 ? '' : to, code };
      await api(redirect ? site.path(`/redirects/${redirect.id}`) : site.path('/redirects'), {
        method: redirect ? 'PUT' : 'POST',
        body,
      });
      onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!redirect) return;
    if (!confirm) return setConfirm(true);
    setBusy(true);
    try {
      await api(site.path(`/redirects/${redirect.id}`), { method: 'DELETE' });
      onDone();
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  };

  const errorFor = (key: string) => issues.find((i) => i.path[0] === key)?.message;
  const other = issues.filter((i) => !['fromPath', 'to'].includes(String(i.path[0])));
  return (
    <form
      className="grid gap-4 overflow-y-auto p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field
        label={t('redirects.from')}
        hint={t('redirects.fromHint')}
        htmlFor="redirect-from"
        error={errorFor('fromPath')}
      >
        <Input
          id="redirect-from"
          name="redirect-from"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          required
          placeholder="/eski-yazi/"
          value={fromPath}
          aria-invalid={errorFor('fromPath') ? true : undefined}
          onChange={(e) => setFromPath(e.target.value)}
          className="font-mono"
        />
      </Field>
      <Field label={t('redirects.code')} htmlFor="redirect-code">
        <Select
          id="redirect-code"
          value={code}
          onChange={(e) => setCode(Number(e.target.value) as Redirect['code'])}
        >
          <option value={301}>{t('redirects.code301')}</option>
          <option value={302}>{t('redirects.code302')}</option>
          <option value={410}>{t('redirects.code410')}</option>
        </Select>
      </Field>
      {code !== 410 && (
        <Field
          label={t('redirects.to')}
          hint={t('redirects.toHint')}
          htmlFor="redirect-to"
          error={errorFor('to')}
        >
          <Input
            id="redirect-to"
            name="redirect-to"
            autoComplete="off"
            spellCheck={false}
            required
            placeholder="/yeni-yazi/"
            value={to}
            aria-invalid={errorFor('to') ? true : undefined}
            onChange={(e) => setTo(e.target.value)}
            className="font-mono"
          />
        </Field>
      )}
      {other.length > 0 && (
        <p role="alert" className="text-[13px] text-negative">
          {other.map((i) => i.message).join(' ')}
        </p>
      )}
      <div className="flex items-center gap-2 border-t border-rule pt-4">
        <Button type="submit" variant="primary" disabled={busy || !fromPath.trim()}>
          {busy ? t('common.saving') : t('common.save')}
        </Button>
        {redirect && (
          <Button
            type="button"
            variant="danger"
            className="ml-auto"
            disabled={busy}
            onClick={() => void remove()}
          >
            <Trash2 aria-hidden="true" />
            {confirm ? t('redirects.confirmDelete') : t('common.delete')}
          </Button>
        )}
      </div>
    </form>
  );
}

/** Old addresses that lead somewhere else (or are gone for good). Admins only. */
export function Redirects() {
  const { t } = useI18n();
  const site = useSite();
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim());
  const list = useApi<Redirect[]>(
    site.path(
      `/redirects?limit=${LIMIT}${deferred ? `&query=${encodeURIComponent(deferred)}` : ''}`,
    ),
  );
  const [editing, setEditing] = useState<Redirect | 'new'>();
  const done = () => {
    setEditing(undefined);
    list.reload();
  };

  return (
    <>
      <PageHeader title={t('nav.redirects')}>
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus aria-hidden="true" />
          {t('redirects.new')}
        </Button>
      </PageHeader>
      <div className="px-4 pb-3 md:px-6">
        <Input
          type="search"
          name="redirect-search"
          aria-label={t('common.search')}
          placeholder={t('common.search')}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-sm"
        />
      </div>
      {list.error ? (
        <ErrorNote error={list.error} />
      ) : !list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <p className="border-t border-rule px-4 py-10 text-sm text-muted md:px-6">
          {deferred ? t('redirects.noMatch') : t('redirects.empty')}
        </p>
      ) : (
        <>
          <ul className="border-t border-rule">
            {list.data.map((r) => (
              <li key={r.id} className="border-b border-rule">
                <button
                  type="button"
                  onClick={() => setEditing(r)}
                  className="grid min-h-12 w-full cursor-pointer gap-1 px-4 py-2 text-left hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-4 md:px-6"
                >
                  <span
                    className="flex min-w-0 items-center gap-2 font-mono text-[13px]"
                    translate="no"
                  >
                    <span className="min-w-0 truncate">{r.fromPath}</span>
                    <ArrowRight className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
                    <span className="min-w-0 truncate text-muted">
                      {r.code === 410 ? t('redirects.gone') : r.to}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-[13px] text-muted">
                    <Pill tone={r.code === 410 ? 'warning' : 'neutral'}>{r.code}</Pill>
                    {r.source !== 'manual' && <span>{t(`redirects.source.${r.source}`)}</span>}
                    <span className="tabular-nums">{t('redirects.hits', { n: r.hits })}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {list.data.length === LIMIT && (
            <p className="px-4 py-4 text-[13px] text-muted md:px-6">{t('redirects.limited')}</p>
          )}
        </>
      )}
      <Dialog open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)}>
        {editing !== undefined && (
          <DialogContent
            title={editing === 'new' ? t('redirects.new') : t('redirects.edit')}
            closeLabel={t('common.cancel')}
          >
            <RedirectForm redirect={editing === 'new' ? undefined : editing} onDone={done} />
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
