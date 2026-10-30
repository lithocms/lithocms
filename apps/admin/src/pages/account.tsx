import { Fingerprint, Trash2 } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { encode } from 'uqr';
import { Loading, PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Pill } from '@/components/ui/pill';
import { api, ApiError, useApi } from '@/lib/api';
import { useFormat, useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';

/** Shortest password better-auth accepts. */
const MIN_PASSWORD = 8;

interface Passkey {
  id: string;
  name?: string | null;
  createdAt: string;
}

/** A section of the page: what it is on the left, its form on the right (stacked on phones). */
function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-b border-rule px-4 py-6 md:grid-cols-[240px_minmax(0,1fr)] md:gap-8 md:px-6">
      <div className="grid content-start gap-1">
        <h2 className="text-section font-semibold">{title}</h2>
        <p className="text-[13px] text-muted">{hint}</p>
      </div>
      <div className="grid max-w-md content-start gap-4">{children}</div>
    </section>
  );
}

/** Success or error under a form, read out when it changes. */
function Status({ value }: { value?: { error: boolean; text: string } }) {
  return (
    <p
      role={value?.error ? 'alert' : undefined}
      aria-live="polite"
      className={`min-h-5 text-[13px] ${value?.error ? 'text-negative' : 'text-muted'}`}
    >
      {value?.text}
    </p>
  );
}

/** Runs a form's request and turns the outcome into a status line. */
function useAction() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ error: boolean; text: string }>();
  const run = async (fn: () => Promise<string | void>, failed = t('common.error')) => {
    setBusy(true);
    setStatus(undefined);
    try {
      const done = await fn();
      if (done) setStatus({ error: false, text: done });
      return true;
    } catch (err) {
      // better-auth answers a wrong password or code with a 400/401.
      setStatus({
        error: true,
        text: err instanceof ApiError && err.status < 500 ? failed : t('common.error'),
      });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, status, setStatus, run };
}

/** The otpauth URI as a QR code, drawn as SVG squares. */
function QrCode({ value, label }: { value: string; label: string }) {
  const { data, size } = encode(value, { ecc: 'M' });
  const border = 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${-border} ${-border} ${size + 2 * border} ${size + 2 * border}`}
      className="size-44 rounded-control bg-white"
      shapeRendering="crispEdges"
    >
      {data.flatMap((row, y) =>
        row.map((dark, x) =>
          dark ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} /> : null,
        ),
      )}
    </svg>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-2 rounded-card border border-border p-4">
      <p className="text-sm font-medium">{t('account.backupTitle')}</p>
      <p className="text-[13px] text-muted">{t('account.backupHint')}</p>
      <ul className="grid grid-cols-2 gap-1 font-mono text-sm" translate="no">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}

function Profile() {
  const { t } = useI18n();
  const { me, reload } = useSession();
  const [name, setName] = useState(me.user.name);
  const { busy, status, run } = useAction();
  return (
    <Section title={t('account.profile')} hint={t('account.profileHint')}>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('/auth/update-user', { method: 'POST', body: { name: name.trim() } });
            reload();
            return t('common.saved');
          });
        }}
      >
        <Field label={t('team.name')} htmlFor="account-name">
          <Input
            id="account-name"
            name="name"
            autoComplete="name"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label={t('login.email')} hint={t('account.emailHint')} htmlFor="account-email">
          <Input id="account-email" value={me.user.email} readOnly translate="no" />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy ? t('common.saving') : t('common.save')}
          </Button>
          <Status value={status} />
        </div>
      </form>
    </Section>
  );
}

function Password() {
  const { t } = useI18n();
  const { busy, status, setStatus, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const newPassword = data.get('new') as string;
    if (newPassword !== data.get('confirm')) {
      return setStatus({ error: true, text: t('invite.mismatch') });
    }
    void run(async () => {
      await api('/auth/change-password', {
        method: 'POST',
        body: {
          currentPassword: data.get('current'),
          newPassword,
          // Anyone else signed in with the old password is signed out.
          revokeOtherSessions: true,
        },
      });
      form.reset();
      return t('account.passwordChanged');
    }, t('account.wrongPassword'));
  };
  return (
    <Section title={t('account.password')} hint={t('account.passwordHint')}>
      <form className="grid gap-4" onSubmit={submit}>
        <Field label={t('account.currentPassword')} htmlFor="current-password">
          <Input
            id="current-password"
            name="current"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <Field
          label={t('account.newPassword')}
          hint={t('account.newPasswordHint', { n: MIN_PASSWORD })}
          htmlFor="new-password"
        >
          <Input
            id="new-password"
            name="new"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            maxLength={128}
            required
          />
        </Field>
        <Field label={t('invite.confirm')} htmlFor="confirm-password">
          <Input
            id="confirm-password"
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            maxLength={128}
            required
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? t('common.saving') : t('account.changePassword')}
          </Button>
          <Status value={status} />
        </div>
      </form>
    </Section>
  );
}

function TwoFactor() {
  const { t } = useI18n();
  const { me, reload } = useSession();
  const enabled = me.user.twoFactorEnabled;
  // Set up: the app is shown the secret, then one code from it proves it was saved.
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] }>();
  const [codes, setCodes] = useState<string[]>();
  const { busy, status, run } = useAction();
  const secret = setup && new URL(setup.totpURI).searchParams.get('secret');

  const withPassword =
    (fn: (password: string) => Promise<string | void>) => (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = e.currentTarget;
      const password = new FormData(form).get('password') as string;
      void run(async () => {
        const done = await fn(password);
        form.reset();
        return done;
      }, t('account.wrongPassword'));
    };
  const passwordField = (
    <Field label={t('account.currentPassword')} htmlFor="tf-password">
      <Input
        id="tf-password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
    </Field>
  );

  let body: ReactNode;
  if (setup) {
    body = (
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const code = new FormData(e.currentTarget).get('code') as string;
          void run(async () => {
            await api('/auth/two-factor/verify-totp', { method: 'POST', body: { code } });
            setCodes(setup.backupCodes);
            setSetup(undefined);
            reload();
            return t('account.twoFactorOn');
          }, t('login.codeFailed'));
        }}
      >
        <ol className="grid list-decimal gap-3 pl-5 text-sm">
          <li className="grid gap-2">
            {t('account.scan')}
            <QrCode value={setup.totpURI} label={t('account.qr')} />
            <p className="mt-2 text-[13px] text-muted">
              {t('account.manual')}{' '}
              <code className="font-mono break-all text-ink" translate="no">
                {secret}
              </code>
            </p>
          </li>
          <li>{t('account.enterCode')}</li>
        </ol>
        <Field label={t('login.code')} htmlFor="tf-code">
          <Input
            id="tf-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            autoFocus
            required
            className="w-32 font-mono tracking-widest"
          />
        </Field>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {t('account.turnOn')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setSetup(undefined)}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    );
  } else if (!enabled) {
    body = (
      <form
        className="grid gap-4"
        onSubmit={withPassword(async (password) => {
          setSetup(await api('/auth/two-factor/enable', { method: 'POST', body: { password } }));
        })}
      >
        {passwordField}
        <div>
          <Button type="submit" variant="primary" disabled={busy}>
            {t('account.setUp')}
          </Button>
        </div>
      </form>
    );
  } else {
    body = (
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          const action = e.nativeEvent.submitter?.getAttribute('value');
          withPassword(async (password) => {
            if (action === 'codes') {
              const res = await api<{ backupCodes: string[] }>(
                '/auth/two-factor/generate-backup-codes',
                { method: 'POST', body: { password } },
              );
              setCodes(res.backupCodes);
              return;
            }
            await api('/auth/two-factor/disable', { method: 'POST', body: { password } });
            setCodes(undefined);
            reload();
            return t('account.twoFactorOff');
          })(e);
        }}
      >
        {passwordField}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" value="codes" variant="outline" disabled={busy}>
            {t('account.newCodes')}
          </Button>
          <Button type="submit" value="disable" variant="danger" disabled={busy}>
            {t('account.turnOff')}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <Section title={t('account.twoFactor')} hint={t('account.twoFactorHint')}>
      <p className="flex items-center gap-2 text-sm">
        <Pill tone={enabled ? 'positive' : 'neutral'}>
          {enabled ? t('account.on') : t('account.off')}
        </Pill>
      </p>
      {body}
      {codes && <BackupCodes codes={codes} />}
      <Status value={status} />
    </Section>
  );
}

function Passkeys() {
  const { t } = useI18n();
  const fmt = useFormat();
  const list = useApi<Passkey[]>('/auth/passkey/list-user-passkeys');
  const [name, setName] = useState('');
  const { busy, status, run } = useAction();
  const supported =
    typeof PublicKeyCredential !== 'undefined' &&
    'parseCreationOptionsFromJSON' in PublicKeyCredential;

  const add = () =>
    run(async () => {
      const options = await api<PublicKeyCredentialCreationOptionsJSON>(
        '/auth/passkey/generate-register-options',
      );
      const credential = (await navigator.credentials.create({
        publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options),
      })) as PublicKeyCredential | null;
      if (!credential) return;
      await api('/auth/passkey/verify-registration', {
        method: 'POST',
        body: { response: credential.toJSON(), name: name.trim() || undefined },
      });
      setName('');
      list.reload();
      return t('account.passkeyAdded');
    }, t('account.passkeyFailed'));

  return (
    <Section title={t('account.passkeys')} hint={t('account.passkeysHint')}>
      {!list.data ? (
        <Loading />
      ) : list.data.length > 0 ? (
        <ul className="grid gap-2">
          {list.data.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-3 rounded-card border border-border px-3 py-2"
            >
              <Fingerprint className="size-4 shrink-0 text-muted" aria-hidden="true" />
              <span className="grid min-w-0">
                <span className="truncate text-sm font-medium">
                  {p.name || t('account.passkey')}
                </span>
                <span className="text-[13px] text-muted">
                  {t('account.added', { d: fmt.date(p.createdAt) })}
                </span>
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                className="ml-auto"
                aria-label={t('account.removePasskey', { name: p.name || t('account.passkey') })}
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(t('account.removePasskeyConfirm'))) return;
                  void run(async () => {
                    await api('/auth/passkey/delete-passkey', {
                      method: 'POST',
                      body: { id: p.id },
                    });
                    list.reload();
                  });
                }}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t('account.noPasskeys')}</p>
      )}
      {supported ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <Field label={t('account.passkeyName')} htmlFor="passkey-name">
            <Input
              id="passkey-name"
              name="passkey-name"
              autoComplete="off"
              placeholder={t('account.passkeyNameHint')}
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="outline" disabled={busy}>
            <Fingerprint aria-hidden="true" />
            {t('account.addPasskey')}
          </Button>
        </form>
      ) : (
        <p className="text-[13px] text-muted">{t('account.passkeyUnsupported')}</p>
      )}
      <Status value={status} />
    </Section>
  );
}

/** The signed-in person's own account: name, password, two-step sign-in, passkeys. */
export function AccountPage() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('nav.account')} />
      <div className="border-t border-rule">
        <Profile />
        <Password />
        <TwoFactor />
        <Passkeys />
      </div>
    </>
  );
}
