import { ImagePlus, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { api, useApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSite } from '@/lib/session';
import type { Media, Page } from '@/lib/types';

/** Uploads files one by one; returns the stored media. */
export function useUpload() {
  const site = useSite();
  const [busy, setBusy] = useState(false);
  const upload = async (files: FileList | File[]) => {
    setBusy(true);
    try {
      const out: Media[] = [];
      for (const file of Array.from(files)) {
        const qs = new URLSearchParams({ filename: file.name });
        out.push(await api<Media>(site.path(`/media?${qs}`), { method: 'POST', body: file }));
      }
      return out;
    } finally {
      setBusy(false);
    }
  };
  return { upload, busy };
}

export function UploadButton({ onUploaded }: { onUploaded: (media: Media[]) => void }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const { upload, busy } = useUpload();
  const [error, setError] = useState('');
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
        multiple
        hidden
        onChange={(e) => {
          const files = e.target.files;
          if (!files?.length) return;
          setError('');
          upload(files).then(onUploaded, (err: Error) => setError(err.message));
          e.target.value = '';
        }}
      />
      <Button variant="primary" disabled={busy} onClick={() => input.current?.click()}>
        <Upload aria-hidden="true" />
        {busy ? t('media.uploading') : t('media.upload')}
      </Button>
      {error && (
        <span role="alert" className="text-[13px] text-negative">
          {error}
        </span>
      )}
    </>
  );
}

/** A dialog listing the site's images; picking one closes it. */
export function MediaPicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (media: Media) => void;
}) {
  const { t } = useI18n();
  const site = useSite();
  const list = useApi<Page<Media>>(open ? site.path('/media?limit=50') : null);
  const pick = (m: Media) => {
    onPick(m);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('media.pick')} closeLabel={t('common.cancel')} className="max-w-3xl">
        <div className="flex items-center gap-3 px-4 pt-4">
          <UploadButton onUploaded={(m) => m[0] && pick(m[0])} />
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-2 p-4">
          {list.data?.items.map((m) => (
            <button
              key={m.id}
              onClick={() => pick(m)}
              className="group aspect-square cursor-pointer overflow-hidden rounded-control border border-border bg-raised"
            >
              <img
                src={site.media(m.path)}
                alt={m.alt}
                width={m.width}
                height={m.height}
                loading="lazy"
                className="size-full object-cover transition-opacity group-hover:opacity-85"
              />
            </button>
          ))}
          {list.data?.items.length === 0 && (
            <p className="col-span-full text-sm text-muted">{t('media.empty')}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** An image field: the chosen picture, or a button to choose one. */
export function ImageField({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: string | null;
  onChange: (mediaId: string | null) => void;
}) {
  const { t } = useI18n();
  const site = useSite();
  const [open, setOpen] = useState(false);
  const media = useApi<Media>(value ? site.path(`/media/${value}`) : null);
  return (
    <div className="flex items-center gap-3">
      <button
        id={id}
        onClick={() => setOpen(true)}
        className="grid size-16 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-control border border-control bg-raised text-muted hover:border-[#b5b5b0]"
        aria-label={value ? t('common.change') : t('common.choose')}
      >
        {value && media.data ? (
          <img
            src={site.media(media.data.path)}
            alt=""
            width={64}
            height={64}
            className="size-full object-cover"
          />
        ) : (
          <ImagePlus className="size-5" aria-hidden="true" />
        )}
      </button>
      <div className="flex min-w-0 flex-col items-start gap-1">
        {value && media.data && (
          <span className="max-w-full truncate text-[13px] text-muted">
            {media.data.originalName}
          </span>
        )}
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {value ? t('common.change') : t('common.choose')}
          </Button>
          {value && (
            <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
              {t('common.remove')}
            </Button>
          )}
        </div>
      </div>
      <MediaPicker open={open} onOpenChange={setOpen} onPick={(m) => onChange(m.id)} />
    </div>
  );
}
