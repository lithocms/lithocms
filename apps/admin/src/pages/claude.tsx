import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { SettingsRow } from '@/components/settings-row';
import { ErrorNote, Loading, PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { Pill } from '@/components/ui/pill';
import { api, ApiError, useApi, type Issue } from '@/lib/api';
import { useFormat, useI18n } from '@/lib/i18n';
import { useSite } from '@/lib/session';
import type { ClaudeConnections, McpScope, McpToken } from '@/lib/types';

const EXPIRY = ['30', '90', '365', 'never'] as const;

function CopyBlock({ label, text }: { label: string; text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? t('claude.copied') : t('claude.copy')}
        </Button>
      </div>
      <pre
        className="overflow-x-auto rounded-control border border-rule bg-sheet px-3 py-2 font-mono text-[13px] break-all whitespace-pre-wrap"
        translate="no"
      >
        {text}
      </pre>
    </div>
  );
}

/** Personal access tokens that let Claude (or another MCP client) work on this site. */
export function ClaudePage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const site = useSite();
  const data = useApi<ClaudeConnections>(site.path('/mcp-tokens'));
  const [name, setName] = useState('Claude Code');
  const [scopes, setScopes] = useState<McpScope[]>(['content']);
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]>('90');
  const [created, setCreated] = useState<{ token: string; url: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [confirm, setConfirm] = useState('');

  if (data.error) return <ErrorNote error={data.error} />;
  if (!data.data) return <Loading />;
  const { grantable, tokens } = data.data;

  const create = async () => {
    setBusy('create');
    setNote('');
    setIssues([]);
    try {
      const res = await api<{ token: string; url: string }>(site.path('/mcp-tokens'), {
        method: 'POST',
        body: {
          name,
          scopes,
          expiresInDays: expiry === 'never' ? null : Number(expiry),
        },
      });
      setCreated(res);
      data.reload();
    } catch (err) {
      if (err instanceof ApiError) {
        setIssues(err.issues);
        if (!err.issues.length) setNote(err.message);
      } else setNote(t('common.error'));
    } finally {
      setBusy('');
    }
  };

  const revoke = async (token: McpToken) => {
    if (confirm !== token.id) return setConfirm(token.id);
    setBusy(token.id);
    try {
      await api(site.path(`/mcp-tokens/${token.id}`), { method: 'DELETE' });
      setConfirm('');
      data.reload();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy('');
    }
  };

  const errorFor = (key: string) => issues.find((i) => i.path[0] === key)?.message;
  const toggle = (scope: McpScope, on: boolean) =>
    setScopes(on ? [...scopes, scope] : scopes.filter((s) => s !== scope));

  return (
    <>
      <PageHeader title={t('nav.claude')} />
      <div className="mx-auto max-w-[1152px] px-4 md:px-6">
        <SettingsRow title={t('claude.new')} hint={t('claude.newHint')}>
          {created ? (
            <div className="grid gap-4">
              <p role="status" className="text-sm">
                {t('claude.createdNote')}
              </p>
              <CopyBlock
                label={t('claude.command')}
                text={`claude mcp add --transport http lithocms ${created.url} --header "Authorization: Bearer ${created.token}"`}
              />
              <CopyBlock label={t('claude.token')} text={created.token} />
              <div>
                <Button variant="outline" onClick={() => setCreated(null)}>
                  {t('claude.done')}
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <Field label={t('claude.name')} htmlFor="token-name" error={errorFor('name')}>
                <Input
                  id="token-name"
                  name="token-name"
                  autoComplete="off"
                  value={name}
                  maxLength={100}
                  aria-invalid={errorFor('name') ? true : undefined}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">{t('claude.scopes')}</legend>
                {grantable.map((scope) => (
                  <label key={scope} className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 accent-ink"
                      checked={scopes.includes(scope)}
                      onChange={(e) => toggle(scope, e.target.checked)}
                    />
                    <span>
                      <span className="font-medium">{t(`claude.scope.${scope}`)}</span>
                      <span className="block text-[13px] text-muted">
                        {t(`claude.scopeHint.${scope}`)}
                      </span>
                    </span>
                  </label>
                ))}
                {errorFor('scopes') && (
                  <p className="text-[13px] text-negative" role="alert">
                    {errorFor('scopes')}
                  </p>
                )}
              </fieldset>
              <Field label={t('claude.expires')} htmlFor="token-expiry">
                <Select
                  id="token-expiry"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value as (typeof EXPIRY)[number])}
                >
                  {EXPIRY.map((v) => (
                    <option key={v} value={v}>
                      {v === 'never' ? t('claude.never') : t('claude.days', { n: v })}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-center gap-3">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy !== '' || !scopes.length || !name.trim()}
                >
                  {busy === 'create' ? t('claude.creating') : t('claude.create')}
                </Button>
                <span aria-live="polite" className="text-[13px] text-negative">
                  {note}
                </span>
              </div>
            </form>
          )}
        </SettingsRow>
        <SettingsRow title={t('claude.active')} hint={t('claude.activeHint')}>
          {tokens.length === 0 ? (
            <p className="text-sm text-muted">{t('claude.none')}</p>
          ) : (
            <ul className="grid gap-2">
              {tokens.map((token) => (
                <li
                  key={token.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-card border border-border bg-sheet px-4 py-3"
                >
                  <span className="min-w-0 font-medium break-words">{token.name}</span>
                  <span className="flex gap-1">
                    {token.scopes.map((s) => (
                      <Pill key={s}>{t(`claude.scope.${s}`)}</Pill>
                    ))}
                  </span>
                  <Button
                    variant="danger"
                    size="sm"
                    className="ml-auto"
                    disabled={busy !== ''}
                    onClick={() => void revoke(token)}
                  >
                    {confirm === token.id ? t('claude.confirmRevoke') : t('claude.revoke')}
                  </Button>
                  <span className="w-full text-[13px] text-muted">
                    {t('claude.createdAt', { d: fmt.date(token.createdAt) })}
                    {' · '}
                    {token.lastUsedAt
                      ? t('claude.lastUsed', { d: fmt.dateTime(token.lastUsedAt) })
                      : t('claude.unused')}
                    {' · '}
                    {token.expiresAt
                      ? t('claude.expiresAt', { d: fmt.date(token.expiresAt) })
                      : t('claude.noExpiry')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SettingsRow>
      </div>
    </>
  );
}
