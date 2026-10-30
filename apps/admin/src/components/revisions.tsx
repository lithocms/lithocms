import { History } from 'lucide-react';
import { useState } from 'react';
import { Loading } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Pill } from '@/components/ui/pill';
import { api, ApiError, useApi } from '@/lib/api';
import { useFormat, useI18n } from '@/lib/i18n';
import { useSite } from '@/lib/session';
import type { Revision } from '@/lib/types';

/** A post's saved versions, newest first; any older one can become the current version again. */
export function Revisions({ postId, onRestored }: { postId: string; onRestored: () => void }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const site = useSite();
  const [open, setOpen] = useState(false);
  const list = useApi<Revision[]>(open ? site.path(`/posts/${postId}/revisions`) : null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const restore = async (id: string) => {
    if (confirm !== id) return setConfirm(id);
    setBusy(true);
    setError('');
    try {
      await api(site.path(`/revisions/${id}/restore`), { method: 'POST', body: {} });
      setOpen(false);
      onRestored();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403 ? t('common.forbidden') : t('common.error'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <History aria-hidden="true" />
        {t('revisions.show')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <DialogContent title={t('revisions.title')} closeLabel={t('common.cancel')}>
            <div className="grid content-start gap-3 overflow-y-auto p-4">
              <p className="text-[13px] text-muted">{t('revisions.hint')}</p>
              {!list.data ? (
                <Loading />
              ) : (
                <ol className="grid gap-2">
                  {list.data.map((rev, i) => (
                    <li
                      key={rev.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-border px-3 py-2.5"
                    >
                      <span className="text-sm font-medium tabular-nums">
                        {fmt.dateTime(rev.createdAt)}
                      </span>
                      <Pill>{t(`revisions.source.${rev.source}`)}</Pill>
                      {i === 0 ? (
                        <span className="ml-auto text-[13px] text-muted">
                          {t('revisions.current')}
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant={confirm === rev.id ? 'primary' : 'ghost'}
                          className="ml-auto"
                          disabled={busy}
                          onClick={() => void restore(rev.id)}
                        >
                          {confirm === rev.id ? t('revisions.confirm') : t('revisions.restore')}
                        </Button>
                      )}
                      <span className="w-full min-w-0 truncate text-[13px] text-muted">
                        {rev.snapshot.title || '—'}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <p role="alert" aria-live="polite" className="text-[13px] text-negative">
                {error}
              </p>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
