import { ArrowDown, ArrowLeft, ArrowUp, ExternalLink, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ImageField } from '@/components/media-picker';
import { Revisions } from '@/components/revisions';
import { RichText } from '@/components/rich-text';
import { compactSection, SectionFields, type SectionData } from '@/components/settings-form';
import { ErrorNote, Loading } from '@/components/shell';
import { StatusPill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, ApiError, useApi, type Issue } from '@/lib/api';
import { mediaIds, type PMNode } from '@/lib/doc';
import { useFormat, useI18n, useLabel } from '@/lib/i18n';
import { useSite } from '@/lib/session';
import type { Media, Post, Section, Term, Theme } from '@/lib/types';

type Draft = Pick<
  Post,
  | 'title'
  | 'slug'
  | 'excerpt'
  | 'content'
  | 'template'
  | 'sections'
  | 'featuredMediaId'
  | 'termIds'
  | 'seo'
>;

const EMPTY: Draft = {
  title: '',
  slug: '',
  excerpt: '',
  content: { type: 'doc', content: [] },
  template: null,
  sections: null,
  featuredMediaId: null,
  termIds: [],
  seo: {},
};

/** `datetime-local` value (the browser's time zone) for an ISO date. */
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/** Loads the post (or a blank one) and the URLs of the images in its body. */
function usePost(postId: string, version: number) {
  const site = useSite();
  const [state, setState] = useState<{
    post?: Post;
    srcs?: Record<string, string>;
    error?: ApiError;
  }>({});
  useEffect(() => {
    if (postId === 'new') return setState({ srcs: {} });
    let live = true;
    (async () => {
      const post = await api<Post>(site.path(`/posts/${postId}`));
      const media = await Promise.all(
        mediaIds(post.content as PMNode).map((id) =>
          api<Media>(site.path(`/media/${id}`)).catch(() => null),
        ),
      );
      const srcs = Object.fromEntries(
        media.filter((m) => m !== null).map((m) => [m.id, site.media(m.path)]),
      );
      if (live) setState({ post, srcs });
    })().catch((error: ApiError) => live && setState({ error }));
    return () => {
      live = false;
    };
  }, [postId, site.id, version]);
  return state;
}

/** Posts open under /posts, pages under /pages, so the navigation shows where you are. */
export function PostEditor({ type: routeType }: { type: 'post' | 'page' }) {
  const { postId = 'new' } = useParams();
  // Bumped after a revision is restored: reload the post and start the form afresh.
  const [version, setVersion] = useState(0);
  const loaded = usePost(postId, version);
  if (loaded.error) return <ErrorNote error={loaded.error} />;
  if (!loaded.srcs) return <Loading />;
  const type = loaded.post?.type ?? routeType;
  return (
    <EditorForm
      key={`${loaded.post?.id ?? 'new'}:${loaded.post?.updatedAt ?? ''}`}
      post={loaded.post}
      type={type}
      srcs={loaded.srcs}
      onRestored={() => setVersion((v) => v + 1)}
    />
  );
}

function Side({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 border-b border-rule px-4 py-4 last:border-0">
      {title && <h2 className="text-sm font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

function EditorForm({
  post,
  type,
  srcs,
  onRestored,
}: {
  post?: Post;
  type: 'post' | 'page';
  srcs: Record<string, string>;
  onRestored: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const l = useLabel();
  const site = useSite();
  const navigate = useNavigate();
  const theme = useApi<Theme>(site.path('/theme'));
  const categories = useApi<Term[]>(type === 'post' ? site.path('/terms?taxonomy=category') : null);
  const tags = useApi<Term[]>(type === 'post' ? site.path('/terms?taxonomy=tag') : null);
  const [draft, setDraft] = useState<Draft>(() => (post ? { ...EMPTY, ...post } : EMPTY));
  const [status, setStatus] = useState(post?.status ?? 'draft');
  const [publishedAt, setPublishedAt] = useState(post?.publishedAt ?? null);
  // Empty publishes now; a future time schedules.
  const [publishAt, setPublishAt] = useState(() =>
    post?.status === 'scheduled' && post.publishedAt ? toLocalInput(post.publishedAt) : '',
  );
  const future = publishAt !== '' && new Date(publishAt) > new Date();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [notice, setNotice] = useState('');
  const [newTag, setNewTag] = useState('');

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
    setNotice('');
  };
  const errorFor = (field: string) => issues.find((i) => i.path[0] === field)?.message;
  const templates = theme.data?.pageTemplates ?? [];
  const template = templates.find((tpl) => tpl.key === `page.${draft.template}`);
  const sectionTypes = theme.data?.sections ?? [];

  const body = () => {
    const categoryIds = new Set(categories.data?.map((c) => c.id));
    return {
      title: draft.title,
      ...(draft.slug ? { slug: draft.slug } : {}),
      excerpt: draft.excerpt,
      content: draft.content,
      featuredMediaId: draft.featuredMediaId,
      seo: draft.seo,
      ...(type === 'page'
        ? {
            template: draft.template,
            sections: template?.sections
              ? (draft.sections ?? []).map((s) => ({ type: s.type, ...compactSection(s) }))
              : null,
          }
        : {
            termIds: draft.termIds,
            primaryCategoryId: draft.termIds.find((id) => categoryIds.has(id)) ?? null,
          }),
    };
  };

  const save = async (action?: 'publish' | 'unpublish' | 'trash') => {
    setBusy(true);
    setIssues([]);
    try {
      let saved = post
        ? await api<Post>(site.path(`/posts/${post.id}`), { method: 'PATCH', body: body() })
        : await api<Post>(site.path('/posts'), { method: 'POST', body: { type, ...body() } });
      if (action)
        saved = await api<Post>(site.path(`/posts/${saved.id}/${action}`), {
          method: 'POST',
          body: action === 'publish' && future ? { at: new Date(publishAt).toISOString() } : {},
        });
      setDirty(false);
      if (action === 'trash') return void navigate(site.to(type === 'post' ? '/posts' : '/pages'));
      setStatus(saved.status);
      setPublishedAt(saved.publishedAt);
      if (saved.status !== 'scheduled') setPublishAt('');
      setDraft((d) => ({ ...d, slug: saved.slug }));
      setNotice(t('common.saved'));
      if (!post) void navigate(site.to(`/${type}s/${saved.id}`), { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setIssues(
          err.issues.length
            ? err.issues
            : [{ path: [], message: err.status === 403 ? t('common.forbidden') : err.message }],
        );
      } else setIssues([{ path: [], message: t('common.error') }]);
    } finally {
      setBusy(false);
    }
  };

  const addTag = async () => {
    const name = newTag.trim();
    if (!name) return;
    const term = await api<Term>(site.path('/terms'), {
      method: 'POST',
      body: { taxonomy: 'tag', name },
    });
    tags.set([...(tags.data ?? []), term]);
    set('termIds', [...draft.termIds, term.id]);
    setNewTag('');
  };
  const toggleTerm = (id: string, on: boolean) =>
    set('termIds', on ? [...draft.termIds, id] : draft.termIds.filter((x) => x !== id));

  const sections = draft.sections ?? [];
  const setSections = (next: Section[]) => set('sections', next);
  const moveSection = (i: number, by: number) => {
    const next = [...sections];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s!);
    setSections(next);
  };
  const general = issues.filter((i) => !['title', 'slug', 'excerpt'].includes(String(i.path[0])));
  const publicUrl = useMemo(
    () => (post && site.url && status === 'published' ? `${site.url}/${draft.slug}/` : null),
    [post, site.url, status, draft.slug],
  );

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-12 z-20 flex h-12 items-center gap-2 border-b border-rule bg-sheet px-2 md:top-0 md:rounded-t-sheet md:px-3">
        <Button variant="ghost" size="icon" asChild>
          <Link to={site.to(type === 'post' ? '/posts' : '/pages')} aria-label={t('editor.back')}>
            <ArrowLeft />
          </Link>
        </Button>
        <span className="mr-auto flex min-w-0 items-center gap-2">
          <span className="hidden truncate text-sm font-medium sm:inline">
            {draft.title || t(type === 'post' ? 'posts.new' : 'pages.new')}
          </span>
          <StatusPill status={status} />
        </span>
        <span aria-live="polite" className="text-[13px] text-muted">
          {busy ? t('common.saving') : notice || (dirty ? t('common.unsaved') : '')}
        </span>
        {publicUrl && (
          <Button variant="ghost" size="icon" asChild>
            <a
              href={publicUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={t('editor.view')}
              title={t('editor.view')}
            >
              <ExternalLink />
            </a>
          </Button>
        )}
        {status === 'published' ? (
          <>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void save('unpublish')}
              className="hidden sm:inline-flex"
            >
              {t('editor.unpublish')}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {t('editor.update')}
            </Button>
          </>
        ) : (
          <>
            <Button disabled={busy} onClick={() => void save()}>
              {status === 'scheduled' ? t('common.save') : t('editor.saveDraft')}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void save('publish')}>
              {future ? t('editor.schedule') : t('editor.publish')}
            </Button>
          </>
        )}
      </div>

      {general.length > 0 && (
        <ul
          role="alert"
          className="mx-4 mt-4 grid gap-1 rounded-card bg-[#ffedea] px-4 py-3 text-[13px] text-[#831c1e] md:mx-6"
        >
          {general.map((i, n) => (
            <li key={n}>
              {i.path.length ? <span className="font-mono">{i.path.join('.')}: </span> : null}
              {i.message}
            </li>
          ))}
        </ul>
      )}

      <div className="grid flex-1 lg:grid-cols-[1fr_320px]">
        <div className="mx-auto w-full max-w-[720px] min-w-0 pt-8 pb-16 md:px-6">
          <textarea
            aria-label={t('posts.title')}
            placeholder={t('editor.titlePlaceholder')}
            value={draft.title}
            rows={1}
            onChange={(e) => set('title', e.target.value.replace(/\n/g, ' '))}
            className="field-sizing-content w-full resize-none bg-transparent px-4 text-[30px] leading-tight font-semibold outline-none placeholder:text-control md:px-0"
          />
          {errorFor('title') && (
            <p className="px-4 text-[13px] text-negative md:px-0">{errorFor('title')}</p>
          )}
          <RichText
            initial={post?.content ?? null}
            srcOf={(id) => srcs[id] ?? ''}
            placeholder={t('editor.bodyPlaceholder')}
            onChange={(doc) => set('content', doc)}
          />

          {template?.sections && (
            <section className="mt-6 grid gap-3 border-t border-rule px-4 pt-6 md:px-0">
              <h2 className="text-section font-semibold">{t('editor.sections')}</h2>
              {sections.map((s, i) => {
                const schema = sectionTypes.find((x) => x.name === s.type)?.schema;
                return (
                  <div key={i} className="rounded-card border border-border">
                    <div className="flex h-11 items-center gap-1 pr-1 pl-3 text-sm font-medium">
                      <span className="mr-auto">
                        {i + 1}. {l(schema?.name, s.type)}
                      </span>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t('common.moveUp')}
                        disabled={i === 0}
                        onClick={() => moveSection(i, -1)}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t('common.moveDown')}
                        disabled={i === sections.length - 1}
                        onClick={() => moveSection(i, 1)}
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="danger"
                        aria-label={t('common.remove')}
                        onClick={() => setSections(sections.filter((_, j) => j !== i))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <div className="border-t border-rule p-4">
                      {schema && (
                        <SectionFields
                          schema={schema}
                          value={s}
                          onChange={(v: SectionData) =>
                            setSections(
                              sections.map((x, j) => (j === i ? { type: x.type, ...v } : x)),
                            )
                          }
                        />
                      )}
                    </div>
                  </div>
                );
              })}
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  aria-label={t('editor.addSection')}
                  value=""
                  className="w-auto"
                  onChange={(e) =>
                    e.target.value &&
                    setSections([...sections, { type: e.target.value, settings: {}, blocks: [] }])
                  }
                >
                  <option value="">{t('editor.addSection')}…</option>
                  {sectionTypes.map((s) => (
                    <option key={s.name} value={s.name}>
                      {l(s.schema.name, s.name)}
                    </option>
                  ))}
                </Select>
                <Plus className="size-4 text-muted" aria-hidden="true" />
              </div>
            </section>
          )}
        </div>

        <aside className="border-t border-rule lg:border-t-0 lg:border-l">
          {status !== 'published' && status !== 'trash' && (
            <Side title={t('editor.publishing')}>
              {status === 'scheduled' && publishedAt && (
                <p className="text-sm">
                  {t('editor.scheduledFor', { d: fmt.dateTime(publishedAt) })}
                </p>
              )}
              <Field
                label={t('editor.publishAt')}
                hint={t('editor.publishAtHint')}
                htmlFor="publish-at"
              >
                <Input
                  id="publish-at"
                  type="datetime-local"
                  value={publishAt}
                  onChange={(e) => {
                    setPublishAt(e.target.value);
                    setNotice('');
                  }}
                />
              </Field>
              {status === 'scheduled' && (
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void save('unpublish')}
                  >
                    {t('editor.cancelSchedule')}
                  </Button>
                </div>
              )}
            </Side>
          )}
          <Side>
            <Field
              label={t('editor.slug')}
              hint={t('editor.slugHint')}
              error={errorFor('slug')}
              htmlFor="slug"
            >
              <Input
                id="slug"
                value={draft.slug}
                spellCheck={false}
                autoComplete="off"
                className="font-mono"
                onChange={(e) => set('slug', e.target.value.toLowerCase())}
              />
            </Field>
            {type === 'page' && templates.length > 0 && (
              <Field label={t('editor.template')} htmlFor="template">
                <Select
                  id="template"
                  value={draft.template ?? ''}
                  onChange={(e) => set('template', e.target.value || null)}
                >
                  <option value="">{t('editor.templateDefault')}</option>
                  {templates.map((tpl) => (
                    <option key={tpl.key} value={tpl.key.replace(/^page\./, '')}>
                      {l(tpl.label, tpl.key)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </Side>
          <Side title={t('editor.featured')}>
            <ImageField
              value={draft.featuredMediaId}
              onChange={(id) => set('featuredMediaId', id)}
            />
          </Side>
          {type === 'post' && (
            <Side title={t('editor.categories')}>
              <div className="grid max-h-48 gap-1 overflow-y-auto">
                {categories.data?.map((c) => (
                  <label
                    key={c.id}
                    className="flex min-h-7 cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-ink"
                      checked={draft.termIds.includes(c.id)}
                      onChange={(e) => toggleTerm(c.id, e.target.checked)}
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            </Side>
          )}
          {type === 'post' && (
            <Side title={t('editor.tags')}>
              <div className="flex flex-wrap gap-1.5">
                {tags.data?.map((tag) => {
                  const on = draft.termIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      aria-pressed={on}
                      onClick={() => toggleTerm(tag.id, !on)}
                      className={`h-7 cursor-pointer rounded-full border px-2.5 text-[13px] ${on ? 'border-ink bg-ink text-white' : 'border-control hover:bg-raised'}`}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addTag();
                }}
              >
                <Input
                  aria-label={t('editor.newTerm')}
                  placeholder={t('editor.newTerm')}
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  className="h-8"
                />
                <Button type="submit" size="sm" variant="outline">
                  {t('common.add')}
                </Button>
              </form>
            </Side>
          )}
          <Side title={t('editor.excerpt')}>
            <Textarea
              aria-label={t('editor.excerpt')}
              value={draft.excerpt}
              aria-invalid={Boolean(errorFor('excerpt'))}
              onChange={(e) => set('excerpt', e.target.value)}
            />
          </Side>
          <Side title="SEO">
            <Field label={t('editor.seoTitle')} htmlFor="seo-title">
              <Input
                id="seo-title"
                value={draft.seo.title ?? ''}
                placeholder={draft.title}
                onChange={(e) => set('seo', { ...draft.seo, title: e.target.value || undefined })}
              />
            </Field>
            <Field label={t('editor.seoDescription')} htmlFor="seo-desc">
              <Textarea
                id="seo-desc"
                value={draft.seo.description ?? ''}
                placeholder={draft.excerpt}
                onChange={(e) =>
                  set('seo', { ...draft.seo, description: e.target.value || undefined })
                }
              />
            </Field>
          </Side>
          {post && (
            <Side title={t('revisions.title')}>
              <div>
                <Revisions postId={post.id} onRestored={onRestored} />
              </div>
            </Side>
          )}
          {post && status !== 'trash' && (
            <div className="px-4 py-4">
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t('editor.trashConfirm'))) void save('trash');
                }}
              >
                <Trash2 aria-hidden="true" />
                {t('editor.trash')}
              </Button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
