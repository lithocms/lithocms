import { useState } from 'react';
import { UploadButton } from '@/components/media-picker';
import { ErrorNote, Loading, PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { api, ApiError, useApi } from '@/lib/api';
import { useFormat, useI18n } from '@/lib/i18n';
import { useSite } from '@/lib/session';
import type { Media, Page } from '@/lib/types';

function MediaDetails({ media, onSaved }: { media: Media; onSaved: (m: Media) => void }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const site = useSite();
  const [alt, setAlt] = useState(media.alt);
  const [caption, setCaption] = useState(media.caption);
  // 'idle', 'busy', 'saved' or an error message
  const [state, setState] = useState('idle');
  const save = async () => {
    setState('busy');
    try {
      onSaved(
        await api<Media>(site.path(`/media/${media.id}`), {
          method: 'PATCH',
          body: { alt, caption },
        }),
      );
      setState('saved');
    } catch (err) {
      setState(err instanceof ApiError ? err.message : t('common.error'));
    }
  };
  return (
    <div className="grid gap-4 p-4">
      <img
        src={site.media(media.path)}
        alt={alt}
        width={media.width}
        height={media.height}
        className="max-h-80 w-full rounded-control bg-raised object-contain"
      />
      <p className="text-[13px] text-muted">
        <span className="font-mono">{media.originalName}</span> · {media.width}×{media.height} ·{' '}
        {fmt.kb(media.size)} · {fmt.date(media.createdAt)}
      </p>
      <Field label={t('media.alt')} hint={t('media.altHint')} htmlFor="alt">
        <Input id="alt" value={alt} onChange={(e) => setAlt(e.target.value)} />
      </Field>
      <Field label={t('media.caption')} htmlFor="caption">
        <Textarea id="caption" value={caption} onChange={(e) => setCaption(e.target.value)} />
      </Field>
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={state === 'busy'} onClick={() => void save()}>
          {state === 'busy' ? t('common.saving') : t('common.save')}
        </Button>
        <span aria-live="polite" className="text-[13px] text-muted">
          {state === 'saved'
            ? t('common.saved')
            : state !== 'idle' && state !== 'busy'
              ? state
              : ''}
        </span>
      </div>
    </div>
  );
}

export function MediaLibrary() {
  const { t } = useI18n();
  const site = useSite();
  const list = useApi<Page<Media>>(site.path('/media?limit=50'));
  const [extra, setExtra] = useState<{ items: Media[]; cursor: string | null }>();
  const [open, setOpen] = useState<Media>();
  const items = [...(list.data?.items ?? []), ...(extra?.items ?? [])];
  const cursor = extra ? extra.cursor : (list.data?.nextCursor ?? null);
  const loadMore = async () => {
    if (!cursor) return;
    const next = await api<Page<Media>>(
      site.path(`/media?limit=50&cursor=${encodeURIComponent(cursor)}`),
    );
    setExtra({ items: [...(extra?.items ?? []), ...next.items], cursor: next.nextCursor });
  };
  const replace = (m: Media) => {
    if (list.data)
      list.set({ ...list.data, items: list.data.items.map((x) => (x.id === m.id ? m : x)) });
    setExtra((e) => e && { ...e, items: e.items.map((x) => (x.id === m.id ? m : x)) });
  };

  return (
    <>
      <PageHeader title={t('nav.media')}>
        <UploadButton onUploaded={() => list.reload()} />
      </PageHeader>
      <p className="px-4 text-[13px] text-muted md:px-6">{t('media.drop')}</p>
      {list.error ? (
        <ErrorNote error={list.error} />
      ) : list.loading && !list.data ? (
        <Loading />
      ) : items.length === 0 ? (
        <p className="px-4 py-10 text-sm text-muted md:px-6">{t('media.empty')}</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 px-4 py-4 md:px-6">
          {items.map((m) => (
            <button
              key={m.id}
              onClick={() => setOpen(m)}
              className="group grid cursor-pointer gap-1.5 text-left"
              aria-label={`${t('common.edit')}: ${m.originalName}`}
            >
              <span className="block aspect-square overflow-hidden rounded-control border border-border bg-raised">
                <img
                  src={site.media(m.path)}
                  alt={m.alt}
                  width={m.width}
                  height={m.height}
                  loading="lazy"
                  className="size-full object-cover transition-opacity group-hover:opacity-85"
                />
              </span>
              <span className="truncate text-[13px]">{m.originalName}</span>
              {!m.alt && <span className="-mt-1 text-xs text-[#7a3a0c]">{t('media.alt')} —</span>}
            </button>
          ))}
        </div>
      )}
      {cursor && (
        <div className="px-4 pb-6 md:px-6">
          <Button variant="outline" onClick={() => void loadMore()}>
            {t('common.more')}
          </Button>
        </div>
      )}
      <Dialog open={Boolean(open)} onOpenChange={(o) => !o && setOpen(undefined)}>
        {open && (
          <DialogContent title={open.originalName} closeLabel={t('common.cancel')}>
            <MediaDetails
              media={open}
              onSaved={(m) => {
                replace(m);
                setOpen(m);
              }}
            />
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
