import { Download, Eye, RotateCcw, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { ErrorNote, Loading } from '@/components/shell';
import { SettingsRow } from '@/components/settings-row';
import { Button } from '@/components/ui/button';
import { Pill } from '@/components/ui/pill';
import { api, ApiError, useApi } from '@/lib/api';
import { useFormat, useI18n } from '@/lib/i18n';
import { useSite } from '@/lib/session';
import type { ThemeIssue, ThemeLibrary as Library, ThemeReport } from '@/lib/types';

type Version = Library['themes'][number]['versions'][number];

function Issues({ title, issues }: { title: string; issues: ThemeIssue[] }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-2 text-[13px]">
      <p>{title}</p>
      <ul className="grid gap-1">
        {issues.map((i, n) => (
          <li key={n} className="rounded-control bg-sheet px-3 py-2">
            <span className="font-mono text-muted">
              {i.path || 'theme'}
              {i.line ? ` · ${t('theme.line', { n: i.line })}` : ''}
            </span>{' '}
            {i.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Upload, preview, activate, roll back, download and delete the site's themes. */
export function ThemeLibrary({ live, onChange }: { live: string; onChange: () => void }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const site = useSite();
  const library = useApi<Library>(site.path('/themes'));
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [report, setReport] = useState<{ invalid: boolean; issues: ThemeIssue[] } | null>(null);
  const [confirm, setConfirm] = useState('');

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setNote('');
    try {
      await fn();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy('');
    }
  };
  const changed = (next: Library) => {
    library.set(next);
    onChange();
  };

  const upload = (file: File) =>
    act('upload', async () => {
      setReport(null);
      try {
        const res = await api<{
          slug: string;
          name: string;
          version: string;
          replaced: boolean;
          report: ThemeReport;
        }>(site.path('/themes'), {
          method: 'POST',
          body: file.type ? file : new Blob([file], { type: 'application/zip' }),
        });
        setNote(
          t(res.replaced ? 'theme.replaced' : 'theme.uploaded', { name: res.name, v: res.version }),
        );
        if (res.report.warnings.length) setReport({ invalid: false, issues: res.report.warnings });
        library.reload();
      } catch (err) {
        const detail = err instanceof ApiError ? (err.detail as { report?: ThemeReport }) : {};
        if (!detail?.report) throw err;
        setReport({ invalid: true, issues: detail.report.errors });
      }
    });

  const preview = (v: Version) =>
    act(`preview:${v.id}`, async () => {
      // Opened before the request so the browser does not treat it as a popup.
      const tab = window.open('about:blank', '_blank');
      try {
        const { url } = await api<{ url: string }>(site.path(`/themes/versions/${v.id}/preview`), {
          method: 'POST',
        });
        if (tab) {
          tab.opener = null;
          tab.location.href = url;
        } else window.location.href = url;
      } catch (err) {
        tab?.close();
        throw err;
      }
    });

  if (library.error) return <ErrorNote error={library.error} />;
  if (!library.data) return <Loading />;
  const { themes, activeVersionId, previousVersionId } = library.data;
  // Without an active version the site uses the default bundled theme (`live` = slug@version).
  const isLive = (slug: string, v: Version) =>
    activeVersionId ? v.id === activeVersionId : `${slug}@${v.version}` === live;

  return (
    <SettingsRow title={t('theme.library')} hint={t('theme.libraryHint')}>
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={input}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void upload(file);
          }}
        />
        <Button variant="primary" disabled={busy !== ''} onClick={() => input.current?.click()}>
          <Upload aria-hidden="true" />
          {busy === 'upload' ? t('theme.uploading') : t('theme.upload')}
        </Button>
        {previousVersionId !== activeVersionId && (
          <Button
            variant="outline"
            disabled={busy !== ''}
            onClick={() =>
              void act('rollback', async () =>
                changed(await api<Library>(site.path('/themes/rollback'), { method: 'POST' })),
              )
            }
          >
            <RotateCcw aria-hidden="true" />
            {t('theme.rollback')}
          </Button>
        )}
        <span aria-live="polite" className="text-[13px] text-muted">
          {note}
        </span>
      </div>
      {report && (
        <div
          role={report.invalid ? 'alert' : 'status'}
          className={report.invalid ? 'text-negative' : 'text-muted'}
        >
          <Issues
            title={report.invalid ? t('theme.invalid') : t('theme.warnings')}
            issues={report.issues}
          />
        </div>
      )}
      <ul className="grid gap-2">
        {themes.map((theme) => (
          <li key={theme.id} className="rounded-card border border-border bg-sheet">
            <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2">
              <span className="font-medium" translate="no">
                {theme.name}
              </span>
              <span className="font-mono text-xs text-muted">{theme.slug}</span>
              <Pill>{theme.origin === 'bundled' ? t('theme.bundled') : t('theme.own')}</Pill>
              {theme.origin !== 'bundled' && !theme.versions.some((v) => isLive(theme.slug, v)) && (
                <Button
                  variant="danger"
                  size="sm"
                  className="ml-auto"
                  disabled={busy !== ''}
                  onClick={() => {
                    if (confirm !== theme.id) return setConfirm(theme.id);
                    void act(`delete:${theme.id}`, async () => {
                      await api(site.path(`/themes/${theme.id}`), { method: 'DELETE' });
                      setConfirm('');
                      library.reload();
                    });
                  }}
                >
                  {confirm === theme.id ? t('theme.confirmDelete') : t('theme.delete')}
                </Button>
              )}
            </div>
            <ul className="border-t border-rule">
              {theme.versions.map((v) => {
                const on = isLive(theme.slug, v);
                const valid = v.status === 'valid' || v.status === 'active';
                return (
                  <li
                    key={v.id}
                    className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-2 last:border-0"
                  >
                    <span className="text-sm tabular-nums">
                      {t('theme.version', { v: v.version })}
                    </span>
                    <span className="text-[13px] text-muted">{fmt.date(v.createdAt)}</span>
                    {on && <Pill tone="positive">{t('theme.live')}</Pill>}
                    <span className="ml-auto flex flex-wrap gap-1">
                      {valid && !on && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy !== ''}
                          onClick={() => void preview(v)}
                        >
                          <Eye aria-hidden="true" />
                          {t('theme.preview')}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" asChild>
                        <a href={`/api${site.path(`/themes/versions/${v.id}/download`)}`} download>
                          <Download aria-hidden="true" />
                          {t('theme.download')}
                        </a>
                      </Button>
                      {valid && !on && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy !== ''}
                          onClick={() =>
                            void act(`activate:${v.id}`, async () =>
                              changed(
                                await api<Library>(site.path(`/themes/versions/${v.id}/activate`), {
                                  method: 'POST',
                                }),
                              ),
                            )
                          }
                        >
                          {t('theme.activate')}
                        </Button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </SettingsRow>
  );
}
