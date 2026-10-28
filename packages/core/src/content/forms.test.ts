import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations, withSite, type Db, type Tx } from '../db/client.js';
import { formSubmissions, sites, users } from '../db/schema.js';
import { Forbidden, ValidationFailed } from '../errors.js';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import type { Actor } from './audit.js';
import {
  formToken,
  FormUpsertInput,
  getForm,
  listSubmissions,
  renderForm,
  SubmissionListQuery,
  submitForm,
  upsertForm,
} from './forms.js';

const secret = 'form-secret';
let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let siteId: string;
let admin: Actor;
let editor: Actor;

const inSite = <T>(fn: (tx: Tx) => Promise<T>) => withSite(db, siteId, fn);
const ago = (ms: number) => formToken(secret, Date.now() - ms);
const submit = (raw: Record<string, string>, ipHash = 'ip-1') =>
  inSite((tx) =>
    submitForm(tx, siteId, 'contact', { _t: ago(10_000), ...raw }, { secret, ipHash }),
  );
const stored = () => inSite((tx) => tx.select().from(formSubmissions));

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  ({ db, pool } = createDb(tdb.appUrl));
  const [site] = await db.insert(sites).values({ name: 'S' }).returning();
  siteId = site!.id;
  const [u] = await db.insert(users).values({ name: 'A', email: 'a@example.com' }).returning();
  admin = { userId: u!.id, role: 'admin', channel: 'admin' };
  editor = { ...admin, role: 'editor' };
  await inSite((tx) =>
    upsertForm(
      tx,
      siteId,
      admin,
      'contact',
      FormUpsertInput.parse({
        fields: [
          { key: 'name', label: { tr: 'Ad <b>', en: 'Name' }, type: 'text', required: true },
          { key: 'email', label: 'E-posta', type: 'email', required: true },
          {
            key: 'topic',
            label: 'Konu',
            type: 'select',
            options: [{ value: 'sales' }, { value: 'support' }],
          },
          { key: 'message', label: 'Mesaj', type: 'textarea' },
          { key: 'newsletter', label: 'Bülten', type: 'checkbox' },
        ],
        consentText: 'KVKK metnini okudum.',
        notifyEmails: ['owner@example.com'],
      }),
    ),
  );
});

afterAll(async () => {
  await pool.end();
  await tdb.stop();
});

describe('form definitions', () => {
  it('are managed by admins only and validated', async () => {
    await expect(
      inSite((tx) =>
        upsertForm(
          tx,
          siteId,
          editor,
          'x',
          FormUpsertInput.parse({ fields: [{ key: 'a', label: 'A', type: 'text' }] }),
        ),
      ),
    ).rejects.toBeInstanceOf(Forbidden);
    for (const input of [
      { fields: [] },
      { fields: [{ key: 'a', label: 'A', type: 'select' }] },
      { fields: [{ key: 'a', label: 'A', type: 'file' }] },
      { fields: [{ key: 'a', label: 'A', type: 'text' }], notifyEmails: ['not-an-email'] },
    ]) {
      expect(FormUpsertInput.safeParse(input).success).toBe(false);
    }
  });

  it('render as escaped, script-free HTML', async () => {
    const form = await inSite((tx) => getForm(tx, siteId, 'contact'));
    const html = renderForm(form, { locale: 'tr', token: 't"><x', status: 'sent' });
    expect(html).toContain(
      '<label for="form-contact-name">Ad &lt;b&gt; <span aria-hidden="true">*</span></label>',
    );
    expect(html).toContain(
      '<input type="email" id="form-contact-email" name="email" autocomplete="email" required>',
    );
    expect(html).toContain('<option value="sales">sales</option>');
    expect(html).toContain('name="_consent" value="1" required');
    expect(html).toContain('value="t&quot;&gt;&lt;x"');
    expect(html).toContain('role="status">Teşekkürler, mesajınız alındı.</p>');
    expect(html).not.toMatch(/<script|on\w+=/i);
    expect(renderForm(form, { locale: 'en', token: 't', status: 'error' })).toContain(
      'role="alert"',
    );
  });
});

describe('submitForm', () => {
  it('stores valid submissions with typed values', async () => {
    const result = await submit({
      name: ' Ayşe ',
      email: 'ayse@example.com',
      topic: 'sales',
      newsletter: 'on',
      _consent: '1',
      extra: 'ignored',
    });
    expect(result).toBe('stored');
    const [row] = await stored();
    expect(row!.data).toEqual({
      name: 'Ayşe',
      email: 'ayse@example.com',
      topic: 'sales',
      newsletter: true,
    });
    const listed = await inSite((tx) =>
      listSubmissions(tx, siteId, admin, 'contact', SubmissionListQuery.parse({})),
    );
    expect(listed[0]).not.toHaveProperty('ipHash');
    await expect(
      inSite((tx) => listSubmissions(tx, siteId, editor, 'contact', SubmissionListQuery.parse({}))),
    ).rejects.toBeInstanceOf(Forbidden);
  });

  it.each([
    ['a missing required field', { email: 'a@b.co', _consent: '1' }, 'name'],
    ['an invalid email', { name: 'x', email: 'nope', _consent: '1' }, 'email'],
    ['an unknown option', { name: 'x', email: 'a@b.co', topic: 'other', _consent: '1' }, 'topic'],
    ['missing consent', { name: 'x', email: 'a@b.co' }, '_consent'],
  ])('rejects %s', async (_name, raw, path) => {
    const error = await submit(raw).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationFailed);
    expect((error as ValidationFailed).issues.map((i) => i.path[0])).toContain(path);
  });

  it.each([
    // Tokens are made when the test runs, not when the table is built.
    ['the honeypot is filled', () => ({ _website: 'http://spam' })],
    ['it is sent too fast', () => ({ _t: ago(500) })],
    ['the token is old', () => ({ _t: ago(8 * 24 * 3_600_000) })],
    ['the token is forged', () => ({ _t: `${Date.now().toString(36)}.forged` })],
    ['there is no token', () => ({ _t: '' })],
  ])('drops it silently when %s', async (_name, extra) => {
    const before = (await stored()).length;
    const result = await submit({
      name: 'Bot',
      email: 'bot@example.com',
      _consent: '1',
      ...extra(),
    });
    expect(result).toBe('spam');
    expect(await stored()).toHaveLength(before);
  });

  it('limits submissions per address', async () => {
    const valid = { name: 'x', email: 'a@b.co', _consent: '1' };
    for (let i = 0; i < 5; i++) await submit(valid, 'ip-busy');
    await expect(submit(valid, 'ip-busy')).rejects.toThrow(/Too many/);
    expect(await submit(valid, 'ip-other')).toBe('stored');
  });
});
