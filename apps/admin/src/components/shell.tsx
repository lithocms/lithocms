import {
  Bot,
  ExternalLink,
  FileText,
  Files,
  Image,
  LayoutGrid,
  LogOut,
  Menu as MenuIcon,
  Inbox,
  Palette,
  Rows3,
  Settings,
  SquareMenu,
  X,
} from 'lucide-react';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useI18n, type Locale } from '@/lib/i18n';
import { useSession, useSite } from '@/lib/session';
import { cn } from '@/lib/utils';

/** The product's mark: an L cut from a stone block. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-6', className)} aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#2b2a27" />
      <path d="M9 7v18h14v-4H13V7z" fill="#f7f7f5" />
    </svg>
  );
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const site = useSite();
  const item = (to: string, icon: ReactNode, text: string, end = false) => (
    <NavLink
      to={site.to(to)}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex h-8 items-center gap-2.5 rounded-[8px] px-2.5 text-sm text-[#4f4f4b] hover:bg-active/60 hover:text-ink [&_svg]:size-4 [&_svg]:text-muted',
          isActive && 'bg-active text-ink',
        )
      }
    >
      {icon}
      {text}
    </NavLink>
  );
  return (
    <nav className="grid gap-0.5" aria-label={t('nav.menu')}>
      {item('', <LayoutGrid />, t('nav.overview'), true)}
      <p className="mt-5 mb-1 px-2.5 text-xs text-muted">{t('nav.content')}</p>
      {item('/posts', <FileText />, t('nav.posts'))}
      {item('/pages', <Files />, t('nav.pages'))}
      {item('/media', <Image />, t('nav.media'))}
      {item('/collections', <Rows3 />, t('nav.collections'))}
      {site.atLeast('admin') && item('/forms', <Inbox />, t('nav.forms'))}
      <p className="mt-5 mb-1 px-2.5 text-xs text-muted">{t('nav.site')}</p>
      {site.atLeast('editor') && item('/menus', <SquareMenu />, t('nav.menus'))}
      {site.atLeast('admin') && item('/theme', <Palette />, t('nav.theme'))}
      {site.atLeast('admin') && item('/settings', <Settings />, t('nav.settings'))}
      {item('/claude', <Bot />, t('nav.claude'))}
    </nav>
  );
}

function SiteSwitcher() {
  const { me } = useSession();
  const site = useSite();
  const navigate = useNavigate();
  if (me.sites.length < 2) {
    return (
      <p className="truncate px-2.5 text-sm font-medium" translate="no">
        {site.name}
      </p>
    );
  }
  return (
    <Select
      aria-label={site.name}
      value={site.id}
      onChange={(e) => void navigate(`/sites/${e.target.value}`)}
      className="h-8 border-transparent bg-transparent font-medium hover:border-control"
    >
      {me.sites.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </Select>
  );
}

function Account() {
  const { t, locale, setLocale } = useI18n();
  const { me, reload } = useSession();
  const signOut = async () => {
    await api('/auth/sign-out', { method: 'POST', body: {} }).catch(() => undefined);
    reload();
  };
  return (
    <div className="flex items-center gap-1">
      <Select
        aria-label={t('settings.locale')}
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="h-8 w-auto border-transparent bg-transparent text-[13px] text-muted hover:border-control"
      >
        <option value="tr">TR</option>
        <option value="en">EN</option>
      </Select>
      <span className="hidden max-w-48 truncate px-2 text-[13px] text-muted md:inline">
        {me.user.email}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t('nav.signOut')}
        title={t('nav.signOut')}
        onClick={() => void signOut()}
      >
        <LogOut />
      </Button>
    </div>
  );
}

export function Shell() {
  const { t } = useI18n();
  const site = useSite();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[228px_1fr] md:grid-rows-[48px_1fr]">
      <a
        href="#main"
        className="sr-only z-50 rounded-control bg-ink px-3 py-2 text-white focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t('nav.content')}
      </a>
      {/* Sidebar on the frame; on a phone it opens over the screen. */}
      <aside
        className={cn(
          'fixed inset-0 z-30 flex-col gap-4 overflow-y-auto overscroll-contain bg-frame px-3 pt-3 pb-6 md:sticky md:top-0 md:row-span-2 md:flex md:h-dvh',
          open ? 'flex' : 'hidden',
        )}
      >
        <div className="flex h-8 items-center justify-between gap-2 px-1.5">
          <span className="flex items-center gap-2 font-semibold" translate="no">
            <Mark />
            LithoCMS
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label={t('common.cancel')}
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        </div>
        <SiteSwitcher />
        <Nav onNavigate={() => setOpen(false)} />
      </aside>
      <header className="sticky top-0 z-20 flex h-12 items-center gap-2 bg-frame px-2 md:static md:pr-4 md:pl-2">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label={t('nav.menu')}
          onClick={() => setOpen(true)}
        >
          <MenuIcon />
        </Button>
        <span className="truncate font-medium md:hidden" translate="no">
          {site.name}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {site.url && (
            <Button variant="ghost" size="sm" asChild>
              <a href={site.url} target="_blank" rel="noreferrer">
                <ExternalLink />
                <span className="hidden sm:inline">{t('nav.viewSite')}</span>
              </a>
            </Button>
          )}
          <Account />
        </div>
      </header>
      <main
        id="main"
        className="min-w-0 bg-sheet md:mr-2 md:mb-2 md:rounded-sheet md:border md:border-border"
      >
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}

/** The title row every screen starts with: a noun at 22px and the screen's main action. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 px-4 pt-5 pb-3 md:px-6">
      <h1 className="text-title leading-tight font-semibold">{title}</h1>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: { status: number } }) {
  const { t } = useI18n();
  return (
    <p role="alert" className="mx-4 my-6 text-sm text-negative md:mx-6">
      {error.status === 403 ? t('common.forbidden') : t('common.error')}
    </p>
  );
}

export function Loading() {
  const { t } = useI18n();
  return (
    <p className="mx-4 my-6 text-sm text-muted md:mx-6" aria-live="polite">
      {t('common.loading')}
    </p>
  );
}
