import {
  createDb,
  createDiskStore,
  createPost,
  createRedirect,
  formToken,
  FormUpsertInput,
  PostCreateInput,
  publishPost,
  RedirectInput,
  runMigrations,
  schema,
  updatePost,
  updateSlot,
  upsertForm,
  withSite,
  type Actor,
  type Db,
} from '@lithocms/core';
import { startTestDatabase, type TestDatabase } from '@lithocms/core/testing';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createPageCache } from './page-cache.js';
import { createAuth } from './auth.js';
import { createSiteResolver } from './sites.js';
import { NO_THEMES, TEST_THEME, testThemes } from './testing/themes.js';

const adminUrl = new URL('https://admin.example.net');
const secret = 'test-secret-test-secret-test-secret!';
const notified: { siteId: string; submissionId: string }[] = [];

let tdb: TestDatabase;
let db: Db;
const pools: Pool[] = [];
let app: FastifyInstance;
let bare: FastifyInstance;
let cached: FastifyInstance;
let cacheDir: string;
let siteA: string;
let admin: Actor;
let postId: string;

const get = (host: string, url = '/', target = app) =>
  target.inject({ method: 'GET', url, headers: { host } });

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  const runtime = createDb(tdb.appUrl);
  const owner = createDb(tdb.ownerUrl);
  pools.push(runtime.pool, owner.pool);
  db = runtime.db;
  const [site, other] = await db
    .insert(schema.sites)
    .values([
      {
        name: 'Site <A>',
        settings: { csp_allowlist: ['cdn.example.org', "evil.com 'unsafe-inline'"] },
      },
      { name: 'B', settings: { search_engines: false } },
    ])
    .returning();
  await db.insert(schema.siteDomains).values([
    { domain: 'a.example', siteId: site!.id, isPrimary: true },
    { domain: 'b.example', siteId: other!.id, isPrimary: true },
  ]);
  siteA = site!.id;
  const [user] = await db
    .insert(schema.users)
    .values({ name: 'Admin', email: 'admin@example.com' })
    .returning();
  admin = { userId: user!.id, role: 'admin', channel: 'admin' };
  await withSite(db, siteA, async (tx) => {
    const page = await createPost(
      tx,
      siteA,
      admin,
      PostCreateInput.parse({ type: 'page', title: 'İletişim' }),
    );
    await publishPost(tx, siteA, admin, page.id);
    const post = await createPost(
      tx,
      siteA,
      admin,
      PostCreateInput.parse({ type: 'post', title: 'Çay & <kahve>', excerpt: 'Kısa' }),
    );
    await publishPost(tx, siteA, admin, post.id);
    postId = post.id;
    const hidden = await createPost(
      tx,
      siteA,
      admin,
      PostCreateInput.parse({ type: 'post', title: 'Gizli', seo: { noindex: true } }),
    );
    await publishPost(tx, siteA, admin, hidden.id);
    for (const r of [
      { fromPath: '/eski-iletisim/', to: '/iletisim/' },
      { fromPath: '/kampanya', to: 'https://shop.example/sale', code: 302 },
      { fromPath: '/kaldirildi/', code: 410 },
      { fromPath: '/çay/', to: '/çaylar/' },
    ]) {
      await createRedirect(tx, siteA, admin, RedirectInput.parse(r));
    }
    await updateSlot(tx, siteA, admin, 'footer', {
      html: '<script>window.ok = 1</script><SCRIPT src="https://cdn.example.org/a.js"></SCRIPT>',
      enabled: true,
    });
    await upsertForm(
      tx,
      siteA,
      admin,
      'contact',
      FormUpsertInput.parse({
        fields: [{ key: 'email', label: 'E-posta', type: 'email', required: true }],
        successMessage: 'Aldık!',
      }),
    );
  });
  const options = {
    jobs: {
      notifyForm: (_tx: unknown, siteId: string, submissionId: string) => {
        notified.push({ siteId, submissionId });
        return Promise.resolve();
      },
      queueVariants: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    },
    db,
    sites: await createSiteResolver(db),
    adminUrl,
    auth: createAuth({ db, adminUrl, secret }),
    secret,
    store: createDiskStore(tmpdir()),
    logLevel: 'silent',
  };
  app = buildApp({ ...options, themes: await testThemes(owner.db) });
  bare = buildApp({ ...options, themes: NO_THEMES });
  cacheDir = await mkdtemp(join(tmpdir(), 'litho-cache-'));
  cached = buildApp({
    ...options,
    themes: await testThemes(owner.db),
    cache: createPageCache(cacheDir, db),
  });
});

afterAll(async () => {
  await Promise.all([app.close(), bare.close(), cached.close()]);
  await rm(cacheDir, { recursive: true, force: true });
  await Promise.all(pools.map((p) => p.end()));
  await tdb.stop();
});

describe('public pages', () => {
  it('renders with escaping, SEO and security headers', async () => {
    const res = await get('a.example');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<h1>Site &lt;A&gt;</h1>');
    expect(res.body).toContain('<link rel="canonical" href="https://a.example/">');
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toMatch(/script-src 'self' 'nonce-[\w+/=]+' https:\/\/cdn\.example\.org;/);
    expect(csp).not.toContain('evil.com');
    expect(csp).toContain("object-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers HEAD, 404s and search', async () => {
    expect(
      (await app.inject({ method: 'HEAD', url: '/', headers: { host: 'a.example' } })).statusCode,
    ).toBe(200);
    const missing = await get('a.example', '/nope/');
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('<h1>Not found</h1>');
    const search = await get('a.example', '/?s=%3Cb%3Ex');
    expect(search.body).toContain('<h1>&lt;b&gt;x</h1>');
    expect((await get('a.example', '/nope')).headers.location).toBe('https://a.example/nope/');
    for (const url of ['//evil.example', '//evil.example/x?y=1']) {
      const res = await get('a.example', url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers.location, url).toBeUndefined();
    }
  });

  it('serves fingerprinted theme assets', async () => {
    const page = await get('a.example');
    const url = /href="(\/assets\/[^"]+)"/.exec(page.body)![1]!;
    const hash = createHash('sha256')
      .update(TEST_THEME['assets/style.css']!)
      .digest('hex')
      .slice(0, 12);
    expect(url).toBe(`/assets/${hash}/style.css`);
    const css = await get('a.example', url);
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.headers['cache-control']).toContain('immutable');
    expect(css.body).toBe(TEST_THEME['assets/style.css']);
    for (const bad of [
      '/assets/000000000000/style.css',
      `/assets/${hash}/../theme.json`,
      `/assets/${hash}/theme.json`,
    ]) {
      expect((await get('a.example', bad)).statusCode, bad).toBe(404);
    }
    expect((await get(adminUrl.hostname, url)).statusCode).toBe(404);
  });

  it('says so when no theme can render', async () => {
    const res = await get('b.example', '/', bare);
    expect(res.statusCode).toBe(503);
  });
});

describe('forms', () => {
  const post = (
    body: Record<string, string>,
    headers: Record<string, string> = {},
    host = 'a.example',
  ) =>
    app.inject({
      method: 'POST',
      url: '/_forms/contact',
      headers: { host, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      payload: new URLSearchParams(body).toString(),
    });
  const token = () => formToken(secret, { siteId: siteA, key: 'contact' }, Date.now() - 10_000);

  it('renders the form with a fresh token', async () => {
    const page = await get('a.example', '/iletisim/');
    expect(page.body).toContain(
      '<form class="litho-form" id="form-contact" method="post" action="/_forms/contact">',
    );
    expect(page.body).toMatch(/name="_t" value="[0-9a-z]+\.[\w-]{22}"/);
  });

  it('stores a submission and goes back to the page with the result', async () => {
    const res = await post(
      { email: 'a@b.co', _t: token() },
      { referer: 'https://a.example/iletisim/?litho_form=contact&litho_status=error' },
    );
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(
      'https://a.example/iletisim/?litho_form=contact&litho_status=sent#form-contact',
    );
    const rows = await withSite(db, siteA, (tx) => tx.select().from(schema.formSubmissions));
    expect(rows.map((r) => r.data)).toEqual([{ email: 'a@b.co' }]);
    expect(notified).toEqual([{ siteId: siteA, submissionId: rows[0]!.id }]);
    const back = await get('a.example', '/iletisim/?litho_form=contact&litho_status=sent');
    expect(back.body).toContain('role="status">Aldık!</p>');
  });

  it('reports invalid posts and never redirects off the site', async () => {
    const res = await post({ email: 'nope', _t: token() }, { referer: 'https://evil.example/x' });
    expect(res.headers.location).toBe(
      'https://a.example/?litho_form=contact&litho_status=error#form-contact',
    );
  });

  it('answers bots like people', async () => {
    const res = await post({ email: 'a@b.co', _t: token(), _website: 'x' });
    expect(res.headers.location).toContain('litho_status=sent');
    expect(notified).toHaveLength(1);
  });

  it('404s unknown forms and the admin origin', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/_forms/nope', headers: { host: 'a.example' } }))
        .statusCode,
    ).toBe(404);
    expect((await post({ email: 'a@b.co' }, {}, adminUrl.hostname)).statusCode).toBe(404);
  });
});

describe('redirects', () => {
  it.each([
    ['/eski-iletisim/', 301, 'https://a.example/iletisim/'],
    ['/kampanya/', 302, 'https://shop.example/sale'],
    ['/%C3%A7ay/', 301, 'https://a.example/%C3%A7aylar/'],
  ])('%s', async (url, code, location) => {
    const res = await get('a.example', url);
    expect(res.statusCode).toBe(code);
    expect(res.headers.location).toBe(location);
  });

  it('answers removed URLs with 410 and the 404 template', async () => {
    const res = await get('a.example', '/kaldirildi/');
    expect(res.statusCode).toBe(410);
    expect(res.body).toContain('<h1>Not found</h1>');
  });
});

describe('robots, sitemaps and feed', () => {
  it('points robots.txt at the sitemap, or keeps engines out when asked', async () => {
    expect((await get('a.example', '/robots.txt')).body).toContain(
      'Sitemap: https://a.example/sitemap.xml',
    );
    expect((await get('b.example', '/robots.txt')).body).toBe('User-agent: *\nDisallow: /\n');
    expect((await get('b.example')).body).toContain('<meta name="robots" content="noindex">');
  });

  it('lists live, indexable content in sitemaps', async () => {
    const index = await get('a.example', '/sitemap.xml');
    expect(index.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(index.body).toContain('<loc>https://a.example/sitemap-posts-1.xml</loc>');
    expect(index.body).toContain('<loc>https://a.example/sitemap-pages-1.xml</loc>');
    const postsMap = (await get('a.example', '/sitemap-posts-1.xml')).body;
    expect(postsMap).toContain('<loc>https://a.example/cay-kahve/</loc>');
    expect(postsMap).not.toContain('gizli');
    expect((await get('a.example', '/sitemap-pages-1.xml')).body).toContain('/iletisim/</loc>');
    for (const url of ['/sitemap-posts-2.xml', '/sitemap-users-1.xml', '/sitemap-posts-0.xml']) {
      expect((await get('a.example', url)).statusCode, url).toBe(404);
    }
    expect((await get('a.example', '/wp-sitemap.xml')).headers.location).toBe(
      'https://a.example/sitemap.xml',
    );
  });

  it('publishes an escaped RSS feed and links it from pages', async () => {
    const feed = await get('a.example', '/feed/');
    expect(feed.headers['content-type']).toBe('application/rss+xml; charset=utf-8');
    expect(feed.body).toContain('<title>Çay &amp; &lt;kahve&gt;</title>');
    expect(feed.body).toContain('<link>https://a.example/cay-kahve/</link>');
    expect(feed.body).toContain('<description>Kısa</description>');
    expect((await get('a.example', '/')).body).toContain(
      '<link rel="alternate" type="application/rss+xml" title="Site &lt;A&gt;" href="https://a.example/feed/">',
    );
  });
});

describe('page cache', () => {
  const page = (url: string) => get('a.example', url, cached);

  it('serves repeat views from disk until a write purges them', async () => {
    const first = await page('/cay-kahve/');
    expect(first.headers['x-litho-cache']).toBe('miss');
    const second = await page('/cay-kahve/');
    expect(second.headers['x-litho-cache']).toBe('hit');
    // Equal but for the per-response nonce.
    const plain = (body: string) => body.replace(/nonce="[^"]+"/g, '');
    expect(plain(second.body)).toBe(plain(first.body));
    await withSite(db, siteA, (tx) => updatePost(tx, siteA, admin, postId, { excerpt: 'Yeni' }));
    expect((await page('/cay-kahve/')).headers['x-litho-cache']).toBe('miss');
    expect((await page('/cay-kahve/')).headers['x-litho-cache']).toBe('hit');
  });

  it('caches only the canonical spelling of a URL', async () => {
    for (const url of ['/CAY-KAHVE/', '/%63ay-kahve/', '/cay%2Dkahve/']) {
      const res = await page(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['x-litho-cache'], url).toBe('off');
    }
  });

  it('never caches queries, redirects or errors', async () => {
    expect((await page('/?s=cay')).headers['x-litho-cache']).toBe('off');
    expect(
      (await page('/iletisim/?litho_form=contact&litho_status=sent')).headers['x-litho-cache'],
    ).toBe('off');
    await page('/yok/');
    expect((await page('/yok/')).statusCode).toBe(404);
    expect((await page('/yok/')).headers['x-litho-cache']).toBe('miss');
    expect((await page('/eski-iletisim/')).statusCode).toBe(301);
  });

  it('sweeps files of purged entries', async () => {
    await page('/');
    await page('/');
    const files = () => readdir(join(cacheDir, siteA));
    const before = await files();
    // Any post write purges listings like the home page.
    await withSite(db, siteA, (tx) =>
      updatePost(tx, siteA, admin, postId, { excerpt: 'Daha yeni' }),
    );
    const old = new Date(Date.now() - 120_000);
    await Promise.all(before.map((f) => utimes(join(cacheDir, siteA, f), old, old)));
    await createPageCache(cacheDir, db).sweep();
    const after = await files();
    expect(after.length).toBeLessThan(before.length);
    expect(after.every((f) => before.includes(f))).toBe(true);
  });
});

describe('slot scripts', () => {
  it('run under a fresh CSP nonce on every response, cached or not', async () => {
    const nonces = [];
    for (const target of [app, cached, cached]) {
      const res = await get('a.example', '/iletisim/', target);
      const nonce = /'nonce-([^']+)'/.exec(res.headers['content-security-policy'] as string)?.[1];
      expect(nonce).toMatch(/^[\w+/]+=*$/);
      expect(res.body).toContain(
        `<script nonce="${nonce}">window.ok = 1</script><script nonce="${nonce}" src="https://cdn.example.org/a.js"></SCRIPT>`,
      );
      expect(res.body).not.toContain('litho-nonce-');
      nonces.push(nonce);
    }
    expect(new Set(nonces).size).toBe(3);
  });
});
