import { escapeHtml } from '@lithocms/theme-engine';
import { and, asc, count, desc, eq, gt, sql } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Tx } from '../db/client.js';
import {
  FORM_FIELD_TYPES,
  forms,
  formSubmissions,
  SUBMISSION_STATUSES,
  type FormField,
} from '../db/schema.js';
import { Forbidden, NotFound, ValidationFailed } from '../errors.js';
import { can } from '../permissions.js';
import { audit, type Actor } from './audit.js';

const RATE_LIMIT = { count: 5, windowMs: 10 * 60_000 };
const MIN_FILL_MS = 3_000;
const MAX_TOKEN_AGE_MS = 7 * 24 * 3_600_000;
/** Hidden field people never fill; bots that fill every input do. */
const HONEYPOT = '_website';

const Label = z.union([
  z.string().trim().min(1).max(200),
  z.record(z.string().regex(/^[a-z]{2}$/), z.string().trim().min(1).max(200)),
]);

const FormFieldInput = z
  .strictObject({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'Expected a snake_case key'),
    label: Label,
    type: z.enum(FORM_FIELD_TYPES),
    required: z.boolean().optional(),
    options: z
      .array(z.strictObject({ value: z.string().min(1).max(200), label: Label.optional() }))
      .min(1)
      .max(100)
      .optional(),
  })
  .refine((f) => (f.type === 'select') === (f.options !== undefined), {
    message: '`options` is required for select fields and only allowed there',
  });

export const FormKey = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Expected a lowercase key');

export const FormUpsertInput = z.strictObject({
  fields: z
    .array(FormFieldInput)
    .min(1)
    .max(30)
    .refine((f) => new Set(f.map((x) => x.key)).size === f.length, 'Field keys must be unique'),
  notifyEmails: z.array(z.email()).max(10).optional(),
  successMessage: z.string().max(1000).optional(),
  consentText: z.string().max(2000).optional(),
});
export type FormUpsertInput = z.output<typeof FormUpsertInput>;

export const SubmissionListQuery = z.strictObject({
  status: z.enum(SUBMISSION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type SubmissionListQuery = z.output<typeof SubmissionListQuery>;

export const SubmissionUpdateInput = z.strictObject({ status: z.enum(SUBMISSION_STATUSES) });

export type Form = typeof forms.$inferSelect;
export type Submission = Omit<typeof formSubmissions.$inferSelect, 'ipHash'>;

/** Form definitions include notification addresses, so only admins see them. */
export function assertFormManager(actor: Actor) {
  if (!can(actor.role, 'form.manage')) throw new Forbidden('Only admins can manage forms');
}
const assertManage = assertFormManager;

export function listForms(tx: Tx, siteId: string): Promise<Form[]> {
  return tx.select().from(forms).where(eq(forms.siteId, siteId)).orderBy(asc(forms.key));
}

export async function getForm(tx: Tx, siteId: string, key: string): Promise<Form> {
  const [row] = await tx
    .select()
    .from(forms)
    .where(and(eq(forms.siteId, siteId), eq(forms.key, key)));
  if (!row) throw new NotFound('Form not found');
  return row;
}

export async function upsertForm(
  tx: Tx,
  siteId: string,
  actor: Actor,
  key: string,
  input: FormUpsertInput,
): Promise<Form> {
  assertManage(actor);
  const values = {
    fields: input.fields,
    notifyEmails: input.notifyEmails ?? [],
    successMessage: input.successMessage ?? '',
    consentText: input.consentText ?? '',
  };
  const [row] = await tx
    .insert(forms)
    .values({ siteId, key, ...values })
    .onConflictDoUpdate({
      target: [forms.siteId, forms.key],
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  await audit(tx, siteId, actor, {
    action: 'form.update',
    entityType: 'form',
    entityId: row!.id,
    diff: { key, fields: input.fields.map((f) => f.key) },
  });
  return row!;
}

/** Submissions without IP data. */
export async function listSubmissions(
  tx: Tx,
  siteId: string,
  actor: Actor,
  key: string,
  q: SubmissionListQuery,
): Promise<Submission[]> {
  assertManage(actor);
  const form = await getForm(tx, siteId, key);
  return tx
    .select({
      id: formSubmissions.id,
      siteId: formSubmissions.siteId,
      formId: formSubmissions.formId,
      data: formSubmissions.data,
      status: formSubmissions.status,
      createdAt: formSubmissions.createdAt,
    })
    .from(formSubmissions)
    .where(
      and(
        eq(formSubmissions.siteId, siteId),
        eq(formSubmissions.formId, form.id),
        q.status ? eq(formSubmissions.status, q.status) : undefined,
      ),
    )
    .orderBy(desc(formSubmissions.createdAt))
    .limit(q.limit)
    .offset(q.offset);
}

export async function updateSubmission(
  tx: Tx,
  siteId: string,
  actor: Actor,
  id: string,
  status: Submission['status'],
): Promise<void> {
  assertManage(actor);
  const [row] = await tx
    .update(formSubmissions)
    .set({ status })
    .where(and(eq(formSubmissions.siteId, siteId), eq(formSubmissions.id, id)))
    .returning({ id: formSubmissions.id });
  if (!row) throw new NotFound('Submission not found');
  await audit(tx, siteId, actor, {
    action: 'form_submission.update',
    entityType: 'form_submission',
    entityId: id,
    diff: { status },
  });
}

// --- public submissions ---------------------------------------------------------------------

/** Where a form lives; tokens are only valid for that form. */
export interface FormRef {
  siteId: string;
  key: string;
}

/** Signed render time, checked on submit (time trap). */
export function formToken(secret: string, form: FormRef, now = Date.now()): string {
  const ts = now.toString(36);
  return `${ts}.${sign(secret, form, ts)}`;
}

function sign(secret: string, form: FormRef, ts: string): string {
  return createHmac('sha256', secret)
    .update(`form:${form.siteId}:${form.key}:${ts}`)
    .digest('base64url')
    .slice(0, 22);
}

function tokenAge(
  secret: string,
  form: FormRef,
  token: string | undefined,
  now: number,
): number | null {
  const [ts, sig] = (token ?? '').split('.');
  if (!ts || !sig) return null;
  const expected = Buffer.from(sign(secret, form, ts));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return now - parseInt(ts, 36);
}

export interface SubmitContext {
  secret: string;
  ipHash: string;
  now?: number;
}

/**
 * Stores a public form post. Bot-like posts (honeypot filled, sent too fast, missing or old
 * token) are dropped and reported as `spam`, so the sender cannot tell them apart from
 * success.
 */
export async function submitForm(
  tx: Tx,
  siteId: string,
  key: string,
  raw: Record<string, string>,
  ctx: SubmitContext,
): Promise<'stored' | 'spam'> {
  const form = await getForm(tx, siteId, key);
  const now = ctx.now ?? Date.now();
  const age = tokenAge(ctx.secret, { siteId, key }, raw._t, now);
  if (raw[HONEYPOT] || age === null || age < MIN_FILL_MS || age > MAX_TOKEN_AGE_MS) return 'spam';

  const data = parseSubmission(form, raw);
  // One check at a time per form and address, so parallel posts cannot slip past the limit.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`form:${form.id}:${ctx.ipHash}`}, 0))`,
  );
  const [recent] = await tx
    .select({ n: count() })
    .from(formSubmissions)
    .where(
      and(
        eq(formSubmissions.formId, form.id),
        eq(formSubmissions.ipHash, ctx.ipHash),
        gt(formSubmissions.createdAt, new Date(now - RATE_LIMIT.windowMs)),
      ),
    );
  if ((recent?.n ?? 0) >= RATE_LIMIT.count) {
    throw new ValidationFailed([{ path: [], message: 'Too many submissions; try again later' }]);
  }
  await tx.insert(formSubmissions).values({ siteId, formId: form.id, data, ipHash: ctx.ipHash });
  // TODO(phase-1): email `notifyEmails` through a pg-boss job.
  return 'stored';
}

function parseSubmission(form: Form, raw: Record<string, string>) {
  const data: Record<string, string | number | boolean> = {};
  const issues: { path: string[]; message: string }[] = [];
  const fail = (key: string, message: string) => issues.push({ path: [key], message });
  for (const field of form.fields) {
    const value = (raw[field.key] ?? '').trim();
    if (field.type === 'checkbox') {
      const checked = value === '1' || value === 'on';
      if (field.required && !checked) fail(field.key, 'Required');
      data[field.key] = checked;
      continue;
    }
    if (!value) {
      if (field.required) fail(field.key, 'Required');
      continue;
    }
    const parsed = FIELD_VALUE[field.type](field).safeParse(value);
    if (parsed.success) data[field.key] = parsed.data as string | number;
    else fail(field.key, parsed.error.issues[0]?.message ?? 'Invalid value');
  }
  if (form.consentText && raw._consent !== '1') fail('_consent', 'Consent is required');
  if (issues.length) throw new ValidationFailed(issues);
  return data;
}

const FIELD_VALUE: Record<Exclude<FormField['type'], 'checkbox'>, (f: FormField) => z.ZodType> = {
  text: () => z.string().max(500),
  textarea: () => z.string().max(5000),
  email: () => z.email().max(254),
  tel: () => z.string().regex(/^[+\d\s().-]{5,30}$/, 'Invalid phone number'),
  number: () => z.coerce.number().finite(),
  select: (f) => z.enum((f.options ?? []).map((o) => o.value) as [string, ...string[]]),
  date: () => z.iso.date(),
};

// --- rendering ------------------------------------------------------------------------------

const STRINGS = {
  tr: {
    send: 'Gönder',
    sent: 'Teşekkürler, mesajınız alındı.',
    error: 'Form gönderilemedi. Lütfen alanları kontrol edip tekrar deneyin.',
    choose: 'Seçin',
  },
  en: {
    send: 'Send',
    sent: 'Thank you, your message was received.',
    error: 'The form could not be sent. Please check the fields and try again.',
    choose: 'Choose',
  },
};

function label(value: FormField['label'] | undefined, locale: string): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return value[locale.slice(0, 2)] ?? value.en ?? Object.values(value)[0] ?? '';
}

/** The form's HTML: everything escaped, no inline scripts; themes style `.litho-form`. */
export function renderForm(
  form: Form,
  opts: { locale: string; token: string; status?: 'sent' | 'error' },
): string {
  const t = opts.locale.startsWith('tr') ? STRINGS.tr : STRINGS.en;
  const e = escapeHtml;
  const id = (key: string) => `form-${form.key}-${key}`;
  const fields = form.fields.map((f) => {
    const req = f.required ? ' required' : '';
    const name = `id="${e(id(f.key))}" name="${e(f.key)}"`;
    const text = e(label(f.label, opts.locale));
    const lbl = `<label for="${e(id(f.key))}">${text}${f.required ? ' <span aria-hidden="true">*</span>' : ''}</label>`;
    let control: string;
    switch (f.type) {
      case 'textarea':
        control = `<textarea ${name} rows="5" maxlength="5000"${req}></textarea>`;
        break;
      case 'select':
        control =
          `<select ${name}${req}><option value="">${e(t.choose)}</option>` +
          (f.options ?? [])
            .map(
              (o) =>
                `<option value="${e(o.value)}">${e(label(o.label, opts.locale) || o.value)}</option>`,
            )
            .join('') +
          '</select>';
        break;
      case 'checkbox':
        return `<div class="litho-form__field litho-form__field--checkbox"><input type="checkbox" ${name} value="1"${req}> ${lbl}</div>`;
      default: {
        const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type;
        const auto =
          f.type === 'email'
            ? ' autocomplete="email"'
            : f.type === 'tel'
              ? ' autocomplete="tel"'
              : '';
        control = `<input type="${type}" ${name}${f.type === 'text' ? ' maxlength="500"' : ''}${auto}${req}>`;
      }
    }
    return `<div class="litho-form__field">${lbl}${control}</div>`;
  });
  const status =
    opts.status === 'sent'
      ? `<p class="litho-form__status litho-form__status--sent" role="status">${e(form.successMessage || t.sent)}</p>`
      : opts.status === 'error'
        ? `<p class="litho-form__status litho-form__status--error" role="alert">${e(t.error)}</p>`
        : '';
  const consent = form.consentText
    ? `<div class="litho-form__field litho-form__field--checkbox"><input type="checkbox" id="${e(id('_consent'))}" name="_consent" value="1" required> <label for="${e(id('_consent'))}">${e(form.consentText)}</label></div>`
    : '';
  return [
    `<form class="litho-form" id="form-${e(form.key)}" method="post" action="/_forms/${e(form.key)}">`,
    status,
    ...fields,
    consent,
    `<div class="litho-form__hp" aria-hidden="true" style="position:absolute;left:-10000px"><label>Website <input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>`,
    `<input type="hidden" name="_t" value="${e(opts.token)}">`,
    `<button type="submit">${e(t.send)}</button>`,
    '</form>',
  ]
    .filter(Boolean)
    .join('');
}
