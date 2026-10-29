import { useState, type FormEvent } from 'react';
import { Mark } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useI18n();
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      if (step === 'password') {
        const res = await api<{ twoFactorRedirect?: boolean }>('/auth/sign-in/email', {
          method: 'POST',
          body: { email: form.get('email'), password: form.get('password') },
        });
        if (res.twoFactorRedirect) return setStep('code');
      } else {
        await api('/auth/two-factor/verify-totp', {
          method: 'POST',
          body: { code: form.get('code') },
        });
      }
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

  return (
    <main className="grid min-h-dvh place-items-center bg-frame px-4">
      <div className="w-full max-w-sm">
        <p className="mb-6 flex items-center gap-2 font-semibold" translate="no">
          <Mark />
          LithoCMS
        </p>
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
        </form>
      </div>
    </main>
  );
}
