import { lazy, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Loading, Shell } from '@/components/shell';
import { useApi } from '@/lib/api';
import { I18nProvider } from '@/lib/i18n';
import { oauthQuery } from '@/lib/oauth';
import { SessionProvider, useSession } from '@/lib/session';
import type { Me } from '@/lib/types';
import { Login } from '@/pages/login';
import { AcceptInvite } from '@/pages/invite';
import { OAuthConsent, OAuthSite, ResumeAuthorization } from '@/pages/oauth';
import { Overview } from '@/pages/overview';
import { PostList } from '@/pages/posts';
import './index.css';
const ThemePage = lazy(() => import('@/pages/theme').then((m) => ({ default: m.ThemePage })));
const SiteSettingsPage = lazy(() =>
  import('@/pages/settings').then((m) => ({ default: m.SiteSettingsPage })),
);
const PostEditor = lazy(() =>
  import('@/pages/post-editor').then((m) => ({ default: m.PostEditor })),
);
const Menus = lazy(() => import('@/pages/menus').then((m) => ({ default: m.Menus })));
const MediaLibrary = lazy(() => import('@/pages/media').then((m) => ({ default: m.MediaLibrary })));
const Forms = lazy(() => import('@/pages/forms').then((m) => ({ default: m.Forms })));
const Collections = lazy(() =>
  import('@/pages/collections').then((m) => ({ default: m.Collections })),
);
const Redirects = lazy(() => import('@/pages/redirects').then((m) => ({ default: m.Redirects })));
const Slots = lazy(() => import('@/pages/slots').then((m) => ({ default: m.Slots })));
const Team = lazy(() => import('@/pages/team').then((m) => ({ default: m.Team })));
const AccountPage = lazy(() => import('@/pages/account').then((m) => ({ default: m.AccountPage })));
const Terms = lazy(() => import('@/pages/terms').then((m) => ({ default: m.Terms })));
const ClaudePage = lazy(() => import('@/pages/claude').then((m) => ({ default: m.ClaudePage })));

function KnownSite({ children }: { children: React.ReactNode }) {
  const { me } = useSession();
  const id = location.pathname.split('/')[2];
  if (!me.sites.some((s) => s.id === id)) return <Navigate to="/" replace />;
  return children;
}

function App() {
  const me = useApi<Me>(location.pathname === '/invite' ? null : '/me');
  // An invitation link: whoever opens it sets that account's password.
  if (location.pathname === '/invite') return <AcceptInvite />;
  if (me.loading && !me.data) return <Loading />;
  if (!me.data) return <Login onSignedIn={me.reload} />;
  // An app's authorization sent a signed-in user to sign in (unless it asked for a fresh one).
  const oauth = location.pathname === '/login' ? oauthQuery() : undefined;
  if (oauth) {
    const prompt = new URLSearchParams(oauth).get('prompt')?.split(' ') ?? [];
    if (prompt.includes('login')) return <Login onSignedIn={me.reload} />;
    return <ResumeAuthorization query={oauth} />;
  }
  const first = me.data.sites[0];
  return (
    <SessionProvider me={me.data} reload={me.reload}>
      <BrowserRouter>
        <Routes>
          <Route
            path="/"
            element={first ? <Navigate to={`/sites/${first.id}`} replace /> : <Loading />}
          />
          <Route
            path="/sites/:siteId"
            element={
              <KnownSite>
                <Shell />
              </KnownSite>
            }
          >
            <Route index element={<Overview />} />
            <Route path="posts" element={<PostList type="post" />} />
            <Route path="pages" element={<PostList type="page" />} />
            <Route path="posts/:postId" element={<PostEditor type="post" />} />
            <Route path="pages/:postId" element={<PostEditor type="page" />} />
            <Route path="terms/:taxonomy?" element={<Terms />} />
            <Route path="redirects" element={<Redirects />} />
            <Route path="slots" element={<Slots />} />
            <Route path="team" element={<Team />} />
            <Route path="account" element={<AccountPage />} />
            <Route path="media" element={<MediaLibrary />} />
            <Route path="menus" element={<Menus />} />
            <Route path="collections/:key?" element={<Collections />} />
            <Route path="forms/:key?" element={<Forms />} />
            <Route path="theme" element={<ThemePage />} />
            <Route path="settings" element={<SiteSettingsPage />} />
            <Route path="claude" element={<ClaudePage />} />
          </Route>
          <Route path="/oauth/site" element={<OAuthSite />} />
          <Route path="/oauth/consent" element={<OAuthConsent />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
