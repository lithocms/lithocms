import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Link2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ErrorNote, Loading, PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { api, ApiError, useApi } from '@/lib/api';
import { useI18n, useLabel } from '@/lib/i18n';
import { useSite } from '@/lib/session';
import type { MenuItem, Page, Post, Theme } from '@/lib/types';
import { cn } from '@/lib/utils';

const MAX_DEPTH = 2; // three levels

interface Row {
  item: Omit<MenuItem, 'children'>;
  depth: number;
}

const flatten = (items: MenuItem[], depth = 0): Row[] =>
  items.flatMap(({ children, ...item }) => [{ item, depth }, ...flatten(children, depth + 1)]);

/** Rebuilds the tree; a row can sit at most one level below the row above it. */
function nest(rows: Row[]): MenuItem[] {
  const root: MenuItem[] = [];
  const stack: MenuItem[][] = [root];
  let prev = -1;
  for (const row of rows) {
    const depth = Math.min(row.depth, prev + 1, MAX_DEPTH);
    const node: MenuItem = { ...row.item, children: [] };
    stack.length = depth + 1;
    stack[depth]!.push(node);
    stack[depth + 1] = node.children;
    prev = depth;
  }
  return root;
}

function MenuEditor({ location }: { location: string }) {
  const { t } = useI18n();
  const site = useSite();
  const menu = useApi<{ location: string; items: MenuItem[] }>(site.path(`/menus/${location}`));
  const pages = useApi<Page<Post>>(site.path('/posts?type=page&status=published&limit=50'));
  const [rows, setRows] = useState<Row[]>();
  const [state, setState] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (menu.data) setRows(flatten(menu.data.items));
    else if (menu.error?.status === 404) setRows([]);
  }, [menu.data, menu.error]);

  if (menu.error && menu.error.status !== 404) return <ErrorNote error={menu.error} />;
  if (!rows) return <Loading />;

  const update = (next: Row[]) => {
    setRows(next);
    setState(t('common.unsaved'));
  };
  const move = (i: number, by: number) => {
    const next = [...rows];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    update(next);
  };
  const shift = (i: number, by: number) =>
    update(
      rows.map((r, j) =>
        j === i ? { ...r, depth: Math.max(0, Math.min(r.depth + by, MAX_DEPTH)) } : r,
      ),
    );
  const edit = (i: number, patch: Partial<Row['item']>) =>
    update(rows.map((r, j) => (j === i ? { ...r, item: { ...r.item, ...patch } } : r)));

  const save = async () => {
    setBusy(true);
    try {
      const saved = await api<{ items: MenuItem[] }>(site.path(`/menus/${location}`), {
        method: 'PUT',
        body: { items: nest(rows) },
      });
      setRows(flatten(saved.items));
      setState(t('common.saved'));
    } catch (err) {
      setState(
        err instanceof ApiError
          ? err.issues.map((i) => i.message).join(' ') ||
              (err.status === 403 ? t('common.forbidden') : err.message)
          : t('common.error'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3 px-4 py-4 md:px-6">
      {rows.length === 0 && <p className="text-sm text-muted">{t('menus.empty')}</p>}
      <ol className="grid gap-1.5">
        {rows.map((r, i) => (
          <li
            key={r.item.id ?? `new-${i}`}
            style={{ marginLeft: `${Math.min(r.depth, MAX_DEPTH) * 28}px` }}
            className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-sheet p-2"
          >
            <Input
              aria-label={t('menus.label')}
              value={r.item.label}
              onChange={(e) => edit(i, { label: e.target.value })}
              className="h-8 w-48 flex-1 sm:flex-none"
            />
            {r.item.kind === 'url' ? (
              <Input
                aria-label={t('menus.url')}
                value={r.item.url ?? ''}
                spellCheck={false}
                inputMode="url"
                onChange={(e) => edit(i, { url: e.target.value })}
                className="h-8 min-w-40 flex-1 font-mono text-[13px]"
              />
            ) : (
              <span className="flex-1 truncate text-[13px] text-muted">
                {t('menus.page')}:{' '}
                {pages.data?.items.find((p) => p.id === r.item.ref)?.title ?? '—'}
              </span>
            )}
            <span className="ml-auto flex">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('common.outdent')}
                title={t('common.outdent')}
                disabled={r.depth === 0}
                onClick={() => shift(i, -1)}
              >
                <ArrowLeft />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('common.indent')}
                title={t('common.indent')}
                disabled={i === 0 || r.depth >= MAX_DEPTH || r.depth > rows[i - 1]!.depth}
                onClick={() => shift(i, 1)}
              >
                <ArrowRight />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('common.moveUp')}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('common.moveDown')}
                disabled={i === rows.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                size="icon-sm"
                variant="danger"
                aria-label={t('common.remove')}
                onClick={() => update(rows.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label={t('menus.addPage')}
          value=""
          className="h-8 w-auto"
          onChange={(e) => {
            const page = pages.data?.items.find((p) => p.id === e.target.value);
            if (page)
              update([
                ...rows,
                { item: { label: page.title, kind: 'post', ref: page.id }, depth: 0 },
              ]);
          }}
        >
          <option value="">{t('menus.addPage')}…</option>
          {pages.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            update([...rows, { item: { label: '', kind: 'url', url: '/' }, depth: 0 }])
          }
        >
          <Link2 aria-hidden="true" />
          {t('menus.addLink')}
        </Button>
      </div>
      <div className="flex items-center gap-3 border-t border-rule pt-4">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
        </Button>
        <span aria-live="polite" className="text-[13px] text-muted">
          {state}
        </span>
      </div>
    </div>
  );
}

export function Menus() {
  const { t } = useI18n();
  const l = useLabel();
  const site = useSite();
  const theme = useApi<Theme>(site.path('/theme'));
  const [params, setParams] = useSearchParams();
  if (theme.error) return <ErrorNote error={theme.error} />;
  if (!theme.data) return <Loading />;
  const locations = theme.data.menus;
  const current = params.get('location') ?? locations[0]?.location;
  return (
    <>
      <PageHeader title={t('nav.menus')} />
      <div
        className="-mb-px flex gap-4 overflow-x-auto border-b border-rule px-4 md:px-6"
        role="tablist"
      >
        {locations.map((m) => (
          <button
            key={m.location}
            role="tab"
            aria-selected={m.location === current}
            onClick={() => setParams({ location: m.location }, { replace: true })}
            className={cn(
              'h-9 cursor-pointer border-b-2 border-transparent text-sm whitespace-nowrap text-muted hover:text-ink',
              m.location === current && 'border-ink font-medium text-ink',
            )}
          >
            {l(m.label, m.location)}
          </button>
        ))}
      </div>
      {current && <MenuEditor key={current} location={current} />}
    </>
  );
}
