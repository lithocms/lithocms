import { Fingerprint } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Mark } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { follow, oauthQuery, type FlowStep } from '@/lib/oauth';

/** The narrow centred card of the screens outside the app: sign-in and connecting apps. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-frame px-4 py-8">
      <div className="w-full max-w-sm">
        <p className="mb-6 flex items-center gap-2 font-semibold" translate="no">
          <Mark />
          LithoCMS
        </p>
        {children}
      </div>
    </main>
  );
}

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useI18n();
  const [step, setStep] = useState<'password' | 'code' | 'backup'>('password');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      // Signing in during an app's authorization continues it (better-auth answers with
      // the next step instead of the session).
      const oauth_query = oauthQuery();
      let res: FlowStep & { twoFactorRedirect?: boolean };
      if (step === 'password') {
        res = await api('/auth/sign-in/email', {
          method: 'POST',
          body: { email: form.get('email'), password: form.get('password'), oauth_query },
        });
        if (res.twoFactorRedirect) return setStep('code');
      } else {
        res = await api(
          step === 'code' ? '/auth/two-factor/verify-totp' : '/auth/two-factor/verify-backup-code',
          { method: 'POST', body: { code: form.get('code'), oauth_query } },
        );
      }
      if (oauth_query && follow(res)) return;
      onSignedIn();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status < 500
          ? t(step === 'password' ? 'login.failed' : 'login.codeFailed')
          : t('common.error'),
      );
    } finally {
      setBusy(false);
    }
  };

  // Without a password; an app's authorization in progress resumes once signed in.
  const passkey = async () => {
    setBusy(true);
    setError('');
    try {
      const options = await api<PublicKeyCredentialRequestOptionsJSON>(
        '/auth/passkey/generate-authenticate-options',
      );
      const credential = (await navigator.credentials.get({
        publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
      })) as PublicKeyCredential | null;
      if (!credential) return;
      await api('/auth/passkey/verify-authentication', {
        method: 'POST',
        body: { response: credential.toJSON() },
      });
      onSignedIn();
    } catch (err) {
      // Cancelling the browser's prompt is not an error worth showing.
      if (!(err instanceof DOMException && err.name === 'NotAllowedError')) {
        setError(err instanceof ApiError ? t('login.passkeyFailed') : t('common.error'));
      }
    } finally {
      setBusy(false);
    }
  };
  const passkeys =
    typeof PublicKeyCredential !== 'undefined' &&
    'parseRequestOptionsFromJSON' in PublicKeyCredential;

  return (
    <AuthFrame>
      <form
        onSubmit={(e) => void submit(e)}
        className="grid gap-4 rounded-sheet border border-border bg-sheet p-6"
      >
        <h1 className="text-title font-semibold">{t('login.title')}</h1>
        {step === 'password' ? (
          <>
            <Field label={t('login.email')} htmlFor="email">
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                spellCheck={false}
                required
              />
            </Field>
            <Field label={t('login.password')} htmlFor="password">
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
          </>
        ) : step === 'backup' ? (
          <Field label={t('login.backupCode')} hint={t('login.backupCodeHint')} htmlFor="code">
            <Input
              id="code"
              name="code"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              required
              className="font-mono"
            />
          </Field>
        ) : (
          <Field label={t('login.code')} hint={t('login.codeHint')} htmlFor="code">
            <Input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              className="font-mono tracking-widest"
            />
          </Field>
        )}
        <p role="alert" aria-live="polite" className="min-h-5 text-[13px] text-negative">
          {error}
        </p>
        <Button type="submit" variant="primary" disabled={busy} className="h-9">
          {busy ? t('common.loading') : t(step === 'password' ? 'login.submit' : 'login.verify')}
        </Button>
        {step === 'password' && passkeys && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            className="h-9"
            onClick={() => void passkey()}
          >
            <Fingerprint aria-hidden="true" />
            {t('login.passkey')}
          </Button>
        )}
        {step !== 'password' && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setError('');
              setStep(step === 'code' ? 'backup' : 'code');
            }}
          >
            {t(step === 'code' ? 'login.useBackup' : 'login.useApp')}
          </Button>
        )}
      </form>
    </AuthFrame>
  );
}
