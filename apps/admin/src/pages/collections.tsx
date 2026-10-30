import { Plus, Settings2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { compact, SettingInput } from '@/components/settings-form';
import { ErrorNote, Loading, PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Label, Select } from '@/components/ui/input';
import { FieldListEditor, toKey, typedKey } from '@/components/field-list';
import { Pill } from '@/components/ui/pill';
import { Switch } from '@/components/ui/switch';
import { api, ApiError, useApi, type Issue } from '@/lib/api';
import { useI18n, useLabel } from '@/lib/i18n';
import { useSite } from '@/lib/session';
import { fieldError, otherIssues } from '@/lib/issues';
import type { Collection, Entry, FieldDef, Setting } from '@/lib/types';

const AS_SETTING: Record<FieldDef['type'], Setting['type']> = {
  text: 'textarea',
  richtext: 'richtext',
  number: 'number',
  select: 'select',
  image: 'image',
  url: 'url',
  date: 'text',
  boolean: 'boolean',
  reference: 'text',
};
const asSetting = (f: FieldDef): Setting => ({
  id: f.key,
  type: AS_SETTING[f.type],
  label: f.label,
  options: f.options,
});

const FIELD_TYPES: FieldDef['type'][] = [
  'text',
  'richtext',
  'number',
  'select',
  'image',
  'url',
  'date',
  'boolean',
  'reference',
];

/** A collection's name, order and fields; creates one when `collection` is not given. */
function CollectionForm({
  collection,
  onDone,
}: {
  collection?: Collection;
  onDone: (key: string) => void;
}) {
  const { t } = useI18n();
  const site = useSite();
  const [label, setLabel] = useState(collection?.label ?? '');
  const [key, setKey] = useState(collection?.key ?? '');
  const [sortMode, setSortMode] = useState<Collection['sortMode']>(
    collection?.sortMode ?? 'manual',
  );
  const [fields, setFields] = useState<FieldDef[]>(
    collection?.fields ?? [
      { key: 'title', label: t('fields.title'), type: 'text', required: true },
    ],
  );
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setIssues([]);
    try {
      const body = { label, sortMode, fields };
      const finalKey = key.replace(/[-_]+$/, '');
      await api(
        collection ? site.path(`/collections/${collection.key}`) : site.path('/collections'),
        {
          method: collection ? 'PATCH' : 'POST',
          body: collection ? body : { ...body, key: finalKey },
        },
      );
      onDone(finalKey);
    } catch (err) {
      setIssues(
        err instanceof ApiError
          ? err.issues.length
            ? err.issues
            : [{ path: [], message: err.status === 409 ? t('collections.keyTaken') : err.message }]
          : [{ path: [], message: t('common.error') }],
      );
    } finally {
      setBusy(false);
    }
  };

  const errorFor = (k: string) => issues.find((i) => i.path[0] === k)?.message;
  const other = otherIssues(issues.filter((i) => !['label', 'key'].includes(String(i.path[0]))));
  return (
    <form
      className="grid gap-4 overflow-y-auto p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('collections.name')} htmlFor="collection-label" error={errorFor('label')}>
          <Input
            id="collection-label"
            name="collection-label"
            autoComplete="off"
            autoFocus
            required
            maxLength={200}
            placeholder={t('collections.namePlaceholder')}
            value={label}
            onChange={(e) => {
              // A new collection's key follows its name until edited.
              if (!collection && key === toKey(label, 'c', '-')) {
                setKey(toKey(e.target.value, 'c', '-'));
              }
              setLabel(e.target.value);
            }}
          />
        </Field>
        <Field
          label={t('fields.key')}
          hint={collection ? t('collections.keyFixed') : t('collections.keyHint')}
          htmlFor="collection-key"
          error={errorFor('key')}
        >
          <Input
            id="collection-key"
            name="collection-key"
            autoComplete="off"
            spellCheck={false}
            translate="no"
            required
            readOnly={Boolean(collection)}
            value={key}
            onChange={(e) => setKey(typedKey(e.target.value, '-'))}
            className="font-mono"
          />
        </Field>
      </div>
      <Field label={t('collections.order')} htmlFor="collection-order">
        <Select
          id="collection-order"
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as Collection['sortMode'])}
        >
          <option value="manual">{t('collections.orderManual')}</option>
          <option value="created_desc">{t('collections.orderNewest')}</option>
        </Select>
      </Field>
      <section className="grid gap-2">
        <h3 className="text-sm font-semibold">{t('forms.fields')}</h3>
        {collection && <p className="text-[13px] text-muted">{t('collections.fieldsHint')}</p>}
        <FieldListEditor
          fields={fields}
          types={FIELD_TYPES}
          onChange={setFields}
          errorFor={(i) => fieldError(issues, i)}
        />
      </section>
      {other && (
        <p role="alert" className="text-[13px] text-negative">
          {other}
        </p>
      )}
      <div className="border-t border-rule pt-4">
        <Button type="submit" variant="primary" disabled={busy || !label.trim() || !key}>
          {busy ? t('common.saving') : collection ? t('common.save') : t('collections.create')}
        </Button>
      </div>
    </form>
  );
}

/** A short plain-text preview of a value for the table. */
function preview(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value ? '…' : '';
}

function EntryForm({
  collection,
  entry,
  onDone,
}: {
  collection: Collection;
  entry?: Entry;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const site = useSite();
  const [data, setData] = useState<Record<string, unknown>>(entry?.data ?? {});
  const [published, setPublished] = useState(entry ? entry.status === 'published' : true);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const base = site.path(`/collections/${collection.key}/entries`);
  const save = async () => {
    setBusy(true);
    setIssues([]);
    try {
      const body = { data: compact(data), status: published ? 'published' : 'draft' };
      await api(entry ? `${base}/${entry.id}` : base, { method: entry ? 'PATCH' : 'POST', body });
      onDone();
    } catch (err) {
      setIssues(
        err instanceof ApiError
          ? err.issues.length
            ? err.issues
            : [{ path: [], message: err.message }]
          : [],
      );
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!entry || !window.confirm(`${t('common.delete')}?`)) return;
    await api(`${base}/${entry.id}`, { method: 'DELETE' });
    onDone();
  };
  const errorFor = (key: string) => issues.find((i) => i.path.includes(key))?.message;
  const other = issues.filter((i) => !collection.fields.some((f) => i.path.includes(f.key)));
  return (
    <div className="grid gap-4 p-4">
      {collection.fields.map((f) => (
        <SettingInput
          key={f.key}
          setting={asSetting(f)}
          value={data[f.key]}
          error={errorFor(f.key)}
          onChange={(v) => setData({ ...data, [f.key]: v })}
        />
      ))}
      <div className="flex items-center justify-between">
        <Label htmlFor="entry-published">{t('status.published')}</Label>
        <Switch id="entry-published" checked={published} onCheckedChange={setPublished} />
      </div>
      {other.length > 0 && (
        <p role="alert" className="text-[13px] text-negative">
          {other.map((i) => i.message).join(' ')}
        </p>
      )}
      <div className="flex items-center gap-2 border-t border-rule pt-4">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
        </Button>
        {entry && (
          <Button variant="danger" className="ml-auto" onClick={() => void remove()}>
            <Trash2 aria-hidden="true" />
            {t('common.delete')}
          </Button>
        )}
      </div>
    </div>
  );
}

function Entries({ collection, onChanged }: { collection: Collection; onChanged: () => void }) {
  const { t } = useI18n();
  const l = useLabel();
  const site = useSite();
  const entries = useApi<Entry[]>(site.path(`/collections/${collection.key}/entries?limit=200`));
  const [editing, setEditing] = useState<Entry | 'new'>();
  const [defining, setDefining] = useState(false);
  const columns = collection.fields
    .filter((f) => ['text', 'number', 'select', 'url', 'date'].includes(f.type))
    .slice(0, 2);
  const done = () => {
    setEditing(undefined);
    entries.reload();
  };
  return (
    <>
      <PageHeader title={collection.label}>
        {site.atLeast('editor') && (
          <Button variant="outline" onClick={() => setDefining(true)}>
            <Settings2 aria-hidden="true" />
            {t('collections.define')}
          </Button>
        )}
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus aria-hidden="true" />
          {t('collections.new')}
        </Button>
      </PageHeader>
      {entries.error ? (
        <ErrorNote error={entries.error} />
      ) : !entries.data ? (
        <Loading />
      ) : entries.data.length === 0 ? (
        <p className="px-4 py-10 text-sm text-muted md:px-6">{t('collections.empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="h-10 border-b border-rule text-left text-xs text-muted">
              {columns.map((c, i) => (
                <th
                  key={c.key}
                  className={
                    i === 0 ? 'pl-4 font-normal md:pl-6' : 'hidden font-normal md:table-cell'
                  }
                >
                  {l(c.label, c.key)}
                </th>
              ))}
              <th className="w-28 pr-6 font-normal">{t('posts.status')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.data.map((e) => (
              <tr
                key={e.id}
                className="h-12 cursor-pointer border-b border-rule hover:bg-raised"
                onClick={() => setEditing(e)}
              >
                {columns.map((c, i) => (
                  <td
                    key={c.key}
                    className={
                      i === 0
                        ? 'max-w-0 truncate pr-3 pl-4 md:pl-6'
                        : 'hidden max-w-0 truncate pr-3 text-muted md:table-cell'
                    }
                  >
                    {i === 0 ? (
                      <button
                        className="cursor-pointer truncate font-medium hover:underline"
                        onClick={() => setEditing(e)}
                      >
                        {preview(e.data[c.key]) || '—'}
                      </button>
                    ) : (
                      preview(e.data[c.key]) || '—'
                    )}
                  </td>
                ))}
                <td>
                  <Pill tone={e.status === 'published' ? 'positive' : 'neutral'}>
                    {t(`status.${e.status}`)}
                  </Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Dialog open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)}>
        {editing !== undefined && (
          <DialogContent
            title={editing === 'new' ? t('collections.new') : collection.label}
            closeLabel={t('common.cancel')}
          >
            <EntryForm
              collection={collection}
              entry={editing === 'new' ? undefined : editing}
              onDone={done}
            />
          </DialogContent>
        )}
      </Dialog>
      <Dialog open={defining} onOpenChange={setDefining}>
        {defining && (
          <DialogContent
            title={t('collections.define')}
            closeLabel={t('common.cancel')}
            className="max-w-3xl"
          >
            <CollectionForm
              collection={collection}
              onDone={() => {
                setDefining(false);
                onChanged();
              }}
            />
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

export function Collections() {
  const { t } = useI18n();
  const { key } = useParams();
  const site = useSite();
  const navigate = useNavigate();
  const list = useApi<Collection[]>(site.path('/collections'));
  const [creating, setCreating] = useState(false);
  if (list.error) return <ErrorNote error={list.error} />;
  if (!list.data) return <Loading />;
  const current = list.data.find((c) => c.key === key);
  if (current) {
    return <Entries key={current.key} collection={current} onChanged={list.reload} />;
  }
  return (
    <>
      <PageHeader title={t('nav.collections')}>
        {site.atLeast('editor') && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            {t('collections.newCollection')}
          </Button>
        )}
      </PageHeader>
      <Dialog open={creating} onOpenChange={setCreating}>
        {creating && (
          <DialogContent
            title={t('collections.newCollection')}
            closeLabel={t('common.cancel')}
            className="max-w-3xl"
          >
            <CollectionForm
              onDone={(created) => {
                setCreating(false);
                list.reload();
                void navigate(site.to(`/collections/${created}`));
              }}
            />
          </DialogContent>
        )}
      </Dialog>
      {list.data.length === 0 ? (
        <p className="px-4 py-10 text-sm text-muted md:px-6">{t('collections.none')}</p>
      ) : (
        <ul className="border-t border-rule">
          {list.data.map((c) => (
            <li key={c.key} className="border-b border-rule">
              <Link
                to={site.to(`/collections/${c.key}`)}
                className="flex h-12 items-center gap-3 px-4 hover:bg-raised md:px-6"
              >
                <span className="font-medium">{c.label}</span>
                <span className="font-mono text-xs text-muted">{c.key}</span>
                <span className="ml-auto text-[13px] text-muted">
                  {t('forms.fieldCount', { n: c.fields.length })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
