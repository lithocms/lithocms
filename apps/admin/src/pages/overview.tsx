import { PenLine } from 'lucide-react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/shell';
import { StatusPill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/api';
import { useFormat, useI18n } from '@/lib/i18n';
import { useSite } from '@/lib/session';
import type { Form, Page, Post, Submission } from '@/lib/types';
import { plain } from '@/lib/utils';

function Panel({ title, to, children }: { title: string; to: string; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <section className="min-w-0 rounded-card border border-border">
      <div className="flex h-11 items-center justify-between border-b border-rule px-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Link to={to} className="text-[13px] text-muted hover:text-ink hover:underline">
          {t('overview.viewAll')}
        </Link>
      </div>
      {children}
    </section>
  );
}

function PostRows({
  items,
  empty,
  date,
}: {
  items: Post[] | undefined;
  empty: string;
  date: (p: Post) => string;
}) {
  const site = useSite();
  if (!items) return <p className="px-4 py-3 text-sm text-muted">…</p>;
  if (!items.length) return <p className="px-4 py-4 text-sm text-muted">{empty}</p>;
  return (
    <ul>
      {items.map((p) => (
        <li key={p.id} className="border-b border-rule last:border-0">
          <Link
            to={site.to(`/${p.type}s/${p.id}`)}
            className="flex h-11 items-center gap-3 px-4 hover:bg-raised"
          >
            <span className="min-w-0 flex-1 truncate text-sm">{p.title}</span>
            {p.type === 'page' && <StatusPill status={p.status} />}
            <span className="shrink-0 text-[13px] text-muted">{date(p)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Answers "what needs me today": unfinished drafts and people waiting for a reply. */
export function Overview() {
  const { t } = useI18n();
  const fmt = useFormat();
  const site = useSite();
  const drafts = useApi<Page<Post>>(site.path('/posts?status=draft&limit=6'));
  const recent = useApi<Page<Post>>(site.path('/posts?type=post&status=published&limit=6'));
  const forms = useApi<Form[]>(site.atLeast('admin') ? site.path('/forms') : null);
  const firstForm = forms.data?.[0];
  const submissions = useApi<Submission[]>(
    firstForm ? site.path(`/forms/${firstForm.key}/submissions?status=new&limit=6`) : null,
  );

  return (
    <>
      <PageHeader title={site.name}>
        <Button variant="primary" asChild>
          <Link to={site.to('/posts/new')}>
            <PenLine aria-hidden="true" />
            {t('overview.write')}
          </Link>
        </Button>
      </PageHeader>
      <div className="grid gap-6 px-4 pb-8 md:px-6 lg:grid-cols-2">
        <Panel title={t('overview.drafts')} to={site.to('/posts?status=draft')}>
          <PostRows
            items={drafts.data?.items}
            empty={t('overview.noDrafts')}
            date={(p) => fmt.date(p.updatedAt)}
          />
        </Panel>
        {firstForm && (
          <Panel title={t('overview.submissions')} to={site.to(`/forms/${firstForm.key}`)}>
            {!submissions.data ? (
              <p className="px-4 py-3 text-sm text-muted">…</p>
            ) : submissions.data.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted">{t('overview.noSubmissions')}</p>
            ) : (
              <ul>
                {submissions.data.map((s) => {
                  const first = firstForm.fields[0];
                  return (
                    <li key={s.id} className="border-b border-rule last:border-0">
                      <Link
                        to={site.to(`/forms/${firstForm.key}`)}
                        className="flex h-11 items-center gap-3 px-4 hover:bg-raised"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {(first && plain(s.data[first.key])) || '—'}
                        </span>
                        <span className="shrink-0 text-[13px] text-muted">
                          {fmt.dateTime(s.createdAt)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        )}
        <Panel title={t('overview.recent')} to={site.to('/posts?status=published')}>
          <PostRows
            items={recent.data?.items}
            empty={t('overview.noRecent')}
            date={(p) => (p.publishedAt ? fmt.date(p.publishedAt) : '—')}
          />
        </Panel>
      </div>
    </>
  );
}
