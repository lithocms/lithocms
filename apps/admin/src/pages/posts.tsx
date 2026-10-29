import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ErrorNote, Loading, PageHeader } from '@/components/shell';
import { StatusPill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, useApi } from '@/lib/api';
import { useFormat, useI18n } from '@/lib/i18n';
import { useSite } from '@/lib/session';
import type { Page, Post, PostStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

const FILTERS: (PostStatus | 'all')[] = ['all', 'published', 'draft', 'scheduled', 'trash'];

export function PostList({ type }: { type: 'post' | 'page' }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const site = useSite();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? 'all') as PostStatus | 'all';
  const query = params.get('q') ?? '';
  const qs = new URLSearchParams({ type, limit: '50' });
  if (status !== 'all') qs.set('status', status);
  if (query) qs.set('query', query);
  const list = useApi<Page<Post>>(site.path(`/posts?${qs}`));
  const [more, setMore] = useState<{ key: string; items: Post[]; cursor: string | null }>();
  const key = qs.toString();
  const extra = more?.key === key ? more : undefined;
  const items = [...(list.data?.items ?? []), ...(extra?.items ?? [])];
  const cursor = extra ? extra.cursor : (list.data?.nextCursor ?? null);

  const loadMore = async () => {
    if (!cursor) return;
    const next = await api<Page<Post>>(
      site.path(`/posts?${key}&cursor=${encodeURIComponent(cursor)}`),
    );
    setMore({ key, items: [...(extra?.items ?? []), ...next.items], cursor: next.nextCursor });
  };
  const setParam = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader title={t(type === 'post' ? 'nav.posts' : 'nav.pages')}>
        <Button variant="primary" asChild>
          <Link to={site.to(`/posts/new?type=${type}`)}>
            <Plus aria-hidden="true" />
            {t(type === 'post' ? 'posts.new' : 'pages.new')}
          </Link>
        </Button>
      </PageHeader>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-rule px-4 md:px-6">
        <div className="-mb-px flex gap-4 overflow-x-auto" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={status === f}
              onClick={() => setParam('status', f)}
              className={cn(
                'h-9 cursor-pointer border-b-2 border-transparent text-sm whitespace-nowrap text-muted hover:text-ink',
                status === f && 'border-ink font-medium text-ink',
              )}
            >
              {t(`status.${f}`)}
            </button>
          ))}
        </div>
        <Input
          type="search"
          aria-label={t('common.search')}
          placeholder={t('common.search')}
          defaultValue={query}
          onChange={(e) => setParam('q', e.target.value)}
          className="mb-2 h-8 w-full sm:w-64"
        />
      </div>
      {list.error ? (
        <ErrorNote error={list.error} />
      ) : list.loading && !list.data ? (
        <Loading />
      ) : items.length === 0 ? (
        <p className="px-4 py-10 text-sm text-muted md:px-6">
          {status === 'all' && !query
            ? t(type === 'post' ? 'posts.empty' : 'pages.empty')
            : t('posts.emptyFilter')}
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="h-10 border-b border-rule text-left text-xs text-muted">
              <th className="pl-4 font-normal md:pl-6">{t('posts.title')}</th>
              <th className="w-32 font-normal">{t('posts.status')}</th>
              <th className="hidden w-44 pr-6 text-right font-normal sm:table-cell">
                {t('posts.updated')}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} className="h-12 border-b border-rule hover:bg-raised">
                <td className="max-w-0 pr-3 pl-4 md:pl-6">
                  <Link
                    to={site.to(`/posts/${p.id}`)}
                    className="block truncate font-medium hover:underline"
                  >
                    {p.title}
                  </Link>
                  <span className="block truncate font-mono text-xs text-muted">/{p.slug}/</span>
                </td>
                <td>
                  <StatusPill status={p.status} />
                </td>
                <td className="hidden pr-6 text-right text-muted sm:table-cell">
                  {fmt.date(p.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor && (
        <div className="px-4 py-4 md:px-6">
          <Button variant="outline" onClick={() => void loadMore()}>
            {t('common.more')}
          </Button>
        </div>
      )}
    </>
  );
}
