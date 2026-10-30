import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ImageField } from '@/components/media-picker';
import { SaveBar, SettingsRow } from '@/components/settings-row';
import { ErrorNote, Loading, PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api, ApiError, useApi, type Issue } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession, useSite } from '@/lib/session';
import type { SiteSettings } from '@/lib/types';

const ZONES = Intl.supportedValuesOf('timeZone');

export function SiteSettingsPage() {
  const { t } = useI18n();
  const site = useSite();
  const { reload } = useSession();
  const loaded = useApi<SiteSettings>(site.path('/settings'));
  const [form, setForm] = useState<SiteSettings>();
  const [social, setSocial] = useState<[string, string][]>([]);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]);
  useEffect(() => {
    if (!loaded.data) return;
    setForm(loaded.data);
    setSocial(Object.entries(loaded.data.social));
  }, [loaded.data]);

  if (loaded.error) return <ErrorNote error={loaded.error} />;
  if (!form) return <Loading />;

  const set = <K extends keyof SiteSettings>(key: K, value: SiteSettings[K]) => {
    setForm({ ...form, [key]: value });
    setState('');
  };
  const errorFor = (key: string) => issues.find((i) => i.path[0] === key)?.message;
  const save = async () => {
    setBusy(true);
    setIssues([]);
    try {
      const { postsPerPage, ...rest } = form;
      const saved = await api<SiteSettings>(site.path('/settings'), {
        method: 'PATCH',
        body: {
          ...rest,
          ...(postsPerPage ? { postsPerPage } : {}),
          social: Object.fromEntries(social.filter(([k, v]) => k && v)),
        },
      });
      setForm(saved);
      setState(t('common.saved'));
      if (saved.name !== site.name) reload();
    } catch (err) {
      if (err instanceof ApiError) {
        setIssues(err.issues);
        setState(err.status === 403 ? t('common.forbidden') : err.issues.length ? '' : err.message);
      } else setState(t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  const saveBar = (
    <SaveBar
      busy={busy}
      state={state}
      onSave={() => void save()}
      label={busy ? t('common.saving') : t('common.save')}
    />
  );

  return (
    <>
      <PageHeader title={t('nav.settings')} />
      <div className="mx-auto max-w-[1152px] px-4 md:px-6">
        <SettingsRow title={t('settings.general')} hint={t('settings.generalHint')}>
          <Field label={t('settings.name')} htmlFor="name" error={errorFor('name')}>
            <Input
              id="name"
              value={form.name}
              autoComplete="off"
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          <Field label={t('settings.tagline')} htmlFor="tagline" error={errorFor('tagline')}>
            <Input
              id="tagline"
              value={form.tagline}
              autoComplete="off"
              onChange={(e) => set('tagline', e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('settings.locale')} htmlFor="locale">
              <Select
                id="locale"
                value={form.locale}
                onChange={(e) => set('locale', e.target.value)}
              >
                <option value="tr">{t('lang.tr')}</option>
                <option value="en">{t('lang.en')}</option>
              </Select>
            </Field>
            <Field label={t('settings.timezone')} htmlFor="tz" error={errorFor('timezone')}>
              <Select
                id="tz"
                value={form.timezone}
                onChange={(e) => set('timezone', e.target.value)}
              >
                {ZONES.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t('settings.logo')}>
            <ImageField value={form.logo} onChange={(id) => set('logo', id)} />
          </Field>
          <Field label={t('settings.icon')} hint={t('settings.iconHint')}>
            <ImageField value={form.icon} onChange={(id) => set('icon', id)} />
          </Field>
          {saveBar}
        </SettingsRow>
        <SettingsRow title={t('settings.reading')} hint={t('settings.readingHint')}>
          <Field label={t('settings.postsPerPage')} htmlFor="ppp" error={errorFor('postsPerPage')}>
            <Input
              id="ppp"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              value={form.postsPerPage ?? ''}
              onChange={(e) => set('postsPerPage', e.target.value ? Number(e.target.value) : null)}
              className="w-32"
            />
          </Field>
          <div className="flex items-center justify-between gap-4">
            <label htmlFor="se" className="text-sm font-medium">
              {t('settings.searchEngines')}
            </label>
            <Switch
              id="se"
              checked={form.searchEngines}
              onCheckedChange={(v) => set('searchEngines', v)}
            />
          </div>
          {saveBar}
        </SettingsRow>
        <SettingsRow title={t('settings.social')} hint={t('settings.socialHint')}>
          {social.map(([k, v], i) => (
            <div key={i} className="flex gap-2">
              <Input
                aria-label="network"
                value={k}
                placeholder="instagram"
                spellCheck={false}
                className="w-36 font-mono text-[13px]"
                onChange={(e) =>
                  setSocial(
                    social.map((x, j) => (j === i ? [e.target.value.toLowerCase(), x[1]] : x)),
                  )
                }
              />
              <Input
                aria-label="URL"
                value={v}
                inputMode="url"
                spellCheck={false}
                placeholder="https://…"
                onChange={(e) =>
                  setSocial(social.map((x, j) => (j === i ? [x[0], e.target.value] : x)))
                }
              />
              <Button
                size="icon"
                variant="danger"
                aria-label={t('common.remove')}
                onClick={() => setSocial(social.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          {errorFor('social') && <p className="text-[13px] text-negative">{errorFor('social')}</p>}
          <div>
            <Button size="sm" variant="outline" onClick={() => setSocial([...social, ['', '']])}>
              <Plus aria-hidden="true" />
              {t('common.add')}
            </Button>
          </div>
          {saveBar}
        </SettingsRow>
      </div>
    </>
  );
}
