import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useParams } from 'react-router';
import { ErrorNote, Loading, PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, ApiError, useApi, type Issue } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSite } from '@/lib/session';
import type { Term } from '@/lib/types';
import { cn } from '@/lib/utils';

type Taxonomy = Term['taxonomy'];

function TermForm({
  taxonomy,
  term,
  all,
  onDone,
}: {
  taxonomy: Taxonomy;
  term?: Term;
  all: Term[];
  onDone: () => void;
}) {
  const { t } = useI18n();
  const site = useSite();
  const [name, setName] = useState(term?.name ?? '');
  const [slug, setSlug] = useState(term?.slug ?? '');
  const [parentId, setParentId] = useState(term?.parentId ?? '');
  const [description, setDescription] = useState(term?.description ?? '');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // A category cannot move under itself or anything below it.
  const parents = all.filter(
    (c) => !term || (c.id !== term.id && !c.path.startsWith(`${term.path}/`)),
  );

  const fail = (err: unknown) =>
    setIssues(
      err instanceof ApiError
        ? err.issues.length
          ? err.issues
          : [{ path: [], message: err.message }]
        : [{ path: [], message: t('common.error') }],
    );

  const save = async () => {
    setBusy(true);
    setIssues([]);
    try {
      const body = {
        name,
        description,
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        ...(taxonomy === 'category' ? { parentId: parentId || null } : {}),
      };
      await api(term ? site.path(`/terms/${term.id}`) : site.path('/terms'), {
        method: term ? 'PATCH' : 'POST',
        body: term ? body : { ...body, taxonomy },
      });
      onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!term) return;
    if (!confirm) return setConfirm(true);
    setBusy(true);
    try {
      await api(site.path(`/terms/${term.id}`), { method: 'DELETE' });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setIssues([{ path: [], message: t('terms.hasChildren') }]);
      } else fail(err);
      setBusy(false);
    }
  };

  const errorFor = (key: string) => issues.find((i) => i.path[0] === key)?.message;
  const other = issues.filter((i) => !['name', 'slug', 'parentId'].includes(String(i.path[0])));
  return (
    <form
      className="grid gap-4 overflow-y-auto p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label={t('terms.name')} htmlFor="term-name" error={errorFor('name')}>
        <Input
          id="term-name"
          name="term-name"
          autoComplete="off"
          // The dialog opens to type a name.
          autoFocus
          required
          maxLength={200}
          value={name}
          aria-invalid={errorFor('name') ? true : undefined}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field
        label={t('editor.slug')}
        hint={t('terms.slugHint')}
        htmlFor="term-slug"
        error={errorFor('slug')}
      >
        <Input
          id="term-slug"
          name="term-slug"
          autoComplete="off"
          spellCheck={false}
          maxLength={100}
          value={slug}
          aria-invalid={errorFor('slug') ? true : undefined}
          onChange={(e) => setSlug(e.target.value)}
          className="font-mono"
        />
      </Field>
      {taxonomy === 'category' && (
        <Field label={t('terms.parent')} htmlFor="term-parent" error={errorFor('parentId')}>
          <Select id="term-parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">{t('terms.topLevel')}</option>
            {parents.map((c) => (
              <option key={c.id} value={c.id}>
                {'— '.repeat(c.path.split('/').length - 1) + c.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={t('terms.description')} htmlFor="term-description">
        <Textarea
          id="term-description"
          name="term-description"
          maxLength={5000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      {other.length > 0 && (
        <p role="alert" className="text-[13px] text-negative">
          {other.map((i) => i.message).join(' ')}
        </p>
      )}
      {confirm && other.length === 0 && (
        <p className="text-[13px] text-muted" aria-live="polite">
          {t('terms.deleteHint')}
        </p>
      )}
      <div className="flex items-center gap-2 border-t border-rule pt-4">
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          {busy ? t('common.saving') : t('common.save')}
        </Button>
        {term && (
          <Button
            type="button"
            variant="danger"
            className="ml-auto"
            disabled={busy}
            onClick={() => void remove()}
          >
            <Trash2 aria-hidden="true" />
            {confirm ? t('terms.confirmDelete') : t('common.delete')}
          </Button>
        )}
      </div>
    </form>
  );
}

/** Categories (nested) and tags: what posts are filed under. Editors and up. */
export function Terms() {
  const { t } = useI18n();
  const site = useSite();
  const taxonomy: Taxonomy = useParams().taxonomy === 'tags' ? 'tag' : 'category';
  const list = useApi<Term[]>(site.path(`/terms?taxonomy=${taxonomy}`));
  const [editing, setEditing] = useState<Term | 'new'>();
  const done = () => {
    setEditing(undefined);
    list.reload();
  };
  const tab = (to: string, text: string) => (
    <NavLink
      to={site.to(to)}
      end
      className={({ isActive }) =>
        cn(
          'flex h-8 items-center rounded-control px-3 text-sm text-muted hover:text-ink',
          isActive && 'bg-active text-ink',
        )
      }
    >
      {text}
    </NavLink>
  );

  return (
    <>
      <PageHeader title={t('nav.terms')}>
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus aria-hidden="true" />
          {t(taxonomy === 'category' ? 'terms.newCategory' : 'terms.newTag')}
        </Button>
      </PageHeader>
      <nav className="flex gap-1 px-4 pb-3 md:px-6" aria-label={t('nav.terms')}>
        {tab('/terms', t('terms.categories'))}
        {tab('/terms/tags', t('terms.tags'))}
      </nav>
      {list.error ? (
        <ErrorNote error={list.error} />
      ) : !list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <p className="border-t border-rule px-4 py-10 text-sm text-muted md:px-6">
          {t(taxonomy === 'category' ? 'terms.noCategories' : 'terms.noTags')}
        </p>
      ) : (
        <ul className="border-t border-rule">
          {list.data.map((term) => (
            <li key={term.id} className="border-b border-rule">
              <button
                type="button"
                onClick={() => setEditing(term)}
                className="flex min-h-12 w-full cursor-pointer items-center gap-3 px-4 py-2 text-left hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink md:px-6"
              >
                <span
                  className="min-w-0 font-medium break-words"
                  // Nesting shows as indentation: 20px per level.
                  style={{ marginInlineStart: `${(term.path.split('/').length - 1) * 20}px` }}
                >
                  {term.name}
                </span>
                <span className="ml-auto font-mono text-xs text-muted" translate="no">
                  /{term.path}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)}>
        {editing !== undefined && (
          <DialogContent
            title={
              editing === 'new'
                ? t(taxonomy === 'category' ? 'terms.newCategory' : 'terms.newTag')
                : editing.name
            }
            closeLabel={t('common.cancel')}
          >
            <TermForm
              taxonomy={taxonomy}
              term={editing === 'new' ? undefined : editing}
              all={taxonomy === 'category' ? (list.data ?? []) : []}
              onDone={done}
            />
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
