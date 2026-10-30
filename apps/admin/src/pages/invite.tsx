import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AuthFrame } from '@/pages/login';

/** Shortest password better-auth accepts. */
const MIN_PASSWORD = 8;

/** Where an invitation link lands: the invited person sets their password, then signs in. */
export function AcceptInvite() {
  const { t } = useI18n();
  // The token travels in the fragment so it stays out of server logs.
  const token = location.hash.slice(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const newPassword = form.get('password') as string;
    if (newPassword !== form.get('confirm')) return setError(t('invite.mismatch'));
    setBusy(true);
    setError('');
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, newPassword } });
      history.replaceState(null, '', '/invite');
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 400 ? t('invite.expired') : t('common.error'),
      );
    } finally {
      setBusy(false);
    }
  };

  if (done || !token) {
    return (
      <AuthFrame>
        <section className="grid gap-4 rounded-sheet border border-border bg-sheet p-6">
          <h1 className="text-title font-semibold">
            {done ? t('invite.doneTitle') : t('invite.expiredTitle')}
          </h1>
          <p className="text-sm text-muted">{done ? t('invite.done') : t('invite.expired')}</p>
          <Button variant="primary" className="h-9" onClick={() => location.assign('/')}>
            {t('login.submit')}
          </Button>
        </section>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <form
        onSubmit={(e) => void submit(e)}
        className="grid gap-4 rounded-sheet border border-border bg-sheet p-6"
      >
        <div className="grid gap-1">
          <h1 className="text-title font-semibold">{t('invite.title')}</h1>
          <p className="text-sm text-muted">{t('invite.hint', { n: MIN_PASSWORD })}</p>
        </div>
        <Field label={t('invite.password')} htmlFor="password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            maxLength={128}
            autoFocus
            required
          />
        </Field>
        <Field label={t('invite.confirm')} htmlFor="confirm">
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            maxLength={128}
            required
          />
        </Field>
        <p role="alert" aria-live="polite" className="min-h-5 text-[13px] text-negative">
          {error}
        </p>
        <Button type="submit" variant="primary" disabled={busy} className="h-9">
          {busy ? t('common.saving') : t('invite.submit')}
        </Button>
      </form>
    </AuthFrame>
  );
}
