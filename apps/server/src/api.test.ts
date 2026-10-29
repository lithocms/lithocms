import {
  createDb,
  createDiskStore,
  runMigrations,
  schema,
  type Db,
  type Role,
} from '@lithocms/core';
import { startTestDatabase, type TestDatabase } from '@lithocms/core/testing';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildApp } from './app.js';
import { TEST_THEME, testThemes } from './testing/themes.js';
import { createAuth, createPasswordUser } from './auth.js';
import { createSiteResolver } from './sites.js';
import { readThemeZip, writeThemeZip } from './theme-zip.js';

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

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  ({ db, pool } = createDb(tdb.appUrl));
  [siteA, siteB] = (
    await db
      .insert(schema.sites)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning()
  ).map((s) => s.id) as [string, string];
  await db.insert(schema.siteDomains).values([
    { domain: 'a.example', siteId: siteA, isPrimary: true },
    { domain: 'b.example', siteId: siteB, isPrimary: true },
  ]);
  mediaDir = await mkdtemp(join(tmpdir(), 'litho-api-media-'));
  const owner = createDb(tdb.ownerUrl);
  const themes = await testThemes(owner.db, {
    test: {
      ...TEST_THEME,
      'theme.json': JSON.stringify({
        name: 'Test',
        slug: 'test',
        version: '1.0.0',
        settings: [{ id: 'whatsapp', type: 'text' }],
      }),
      'sections/hero.liquid':
        '<h1>{{ section.settings.heading }}</h1>{% schema %}{"name":{"en":"Hero"},"settings":[{"id":"heading","type":"text"}]}{% endschema %}',
    },
  });
  await owner.pool.end();
  const auth = createAuth({ db, adminUrl, secret });
  const sites = await createSiteResolver(db);
  const store = createDiskStore(mediaDir);
  app = buildApp({
    db,
    sites,
    adminUrl,
    auth,
    secret,
    store,
    themes,
    logLevel: 'silent',
  });

  const people: [string, Role | null, string, boolean][] = [
    ['editor', 'editor', siteA, false],
    ['author', 'author', siteA, false],
    ['outsider', 'admin', siteB, false],
    ['root', null, siteA, true],
  ];
  let ip = 0;
  for (const [name, role, siteId, isInstanceOwner] of people) {
    const email = `${name}@example.com`;
    const user = await createPasswordUser(auth, { email, name, password, isInstanceOwner });
    if (role) await db.insert(schema.memberships).values({ userId: user.id, siteId, role });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { host: ADMIN, origin: adminUrl.origin, 'x-forwarded-for': `192.0.2.${++ip}` },
      payload: { email, password },
    });
    cookies[name] = String(res.headers['set-cookie']).split(';')[0]!;
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await tdb.stop();
  await rm(mediaDir, { recursive: true, force: true });
});

function call(
  who: string | null,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    headers: {
      host: ADMIN,
      origin: adminUrl.origin,
      ...(who ? { cookie: cookies[who] } : {}),
    },
    ...(payload ? { payload } : {}),
  });
}
const a = (path: string) => `/api/sites/${siteA}${path}`;

const doc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
};

describe('admin API', () => {
  it('requires a session', async () => {
    const res = await call(null, 'GET', a('/posts'));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('creates, reads, updates and lists posts', async () => {
    const created = await call('author', 'POST', a('/posts'), {
      type: 'post',
      title: 'First',
      content: doc,
    });
    expect(created.statusCode).toBe(201);
    const post = created.json<{ id: string; status: string; contentHtml: string }>();
    expect(post).toMatchObject({ status: 'draft', contentHtml: '<p>Hi</p>' });

    const updated = await call('author', 'PATCH', a(`/posts/${post.id}`), { title: 'First!' });
    expect(updated.json()).toMatchObject({ title: 'First!', slug: 'first' });
    expect((await call('editor', 'GET', a(`/posts/${post.id}`))).json()).toMatchObject({
      title: 'First!',
    });

    const list = await call('editor', 'GET', a('/posts?query=first&limit=10'));
    expect(list.json()).toMatchObject({ items: [{ id: post.id }], nextCursor: null });
    const revisions = await call('author', 'GET', a(`/posts/${post.id}/revisions`));
    expect(revisions.json()).toHaveLength(2);
  });

  it('publishes and schedules only for editors', async () => {
    const { id } = (
      await call('author', 'POST', a('/posts'), { type: 'post', title: 'Pub' })
    ).json<{
      id: string;
    }>();
    const denied = await call('author', 'POST', a(`/posts/${id}/publish`), {});
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'forbidden' });

    const at = '2030-01-01T09:00:00+03:00';
    const scheduled = await call('editor', 'POST', a(`/posts/${id}/publish`), { at });
    expect(scheduled.json()).toMatchObject({
      status: 'scheduled',
      publishedAt: '2030-01-01T06:00:00.000Z',
    });
    expect((await call('editor', 'POST', a(`/posts/${id}/trash`))).json()).toMatchObject({
      status: 'trash',
    });
    const conflict = await call('editor', 'POST', a(`/posts/${id}/publish`), {});
    expect(conflict.statusCode).toBe(409);
  });

  it('reports validation errors with paths', async () => {
    const missing = await call('author', 'POST', a('/posts'), { type: 'post' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({
      error: 'validation_failed',
      issues: [{ path: ['title'] }],
    });

    const badContent = await call('author', 'POST', a('/posts'), {
      type: 'post',
      title: 'Bad',
      content: { type: 'doc', content: [{ type: 'iframe' }] },
    });
    expect(badContent.statusCode).toBe(400);
    expect(badContent.json<{ issues: { path: string[] }[] }>().issues[0]?.path.slice(0, 3)).toEqual(
      ['content', 'content', '0'],
    );

    const extra = await call('author', 'PATCH', a(`/posts/00000000-0000-7000-8000-000000000000`), {
      authorId: 'x',
    });
    expect(extra.statusCode).toBe(400);
  });

  it('manages terms for editors only', async () => {
    const created = await call('editor', 'POST', a('/terms'), {
      taxonomy: 'category',
      name: 'Haberler',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ slug: 'haberler', path: 'haberler' });
    expect(
      (await call('author', 'POST', a('/terms'), { taxonomy: 'tag', name: 'x' })).statusCode,
    ).toBe(403);
    const list = await call('author', 'GET', a('/terms?taxonomy=category'));
    expect(list.json()).toMatchObject([{ name: 'Haberler' }]);
  });

  it('manages menus for editors only', async () => {
    const items = [{ label: 'Ana sayfa', kind: 'url', url: '/' }];
    const saved = await call('editor', 'PUT', a('/menus/primary'), { items });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      location: 'primary',
      items: [{ label: 'Ana sayfa', url: '/' }],
    });
    expect((await call('author', 'PUT', a('/menus/primary'), { items })).statusCode).toBe(403);
    expect((await call('author', 'GET', a('/menus'))).json()).toMatchObject([
      { location: 'primary' },
    ]);
    const bad = await call('editor', 'PUT', a('/menus/primary'), {
      items: [{ label: 'x', kind: 'url', url: 'javascript:alert(1)' }],
    });
    expect(bad.statusCode).toBe(400);
    expect((await call('editor', 'GET', a('/menus/Bad%20Key'))).statusCode).toBe(400);
  });

  it('manages collections and entries', async () => {
    const created = await call('editor', 'POST', a('/collections'), {
      key: 'faq',
      label: 'SSS',
      fields: [{ key: 'question', label: 'Soru', type: 'text', required: true }],
    });
    expect(created.statusCode).toBe(201);
    const added = await call('editor', 'POST', a('/collections/faq/entries'), {
      data: { question: 'Nasıl?' },
    });
    expect(added.statusCode).toBe(201);
    const id = added.json<{ id: string }>().id;
    const invalid = await call('editor', 'PATCH', a(`/collections/faq/entries/${id}`), {
      data: { answer: 'x' },
    });
    expect(invalid.statusCode).toBe(400);
    expect((await call('author', 'GET', a('/collections/faq/entries'))).json()).toMatchObject([
      { id, data: { question: 'Nasıl?' } },
    ]);
    expect(
      (await call('author', 'POST', a('/collections/faq/entries'), { data: { question: 'x' } }))
        .statusCode,
    ).toBe(403);
    expect((await call('editor', 'DELETE', a(`/collections/faq/entries/${id}`))).statusCode).toBe(
      204,
    );
    expect((await call('editor', 'GET', a('/collections/nope'))).statusCode).toBe(404);
  });

  it('lets only admins manage forms and read submissions', async () => {
    const body = { fields: [{ key: 'email', label: 'E-posta', type: 'email', required: true }] };
    expect((await call('editor', 'PUT', a('/forms/contact'), body)).statusCode).toBe(403);
    const saved = await call('root', 'PUT', a('/forms/contact'), body);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ key: 'contact', consentText: '' });
    expect((await call('root', 'GET', a('/forms/contact/submissions'))).json()).toEqual([]);
    expect((await call('editor', 'GET', a('/forms/contact/submissions'))).statusCode).toBe(403);
    // Definitions carry notification addresses.
    expect((await call('editor', 'GET', a('/forms'))).statusCode).toBe(403);
    expect((await call('editor', 'GET', a('/forms/contact'))).statusCode).toBe(403);
  });

  it('lets only admins edit slots', async () => {
    const body = { html: '<div id="ad"></div>', enabled: true };
    expect((await call('editor', 'PUT', a('/slots/header-ad'), body)).statusCode).toBe(403);
    const saved = await call('root', 'PUT', a('/slots/header-ad'), body);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ key: 'header-ad', enabled: true });
    expect((await call('editor', 'GET', a('/slots'))).json()).toMatchObject([{ key: 'header-ad' }]);
  });

  it('hides other sites and their posts', async () => {
    const { id } = (
      await call('editor', 'POST', a('/posts'), { type: 'post', title: 'Secret' })
    ).json<{
      id: string;
    }>();
    const notMember = await call('outsider', 'GET', a('/posts'));
    expect(notMember.statusCode).toBe(404);
    expect(notMember.json()).toMatchObject({ error: 'not_found' });
    // Through a site they do belong to, the other site's post does not exist.
    const viaOwnSite = await call('outsider', 'GET', `/api/sites/${siteB}/posts/${id}`);
    expect(viaOwnSite.statusCode).toBe(404);
    expect((await call('editor', 'GET', '/api/sites/not-a-uuid/posts')).statusCode).toBe(404);
  });

  it('lets the instance owner into every site', async () => {
    expect((await call('root', 'GET', `/api/sites/${siteB}/posts`)).statusCode).toBe(200);
  });

  it('records the admin channel and an IP hash in the audit log', async () => {
    const { id } = (
      await call('editor', 'POST', a('/posts'), { type: 'post', title: 'Audited' })
    ).json<{
      id: string;
    }>();
    const rows = await db.transaction(async (tx) => {
      await tx.execute(`select set_config('app.site_id', '${siteA}', true)`);
      return tx.query.auditLog.findMany({ where: (l, { eq }) => eq(l.entityId, id) });
    });
    expect(rows).toMatchObject([
      { action: 'post.create', channel: 'admin', ipHash: expect.any(String) as unknown },
    ]);
  });

  it('rejects writes from other origins', async () => {
    const res = await app.inject({
      method: 'POST',
      url: a('/posts'),
      headers: { host: ADMIN, origin: 'https://evil.example', cookie: cookies.editor },
      payload: { type: 'post', title: 'csrf' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('settings', () => {
  it('reads for members, writes for admins, validated', async () => {
    expect((await call('editor', 'GET', a('/settings'))).json()).toMatchObject({
      name: 'A',
      searchEngines: true,
    });
    expect((await call('editor', 'PATCH', a('/settings'), { name: 'B' })).statusCode).toBe(403);
    for (const bad of [
      { timezone: 'Mars/Base' },
      { locale: 'xx' },
      { social: { x: 'javascript:alert(1)' } },
      { name: '' },
      { unknown: 1 },
    ]) {
      expect(
        (await call('root', 'PATCH', a('/settings'), bad)).statusCode,
        JSON.stringify(bad),
      ).toBe(400);
    }
    const res = await call('root', 'PATCH', a('/settings'), {
      tagline: 'Haberler',
      timezone: 'Europe/Istanbul',
      social: { instagram: 'https://instagram.com/a' },
      searchEngines: false,
    });
    expect(res.json()).toMatchObject({
      name: 'A',
      tagline: 'Haberler',
      timezone: 'Europe/Istanbul',
      social: { instagram: 'https://instagram.com/a' },
      searchEngines: false,
    });
    expect((await call('outsider', 'PATCH', a('/settings'), { name: 'X' })).statusCode).toBe(404);
  });
});

describe('theme', () => {
  it('lists the active theme with its settings and sections', async () => {
    const res = await call('editor', 'GET', a('/theme'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      slug: 'test',
      settings: [{ id: 'whatsapp', type: 'text' }],
      values: {},
      sections: [{ name: 'hero', data: null }],
    });
  });

  it('saves settings and sections for admins only, validated, per site', async () => {
    expect((await call('editor', 'PUT', a('/theme/settings'), { whatsapp: '1' })).statusCode).toBe(
      403,
    );
    expect((await call('root', 'PUT', a('/theme/settings'), { nope: '1' })).statusCode).toBe(400);
    expect(
      (await call('outsider', 'PUT', a('/theme/settings'), { whatsapp: '1' })).statusCode,
    ).toBe(404);
    const saved = await call('root', 'PUT', a('/theme/settings'), { whatsapp: '905550000000' });
    expect(saved.json()).toEqual({ values: { whatsapp: '905550000000' } });
    expect((await call('root', 'PUT', a('/theme/sections/none'), {})).statusCode).toBe(404);
    expect(
      (await call('root', 'PUT', a('/theme/sections/hero'), { settings: { heading: 1 } }))
        .statusCode,
    ).toBe(400);
    const hero = await call('root', 'PUT', a('/theme/sections/hero'), {
      settings: { heading: 'Merhaba' },
    });
    expect(hero.json()).toEqual({ settings: { heading: 'Merhaba' }, blocks: [] });
    expect((await call('root', 'GET', a('/theme'))).json()).toMatchObject({
      values: { whatsapp: '905550000000' },
      sections: [{ name: 'hero', data: { settings: { heading: 'Merhaba' } } }],
    });
    const b = await call('outsider', 'GET', `/api/sites/${siteB}/theme`);
    expect(b.json()).toMatchObject({ values: {}, sections: [{ name: 'hero', data: null }] });
  });
});

describe('media', () => {
  const upload = (who: string, body: Buffer, type: string, query = 'filename=pic.jpg&alt=Pic') =>
    app.inject({
      method: 'POST',
      url: a(`/media?${query}`),
      headers: { host: ADMIN, origin: adminUrl.origin, cookie: cookies[who], 'content-type': type },
      payload: body,
    });

  it('uploads raw bytes and sniffs the type', async () => {
    const png = await sharp({
      create: { width: 900, height: 300, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer();
    const res = await upload('author', png, 'image/jpeg');
    expect(res.statusCode).toBe(201);
    const media = res.json<{ id: string; path: string; mime: string; variants: unknown[] }>();
    expect(media).toMatchObject({ mime: 'image/png', alt: 'Pic', originalName: 'pic.jpg' });
    expect(media.variants).toHaveLength(4);

    const listed = await call('editor', 'GET', a('/media'));
    expect(listed.json()).toMatchObject({ items: [{ id: media.id }] });

    // Served on the site's own origin only.
    const file = await app.inject({
      method: 'GET',
      url: `/media/${media.path}`,
      headers: { host: 'a.example' },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers).toMatchObject({
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    expect(file.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    for (const host of ['b.example', ADMIN]) {
      const other = await app.inject({
        method: 'GET',
        url: `/media/${media.path}`,
        headers: { host },
      });
      expect(other.statusCode, host).toBe(404);
    }
  });

  it('rejects files that are not images, whatever the declared type', async () => {
    const res = await upload('author', Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_failed', issues: [{ path: ['file'] }] });
    expect(
      (await upload('author', Buffer.from('x'), 'image/png', 'alt=no-filename')).statusCode,
    ).toBe(400);
  });

  it('does not serve paths outside the media layout', async () => {
    for (const url of ['/media/../../etc/passwd', '/media/2026/10/x.jpg', '/media/%2e%2e/secret']) {
      const res = await app.inject({ method: 'GET', url, headers: { host: 'a.example' } });
      // Never a file: 404 from the media route, or a theme page or redirect after normalization.
      expect([301, 404], url).toContain(res.statusCode);
      expect(String(res.headers['content-type']), url).not.toMatch(/^image\//);
    }
  });
});

describe('theme library', () => {
  const uploaded = (version: string, marker = 'Uploaded') => ({
    ...TEST_THEME,
    'theme.json': JSON.stringify({ name: 'Uploaded', slug: 'uploaded', version }),
    'templates/index.liquid': `<h1>${marker} {{ site.name }}</h1>`,
    'README.md': '# Uploaded\n',
  });
  const send = async (who: string, files: Record<string, string>, site = siteA) =>
    app.inject({
      method: 'POST',
      url: `/api/sites/${site}/themes`,
      headers: {
        host: ADMIN,
        origin: adminUrl.origin,
        cookie: cookies[who],
        'content-type': 'application/zip',
      },
      payload: await writeThemeZip(files, 'uploaded'),
    });
  const home = (cookie?: string) =>
    app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'a.example', ...(cookie ? { cookie } : {}) },
    });

  it('only lets admins upload, and reports invalid themes by file', async () => {
    expect((await send('editor', uploaded('1.0.0'))).statusCode).toBe(403);
    const broken = { ...uploaded('1.0.0') } as Record<string, string>;
    delete broken['templates/404.liquid'];
    const res = await send('root', broken);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: 'theme_invalid',
      report: { valid: false, errors: [{ path: 'templates/404.liquid', rule: 'required' }] },
    });
    const notZip = await app.inject({
      method: 'POST',
      url: a('/themes'),
      headers: {
        host: ADMIN,
        origin: adminUrl.origin,
        cookie: cookies.root,
        'content-type': 'application/zip',
      },
      payload: Buffer.from('not a zip'),
    });
    expect(notZip.statusCode).toBe(400);
  });

  it('uploads, previews, activates, rolls back and deletes a theme', async () => {
    const res = await send('root', uploaded('1.0.0'));
    expect(res.statusCode).toBe(201);
    const { id } = res.json<{ id: string }>();
    const library = (await call('root', 'GET', a('/themes'))).json<{
      themes: { id: string; slug: string; origin: string }[];
      activeVersionId: string | null;
    }>();
    const theme = library.themes.find((t) => t.slug === 'uploaded')!;
    expect(theme).toMatchObject({ origin: 'upload' });
    expect(library.activeVersionId).toBeNull();

    // preview: a signed link becomes a cookie on the site origin; nothing is cached
    const { url } = (await call('root', 'POST', a(`/themes/versions/${id}/preview`))).json<{
      url: string;
    }>();
    const link = new URL(url);
    expect(link.origin).toBe('https://a.example');
    const start = await app.inject({
      method: 'GET',
      url: link.pathname + link.search,
      headers: { host: 'a.example' },
    });
    expect(start.statusCode).toBe(303);
    const cookie = String(start.headers['set-cookie']).split(';')[0]!;
    const previewed = await home(cookie);
    expect(previewed.body).toContain('Uploaded A');
    expect(previewed.body).toContain('/_preview?exit=1');
    expect(previewed.headers['cache-control']).toBe('private, no-store');
    expect((await home()).body).not.toContain('Uploaded');
    // the link is bound to its site
    const elsewhere = await app.inject({
      method: 'GET',
      url: link.pathname + link.search,
      headers: { host: 'b.example' },
    });
    expect(elsewhere.statusCode).toBe(400);

    // activate; the live version cannot be overwritten, a new version can
    await call('root', 'POST', a(`/themes/versions/${id}/activate`));
    expect((await home()).body).toContain('Uploaded A');
    expect((await send('root', uploaded('1.0.0'))).statusCode).toBe(409);
    expect((await send('root', uploaded('1.0.1', 'Newer'))).statusCode).toBe(201);
    expect((await call('root', 'DELETE', a(`/themes/${theme.id}`))).statusCode).toBe(409);

    // download what was uploaded
    const zip = await call('root', 'GET', a(`/themes/versions/${id}/download`));
    expect(zip.headers['content-type']).toBe('application/zip');
    expect((await readThemeZip(zip.rawPayload))['templates/index.liquid']).toBe(
      '<h1>Uploaded {{ site.name }}</h1>',
    );

    // roll back to the default theme, then the uploaded one can go
    const back = (await call('root', 'POST', a('/themes/rollback'))).json<{
      activeVersionId: string | null;
      previousVersionId: string | null;
    }>();
    expect(back).toMatchObject({ activeVersionId: null, previousVersionId: id });
    expect((await home()).body).not.toContain('Uploaded');
    expect((await call('root', 'DELETE', a(`/themes/${theme.id}`))).statusCode).toBe(204);
    expect((await call('root', 'POST', a('/themes/rollback'))).statusCode).toBe(409);
    // a preview of a deleted version shows the live site
    expect((await home(cookie)).body).not.toContain('Uploaded');
  });

  it('keeps uploaded themes to their site', async () => {
    const res = await send('root', uploaded('2.0.0'));
    const { id } = res.json<{ id: string }>();
    const b = (path: string) => `/api/sites/${siteB}${path}`;
    const library = (await call('outsider', 'GET', b('/themes'))).json<{
      themes: { slug: string }[];
    }>();
    expect(library.themes.map((t) => t.slug)).not.toContain('uploaded');
    for (const [method, path] of [
      ['POST', `/themes/versions/${id}/activate`],
      ['POST', `/themes/versions/${id}/preview`],
      ['GET', `/themes/versions/${id}/download`],
    ] as const) {
      expect((await call('outsider', method, b(path))).statusCode, path).toBe(404);
    }
  });
});
