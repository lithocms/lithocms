import { createDb, createDiskStore, runMigrations, schema, type Db } from '@lithocms/core';
import { eq } from 'drizzle-orm';
import { startTestDatabase, type TestDatabase } from '@lithocms/core/testing';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { createAuth, createPasswordUser } from './auth.js';
import type { Mail } from './mailer.js';
import { createSiteResolver } from './sites.js';
import { TEST_THEME, testThemes } from './testing/themes.js';

const ADMIN = 'admin.example.net';
const adminUrl = new URL(`https://${ADMIN}`);
const secret = 'test-secret-test-secret-test-secret!';
const password = 'correct horse battery';

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let app: FastifyInstance;
let siteA: string;
let siteB: string;
let mediaDir: string;
const cookies: Record<string, string> = {};
const sent: Mail[] = [];
let mailFails = false;
let ip = 0;

const headers = (who?: string) => ({
  host: ADMIN,
  origin: adminUrl.origin,
  'x-forwarded-for': `192.0.2.${++ip}`,
  ...(who ? { cookie: cookies[who] } : {}),
});
const call = (
  who: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload?: object,
  site = siteA,
) =>
  app.inject({
    method,
    url: `/api/sites/${site}${path}`,
    headers: headers(who),
    ...(payload ? { payload } : {}),
  });
const signIn = (email: string, pass = password) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: headers(),
    payload: { email, password: pass },
  });

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  ({ db, pool } = createDb(tdb.appUrl));
  const [site] = await db.insert(schema.sites).values({ name: 'Kuzey', locale: 'tr' }).returning();
  siteA = site!.id;
  const [other] = await db.insert(schema.sites).values({ name: 'Other' }).returning();
  siteB = other!.id;
  mediaDir = await mkdtemp(join(tmpdir(), 'litho-members-media-'));
  const owner = createDb(tdb.ownerUrl);
  const themes = await testThemes(owner.db, { test: TEST_THEME });
  await owner.pool.end();
  const auth = createAuth({ db, adminUrl, secret });
  app = buildApp({
    db,
    sites: await createSiteResolver(db),
    adminUrl,
    auth,
    secret,
    store: createDiskStore(mediaDir),
    themes,
    mailer: {
      send(mail) {
        if (mailFails) return Promise.reject(new Error('SMTP down'));
        sent.push(mail);
        return Promise.resolve();
      },
    },
    logLevel: 'silent',
  });
  for (const [name, role, siteId] of [
    ['admin', 'admin', siteA],
    ['editor', 'editor', siteA],
    ['otherAdmin', 'admin', siteB],
  ] as const) {
    const email = `${name}@example.com`;
    const user = await createPasswordUser(auth, { email, name, password });
    await db.insert(schema.memberships).values({ userId: user.id, siteId, role });
    cookies[name] = String((await signIn(email)).headers['set-cookie']).split(';')[0]!;
  }
  // Someone with an account elsewhere on the instance.
  await createPasswordUser(auth, { email: 'known@example.com', name: 'Known', password });
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await tdb.stop();
  await rm(mediaDir, { recursive: true, force: true });
});

describe('members', () => {
  it('is for admins only', async () => {
    expect((await call('editor', 'GET', '/members')).statusCode).toBe(403);
    expect(
      (await call('editor', 'POST', '/members', { email: 'x@example.com', role: 'author' }))
        .statusCode,
    ).toBe(403);
    // An admin cannot make admins, and no account is made for the attempt.
    expect(
      (await call('admin', 'POST', '/members', { email: 'boss@example.com', role: 'admin' }))
        .statusCode,
    ).toBe(403);
    const [made] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'boss@example.com'));
    expect(made).toBeUndefined();
  });

  it('invites a new person by mail with a link to set a password', async () => {
    const res = await call('admin', 'POST', '/members', {
      email: 'New@Example.com',
      name: 'Yeni Yazar',
      role: 'author',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      member: { email: 'new@example.com', name: 'Yeni Yazar', role: 'author', pending: true },
      mailed: true,
    });
    expect(res.json()).not.toHaveProperty('link');
    const mail = sent.at(-1)!;
    expect(mail.to).toEqual(['new@example.com']);
    expect(mail.subject).toBe('Kuzey sitesine davet edildiniz');
    const token = /\/invite#([\w-]+)/.exec(mail.text)![1]!;

    // Cannot sign in before setting a password; setting it works once.
    expect((await signIn('new@example.com')).statusCode).toBe(401);
    const accept = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        headers: headers(),
        payload: { token, newPassword: 'a brand new password' },
      });
    expect((await accept()).statusCode).toBe(200);
    expect((await accept()).statusCode).toBe(400);
    expect((await signIn('new@example.com', 'a brand new password')).statusCode).toBe(200);
    const list = (await call('admin', 'GET', '/members')).json<
      { email: string; pending: boolean }[]
    >();
    expect(list.find((m) => m.email === 'new@example.com')?.pending).toBe(false);
  });

  it('adds people who already have an account, without a link', async () => {
    const res = await call('admin', 'POST', '/members', {
      email: 'known@example.com',
      role: 'editor',
    });
    expect(res.json()).toMatchObject({ member: { name: 'Known', pending: false }, mailed: true });
    expect(sent.at(-1)!.text).not.toContain('/invite#');
    expect(
      (await call('admin', 'POST', '/members', { email: 'known@example.com', role: 'author' }))
        .statusCode,
    ).toBe(409);
  });

  it('hands the admin the link when mail fails, and a new link replaces the old one', async () => {
    mailFails = true;
    const res = await call('admin', 'POST', '/members', {
      email: 'late@example.com',
      role: 'author',
    });
    const { member, mailed, link } = res.json<{
      member: { userId: string };
      mailed: boolean;
      link: string;
    }>();
    expect(mailed).toBe(false);
    expect(link).toMatch(/^https:\/\/admin\.example\.net\/invite#[\w-]{43}$/);

    const again = await call('admin', 'POST', `/members/${member.userId}/invite`);
    const newLink = again.json<{ link: string }>().link;
    expect(newLink).not.toBe(link);
    mailFails = false;
    const tryLink = (l: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        headers: headers(),
        payload: { token: l.split('#')[1], newPassword: 'another new password' },
      });
    expect((await tryLink(link)).statusCode).toBe(400);
    expect((await tryLink(newLink)).statusCode).toBe(200);
    // Accepted: no more links.
    expect((await call('admin', 'POST', `/members/${member.userId}/invite`)).statusCode).toBe(409);
  });

  it('changes roles and removes members below the admin', async () => {
    const list = (await call('admin', 'GET', '/members')).json<
      { userId: string; email: string }[]
    >();
    const id = (email: string) => list.find((m) => m.email === email)!.userId;
    expect(
      (
        await call('admin', 'PATCH', `/members/${id('known@example.com')}`, { role: 'author' })
      ).json(),
    ).toMatchObject({ role: 'author' });
    expect(
      (await call('admin', 'PATCH', `/members/${id('admin@example.com')}`, { role: 'editor' }))
        .statusCode,
    ).toBe(403);
    expect((await call('admin', 'DELETE', `/members/${id('known@example.com')}`)).statusCode).toBe(
      204,
    );
    // Known still has their account, just not this site.
    expect((await signIn('known@example.com')).statusCode).toBe(200);
    const after = (await call('admin', 'GET', '/members')).json<{ email: string }[]>();
    expect(after.map((m) => m.email)).not.toContain('known@example.com');
  });

  it('never hands an admin the link of someone invited to another site too', async () => {
    mailFails = true;
    const first = await call('admin', 'POST', '/members', {
      email: 'shared@example.com',
      role: 'author',
    });
    const linkA = first.json<{ link: string }>().link;
    expect(linkA).toContain('/invite#');

    // Site B's admin invites the same pending person: with the mail failing, no link.
    const second = await call(
      'otherAdmin',
      'POST',
      '/members',
      { email: 'shared@example.com', role: 'editor' },
      siteB,
    );
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual({
      member: expect.objectContaining({ pending: true }) as unknown,
      mailed: false,
    });
    // Nor on a new link, from either site, now that the account is on both.
    const userId = first.json<{ member: { userId: string } }>().member.userId;
    for (const [who, site] of [
      ['otherAdmin', siteB],
      ['admin', siteA],
    ] as const) {
      const again = await call(who, 'POST', `/members/${userId}/invite`, undefined, site);
      expect(again.json()).not.toHaveProperty('link');
    }
    mailFails = false;

    // The link site A handed out still works.
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      headers: headers(),
      payload: { token: linkA.split('#')[1], newPassword: 'shared person password' },
    });
    expect(accepted.statusCode).toBe(200);
  });
});
