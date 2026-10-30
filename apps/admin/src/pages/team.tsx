import { Check, Copy, Link2, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ErrorNote, Loading, PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Pill } from '@/components/ui/pill';
import { api, ApiError, useApi, type Issue } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { RANK, useSession, useSite } from '@/lib/session';
import type { Member, Role } from '@/lib/types';

interface InviteResult {
  member: Member;
  mailed: boolean;
  link?: string;
}

type Grantable = Exclude<Role, 'owner'>;
const GRANTABLE: Grantable[] = ['admin', 'editor', 'author'];

/** A link to hand over, with a button that copies it. */
function LinkBox({ link }: { link: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-2">
      <p className="text-sm">{t('team.linkHint')}</p>
      <div className="flex gap-2">
        <Input
          readOnly
          aria-label={t('team.link')}
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-[13px]"
        />
        <Button
          variant="outline"
          onClick={() =>
            void navigator.clipboard.writeText(link).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? t('team.copied') : t('team.copy')}
        </Button>
      </div>
    </div>
  );
}

function InviteForm({ roles, onDone }: { roles: Grantable[]; onDone: () => void }) {
  const { t } = useI18n();
  const site = useSite();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Grantable>(roles.at(-1)!);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InviteResult>();

  const submit = async () => {
    setBusy(true);
    setIssues([]);
    try {
      setResult(
        await api<InviteResult>(site.path('/members'), {
          method: 'POST',
          body: { email, role, ...(name.trim() ? { name: name.trim() } : {}) },
        }),
      );
    } catch (err) {
      setIssues(
        err instanceof ApiError && err.issues.length
          ? err.issues
          : [
              {
                path: [],
                message:
                  err instanceof ApiError && err.status === 409
                    ? t('team.alreadyMember')
                    : err instanceof ApiError && err.status === 403
                      ? t('common.forbidden')
                      : t('common.error'),
              },
            ],
      );
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="grid gap-4 p-4">
        <p className="text-sm">
          {result.mailed
            ? t(result.member.pending ? 'team.mailedInvite' : 'team.mailedAdded', {
                email: result.member.email,
              })
            : result.member.pending
              ? t(result.link ? 'team.notMailed' : 'team.notMailedElsewhere', {
                  email: result.member.email,
                })
              : t('team.added', { name: result.member.name })}
        </p>
        {result.link && <LinkBox link={result.link} />}
        <div className="border-t border-rule pt-4">
          <Button variant="primary" onClick={onDone}>
            {t('team.done')}
          </Button>
        </div>
      </div>
    );
  }

  const errorFor = (key: string) => issues.find((i) => i.path[0] === key)?.message;
  const other = issues.filter((i) => !['email', 'name'].includes(String(i.path[0])));
  return (
    <form
      className="grid gap-4 overflow-y-auto p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label={t('login.email')} htmlFor="invite-email" error={errorFor('email')}>
        <Input
          id="invite-email"
          name="invite-email"
          type="email"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          required
          value={email}
          aria-invalid={errorFor('email') ? true : undefined}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field
        label={t('team.name')}
        hint={t('team.nameHint')}
        htmlFor="invite-name"
        error={errorFor('name')}
      >
        <Input
          id="invite-name"
          name="invite-name"
          autoComplete="off"
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label={t('team.role')} hint={t(`team.roleHint.${role}`)} htmlFor="invite-role">
        <Select
          id="invite-role"
          value={role}
          onChange={(e) => setRole(e.target.value as Grantable)}
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {t(`role.${r}`)}
            </option>
          ))}
        </Select>
      </Field>
      {other.length > 0 && (
        <p role="alert" className="text-[13px] text-negative">
          {other.map((i) => i.message).join(' ')}
        </p>
      )}
      <div className="border-t border-rule pt-4">
        <Button type="submit" variant="primary" disabled={busy || !email.trim()}>
          {busy ? t('common.saving') : t('team.send')}
        </Button>
      </div>
    </form>
  );
}

function MemberRow({
  member,
  roles,
  canManage,
  onChange,
  onLink,
}: {
  member: Member;
  roles: Grantable[];
  canManage: boolean;
  onChange: () => void;
  onLink: (result: InviteResult) => void;
}) {
  const { t } = useI18n();
  const site = useSite();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403 ? t('common.forbidden') : t('common.error'),
      );
    } finally {
      setBusy(false);
    }
  };
  const path = site.path(`/members/${member.userId}`);

  return (
    <li className="grid gap-2 border-b border-rule px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-4 md:px-6">
      <div className="grid min-w-0 gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium break-words">{member.name}</span>
          {member.pending && <Pill tone="warning">{t('team.pending')}</Pill>}
          {member.twoFactorEnabled && (
            <ShieldCheck
              className="size-4 text-positive"
              aria-label={t('team.twoFactor')}
              role="img"
            />
          )}
        </span>
        <span className="truncate text-[13px] text-muted" translate="no">
          {member.email}
        </span>
        {error && (
          <span role="alert" className="text-[13px] text-negative">
            {error}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canManage ? (
          <Select
            aria-label={t('team.roleOf', { name: member.name })}
            value={member.role}
            disabled={busy}
            className="h-8 w-auto"
            onChange={(e) =>
              void act(async () => {
                await api(path, { method: 'PATCH', body: { role: e.target.value } });
                onChange();
              })
            }
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {t(`role.${r}`)}
              </option>
            ))}
          </Select>
        ) : (
          <span className="px-2 text-sm text-muted">{t(`role.${member.role}`)}</span>
        )}
        {canManage && member.pending && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void act(async () =>
                onLink(await api<InviteResult>(`${path}/invite`, { method: 'POST', body: {} })),
              )
            }
          >
            <Link2 aria-hidden="true" />
            {t('team.resend')}
          </Button>
        )}
        {canManage && (
          <Button
            size="sm"
            variant={confirm ? 'danger' : 'ghost'}
            disabled={busy}
            aria-label={confirm ? undefined : t('team.removeName', { name: member.name })}
            onClick={() =>
              confirm
                ? void act(async () => {
                    await api(path, { method: 'DELETE' });
                    onChange();
                  })
                : setConfirm(true)
            }
          >
            <Trash2 aria-hidden="true" />
            {confirm && t('team.confirmRemove')}
          </Button>
        )}
      </div>
    </li>
  );
}

/** Who works on this site, with which role. Admins and the owner. */
export function Team() {
  const { t } = useI18n();
  const site = useSite();
  const { me } = useSession();
  const list = useApi<Member[]>(site.path('/members'));
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<InviteResult>();
  // Roles below one's own; the owner may also make admins.
  const roles = GRANTABLE.filter((r) => RANK[r] < RANK[site.role]);

  return (
    <>
      <PageHeader title={t('nav.team')}>
        <Button variant="primary" onClick={() => setInviting(true)}>
          <Plus aria-hidden="true" />
          {t('team.invite')}
        </Button>
      </PageHeader>
      {list.error ? (
        <ErrorNote error={list.error} />
      ) : !list.data ? (
        <Loading />
      ) : (
        <ul className="border-t border-rule">
          {list.data.map((m) => (
            <MemberRow
              key={m.userId}
              member={m}
              roles={roles}
              canManage={m.userId !== me.user.id && RANK[m.role] < RANK[site.role]}
              onChange={list.reload}
              onLink={setLink}
            />
          ))}
        </ul>
      )}
      <Dialog open={inviting} onOpenChange={setInviting}>
        {inviting && (
          <DialogContent title={t('team.invite')} closeLabel={t('common.cancel')}>
            <InviteForm
              roles={roles}
              onDone={() => {
                setInviting(false);
                list.reload();
              }}
            />
          </DialogContent>
        )}
      </Dialog>
      <Dialog open={link !== undefined} onOpenChange={(o) => !o && setLink(undefined)}>
        {link && (
          <DialogContent title={t('team.resend')} closeLabel={t('common.cancel')}>
            <div className="grid gap-4 p-4">
              <p className="text-sm">
                {link.mailed
                  ? t('team.mailedInvite', { email: link.member.email })
                  : t(link.link ? 'team.notMailed' : 'team.notMailedElsewhere', {
                      email: link.member.email,
                    })}
              </p>
              {link.link && <LinkBox link={link.link} />}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
