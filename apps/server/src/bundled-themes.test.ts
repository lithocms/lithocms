import { createDb, runMigrations, schema, type Db } from '@lithocms/core';
import { startTestDatabase, type TestDatabase } from '@lithocms/core/testing';
import type { FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createAuth } from './auth.js';
import { seedDemo } from './dev-demo.js';
import { createSiteResolver } from './sites.js';
import { loadBundledThemes } from './themes.js';
import { createDiskStore } from '@lithocms/core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The themes shipped in the image, rendered with the dev stack's sample content.
const THEMES_DIR = fileURLToPath(new URL('../../../themes', import.meta.url));
const secret = 'test-secret-test-secret-test-secret!';

let tdb: TestDatabase;
let db: Db;
let pools: Pool[];
let app: FastifyInstance;

const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'demo.example' } });

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  const owner = createDb(tdb.ownerUrl);
  const runtime = createDb(tdb.appUrl);
  db = runtime.db;
  pools = [owner.pool, runtime.pool];
  const themes = await loadBundledThemes(
    THEMES_DIR,
    owner.db,
    ['corporate'],
    pino({ level: 'silent' }),
  );
  const [site] = await owner.db.insert(schema.sites).values({ name: 'Demo' }).returning();
  await owner.db
    .insert(schema.siteDomains)
    .values({ domain: 'demo.example', siteId: site!.id, isPrimary: true });
  const [user] = await owner.db
    .insert(schema.users)
    .values({ name: 'Owner', email: 'owner@example.com' })
    .returning();
  const store = createDiskStore(await mkdtemp(join(tmpdir(), 'litho-demo-')));
  await seedDemo(db, themes, store, site!.id, user!.id);
  // A second run leaves the site alone.
  await seedDemo(db, themes, store, site!.id, user!.id);
  const adminUrl = new URL('https://admin.example.net');
  app = buildApp({
    db,
    sites: await createSiteResolver(db),
    adminUrl,
    auth: createAuth({ db, adminUrl, secret }),
    secret,
    store,
    themes,
    logLevel: 'silent',
  });
});

afterAll(async () => {
  await app.close();
  await Promise.all(pools.map((p) => p.end()));
  await tdb.stop();
});

describe('corporate theme', () => {
  it('renders the home page from its sections', async () => {
    const res = await get('/');
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain('<html lang="tr"');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    for (const part of [
      'class="hero-name display-fit" style="--chars: 5">Kuzey</h1>',
      'id="programs"',
      'id="schedule"',
      'id="faq"',
      'Sınıflar kaç kişilik?',
      'Bu bir örnek görüştür',
      'IELTS Reading bölümünde zamanı yönetmek',
      'href="mailto:merhaba@example.com"',
      'href="https://wa.me/905550000000?text=Merhaba%2C',
      'Kadıköy',
    ]) {
      expect(html, part).toContain(part);
    }
    // Self-hosted fonts only.
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });

  it('renders pages, the contact form, posts, search and 404', async () => {
    const contact = await get('/iletisim/');
    expect(contact.statusCode).toBe(200);
    expect(contact.body).toContain('class="litho-form');
    expect(contact.body).toContain('İlgilendiğiniz program');
    expect((await get('/hakkimizda/')).body).toContain('<h2>Nasıl çalışıyoruz</h2>');
    const search = await get('/?s=ielts');
    expect(search.body).toContain('IELTS Reading bölümünde zamanı yönetmek');
    const missing = await get('/yok/');
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('Bu sayfa yok');
  });

  it('serves its fonts and stylesheet', async () => {
    const html = (await get('/')).body;
    for (const path of [
      /\/assets\/\w+\/theme\.css/,
      /\/assets\/\w+\/fonts\/eb-garamond-normal-latin\.woff2/,
    ]) {
      const url = path.exec(html)?.[0];
      expect(url, String(path)).toBeDefined();
      expect((await get(url!)).statusCode).toBe(200);
    }
  });
});
