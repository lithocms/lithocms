import { createDb, createDiskStore, runMigrations, schema, type Db } from '@lithocms/core';
import { startTestDatabase, type TestDatabase } from '@lithocms/core/testing';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createAuth } from './auth.js';
import { createSiteResolver } from './sites.js';
import { NO_THEMES, TEST_THEME, testThemes } from './testing/themes.js';

const adminUrl = new URL('https://admin.example.net');
const secret = 'test-secret-test-secret-test-secret!';

let tdb: TestDatabase;
let db: Db;
const pools: Pool[] = [];
let app: FastifyInstance;
let bare: FastifyInstance;

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
      { name: 'B' },
    ])
    .returning();
  await db.insert(schema.siteDomains).values([
    { domain: 'a.example', siteId: site!.id, isPrimary: true },
    { domain: 'b.example', siteId: other!.id, isPrimary: true },
  ]);
  const options = {
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
});

afterAll(async () => {
  await Promise.all([app.close(), bare.close()]);
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
    expect(csp).toContain("script-src 'self' https://cdn.example.org;");
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
    expect((await get('a.example', '/nope')).headers.location).toBe('/nope/');
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
