import { useEffect, useState } from 'react';
import { Navigate } from 'react-router';
import { Loading } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { api, useApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { authorizeUrl, follow, oauthQuery, type FlowStep } from '@/lib/oauth';
import { useSession } from '@/lib/session';
import type { McpScope } from '@/lib/types';
import { AuthFrame } from '@/pages/login';

const SCOPES: McpScope[] = ['content', 'design', 'admin'];

interface ConsentDetails {
  client: { id: string; name: string | null; uri: string | null };
  site: { id: string; name: string };
  grantable: McpScope[];
}

/** Already signed in when an app sends the user to sign in: carry on with the session. */
export function ResumeAuthorization({ query }: { query: string }) {
  useEffect(() => location.replace(authorizeUrl(query)), [query]);
  return <Loading />;
}

/** Step one of connecting an app: the one site it will work on. */
export function OAuthSite() {
  const { t } = useI18n();
  const { me } = useSession();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const query = oauthQuery();
  if (!query) return <Navigate to="/" replace />;

  const pick = async (siteId: string) => {
    setBusy(siteId);
    setError('');
    try {
      await api('/oauth/site', { method: 'POST', body: { siteId } });
      const next = await api<FlowStep>('/auth/oauth2/continue', {
        method: 'POST',
        body: { postLogin: true, oauth_query: query },
      });
      if (follow(next)) return;
      setError(t('common.error'));
    } catch {
      setError(t('oauth.expired'));
    }
    setBusy('');
  };

  return (
    <AuthFrame>
      <section className="grid gap-4 rounded-sheet border border-border bg-sheet p-6">
        <div className="grid gap-1">
          <h1 className="text-title font-semibold text-balance">{t('oauth.siteTitle')}</h1>
          <p className="text-sm text-muted">{t('oauth.siteHint')}</p>
        </div>
        {me.sites.length === 0 ? (
          <p className="text-sm">{t('oauth.noSites')}</p>
        ) : (
          <ul className="grid gap-2">
            {me.sites.map((site) => (
              <li key={site.id}>
                <button
                  type="button"
                  disabled={busy !== ''}
                  onClick={() => void pick(site.id)}
                  className="grid w-full cursor-pointer gap-0.5 rounded-card border border-border px-4 py-3 text-left transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-ink disabled:cursor-default disabled:opacity-60"
                >
                  <span className="font-medium break-words">{site.name}</span>
                  <span className="text-[13px] text-muted break-all" translate="no">
                    {busy === site.id ? t('common.loading') : (site.url ?? '')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p role="alert" aria-live="polite" className="min-h-5 text-[13px] text-negative">
          {error}
        </p>
      </section>
    </AuthFrame>
  );
}

/** Step two: what the app may do there. Only scopes the user's role holds can be granted. */
export function OAuthConsent() {
  const { t } = useI18n();
  const query = oauthQuery();
  const params = new URLSearchParams(query ?? '');
  const clientId = params.get('client_id');
  const requested = (params.get('scope') ?? '').split(' ');
  const details = useApi<ConsentDetails>(
    query && clientId ? `/oauth/consent?client_id=${encodeURIComponent(clientId)}` : null,
  );
  const [chosen, setChosen] = useState<McpScope[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!query || !clientId) return <Navigate to="/" replace />;
  if (details.error) {
    return (
      <AuthFrame>
        <p role="alert" className="rounded-sheet border border-border bg-sheet p-6 text-sm">
          {t('oauth.expired')}
        </p>
      </AuthFrame>
    );
  }
  if (!details.data) return <Loading />;

  const { client, site, grantable } = details.data;
  const offered = SCOPES.filter((s) => requested.includes(s));
  const scopes = chosen ?? offered.filter((s) => grantable.includes(s));
  const appName = client.name ?? client.uri ?? client.id;
  const appHost = client.uri && URL.canParse(client.uri) ? new URL(client.uri).host : client.id;

  const decide = async (accept: boolean) => {
    setBusy(true);
    setError('');
    try {
      // Long-lived access (refresh tokens) only when the app asked for it.
      const scope = [...scopes, ...requested.filter((s) => s === 'offline_access')].join(' ');
      const next = await api<FlowStep>('/auth/oauth2/consent', {
        method: 'POST',
        body: accept ? { accept, scope, oauth_query: query } : { accept, oauth_query: query },
      });
      if (follow(next)) return;
      setError(t('common.error'));
    } catch {
      setError(t('oauth.expired'));
    }
    setBusy(false);
  };

  return (
    <AuthFrame>
      <section className="grid gap-5 rounded-sheet border border-border bg-sheet p-6">
        <div className="grid gap-1">
          <h1 className="text-title font-semibold text-balance break-words">
            {t('oauth.consentTitle', { app: appName, site: site.name })}
          </h1>
          <p className="text-[13px] text-muted break-all" translate="no">
            {appHost}
          </p>
        </div>
        <fieldset className="grid gap-3">
          <legend className="mb-2 text-sm font-medium">{t('claude.scopes')}</legend>
          {offered.map((scope) => {
            const allowed = grantable.includes(scope);
            return (
              <label
                key={scope}
                className={`flex items-start gap-2 text-sm ${allowed ? 'cursor-pointer' : 'opacity-60'}`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-ink"
                  disabled={!allowed || busy}
                  checked={scopes.includes(scope)}
                  onChange={(e) =>
                    setChosen(
                      e.target.checked ? [...scopes, scope] : scopes.filter((s) => s !== scope),
                    )
                  }
                />
                <span>
                  <span className="font-medium">{t(`claude.scope.${scope}`)}</span>
                  <span className="block text-[13px] text-muted">
                    {allowed ? t(`claude.scopeHint.${scope}`) : t('oauth.notGrantable')}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <p className="text-[13px] text-muted">{t('oauth.consentHint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={busy || !scopes.length}
            onClick={() => void decide(true)}
          >
            {t('oauth.allow')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>
            {t('oauth.deny')}
          </Button>
        </div>
        <p role="alert" aria-live="polite" className="min-h-5 text-[13px] text-negative">
          {error}
        </p>
      </section>
    </AuthFrame>
  );
}
