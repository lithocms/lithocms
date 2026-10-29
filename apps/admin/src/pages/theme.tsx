import { useState } from 'react';
import {
  compact,
  compactSection,
  SectionFields,
  SettingsFields,
  type SectionData,
  type Values,
} from '@/components/settings-form';
import { SaveBar, SettingsRow } from '@/components/settings-row';
import { ErrorNote, Loading, PageHeader } from '@/components/shell';
import { api, ApiError, useApi, type Issue } from '@/lib/api';
import { useI18n, useLabel } from '@/lib/i18n';
import { useSite } from '@/lib/session';
import type { SectionSchema, Theme } from '@/lib/types';

function useSave(t: ReturnType<typeof useI18n>['t']) {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setIssues([]);
    try {
      await fn();
      setState(t('common.saved'));
    } catch (err) {
      if (err instanceof ApiError) {
        setIssues(err.issues);
        setState(err.status === 403 ? t('common.forbidden') : err.issues.length ? '' : err.message);
      } else setState(t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  const errors = Object.fromEntries(issues.map((i) => [String(i.path.at(-1)), i.message]));
  return {
    busy,
    state: state || (issues.length ? issues.map((i) => i.message).join(' ') : ''),
    errors,
    run,
    touch: () => setState(''),
  };
}

function ThemeSettings({ theme }: { theme: Theme }) {
  const { t } = useI18n();
  const site = useSite();
  const [values, setValues] = useState<Values>(theme.values);
  const save = useSave(t);
  return (
    <SettingsRow
      title={t('theme.settings')}
      hint={`${theme.name} · ${t('theme.version', { v: theme.version })}`}
    >
      <SettingsFields
        settings={theme.settings}
        values={values}
        errors={save.errors}
        onChange={(v) => {
          setValues(v);
          save.touch();
        }}
      />
      <SaveBar
        busy={save.busy}
        state={save.state}
        label={save.busy ? t('common.saving') : t('common.save')}
        onSave={() =>
          void save.run(() =>
            api(site.path('/theme/settings'), { method: 'PUT', body: compact(values) }),
          )
        }
      />
    </SettingsRow>
  );
}

function StaticSection({
  name,
  schema,
  data,
}: {
  name: string;
  schema: SectionSchema;
  data: SectionData | null;
}) {
  const { t } = useI18n();
  const l = useLabel();
  const site = useSite();
  const [value, setValue] = useState<SectionData>(data ?? { settings: {}, blocks: [] });
  const save = useSave(t);
  return (
    <details className="group rounded-card border border-border bg-sheet open:pb-4">
      <summary className="flex h-12 cursor-pointer items-center justify-between gap-3 px-4 text-sm font-medium">
        {l(schema.name, name)}
        <span className="font-mono text-xs font-normal text-muted">{name}</span>
      </summary>
      <div className="grid gap-4 border-t border-rule px-4 pt-4">
        <SectionFields
          schema={schema}
          value={value}
          onChange={(v) => {
            setValue(v);
            save.touch();
          }}
        />
        <SaveBar
          busy={save.busy}
          state={save.state}
          label={save.busy ? t('common.saving') : t('common.save')}
          onSave={() =>
            void save.run(() =>
              api(site.path(`/theme/sections/${name}`), {
                method: 'PUT',
                body: compactSection(value),
              }),
            )
          }
        />
      </div>
    </details>
  );
}

export function ThemePage() {
  const { t } = useI18n();
  const site = useSite();
  const theme = useApi<Theme>(site.path('/theme'));
  if (theme.error) return <ErrorNote error={theme.error} />;
  if (!theme.data) return <Loading />;
  return (
    <>
      <PageHeader title={t('nav.theme')} />
      <div className="mx-auto max-w-[1152px] px-4 md:px-6">
        <ThemeSettings theme={theme.data} />
        {theme.data.sections.length > 0 && (
          <SettingsRow title={t('theme.sections')}>
            {theme.data.sections.map((s) => (
              <StaticSection key={s.name} name={s.name} schema={s.schema} data={s.data} />
            ))}
          </SettingsRow>
        )}
      </div>
    </>
  );
}
