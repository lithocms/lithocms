import { createThemeEngine, ThemeManifest } from '@lithocms/theme-engine';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../content/audit.js';
import { createPost, PostCreateInput, publishPost } from '../content/posts.js';
import { createDb, runMigrations, withSite, type Db, type Tx } from '../db/client.js';
import { media, sites, themes, users } from '../db/schema.js';
import { Forbidden, ValidationFailed } from '../errors.js';
import { renderPublic, type PublicTheme } from '../public/render.js';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import { updateThemeSection, updateThemeSettings } from './settings.js';

const manifest = ThemeManifest.parse({
  name: 'T',
  slug: 't',
  version: '1.0.0',
  tokens: { colors: { accent: '#111111', bg: '#ffffff' } },
  settings: [
    { id: 'accent', type: 'color', default: '#c2410c' },
    { id: 'whatsapp', type: 'text' },
    {
      id: 'layout',
      type: 'select',
      default: 'wide',
      options: [{ value: 'wide' }, { value: 'narrow' }],
    },
    { id: 'cta', type: 'url', default: '/iletisim/' },
  ],
  page_templates: [{ key: 'page.landing', label: { en: 'Landing' }, sections: true }],
});
const heroSchema = {
  name: { en: 'Hero' },
  settings: [
    { id: 'heading', type: 'text', default: 'Hoş geldiniz' },
    { id: 'image', type: 'image' },
  ],
  blocks: [
    {
      type: 'button',
      settings: [
        { id: 'label', type: 'text' },
        { id: 'href', type: 'url' },
      ],
    },
  ],
  max_blocks: 2,
};
const files = {
  'theme.json': JSON.stringify(manifest),
  'layouts/base.liquid':
    '<style>{{ theme.css_variables }}</style><i class="wa">{{ theme.settings.whatsapp }}</i>' +
    '<i class="layout">{{ theme.settings.layout }}|{{ theme.settings.cta }}</i>{{ content_for_layout }}{% head_extras %}{% body_extras %}',
  'templates/index.liquid': '{% section "hero" %}',
  'templates/post.liquid': '',
  'templates/page.liquid': '',
  'templates/page.landing.liquid': '{% sections %}',
  'templates/category.liquid': '',
  'templates/search.liquid': '',
  'templates/404.liquid': '',
  'sections/hero.liquid':
    '<h1>{{ section.settings.heading }}</h1>{% if section.settings.image %}<img src="{{ section.settings.image.url }}">{% endif %}' +
    '{% for b in section.blocks %}<a href="{{ b.settings.href }}">{{ b.settings.label }}</a>{% endfor %}' +
    `{% schema %}${JSON.stringify(heroSchema)}{% endschema %}`,
};

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let siteId: string;
let otherSiteId: string;
let theme: PublicTheme;
let admin: Actor;
let editor: Actor;
let imageId: string;

const inSite = <T>(fn: (tx: Tx) => Promise<T>) => withSite(db, siteId, fn);
const render = async (path = '/', site = siteId) => {
  const res = await withSite(db, site, (tx) =>
    renderPublic(tx, site, theme, { path, origin: 'https://example.com', secret: 'x' }),
  );
  if (!('html' in res)) throw new Error('redirected');
  return res.html;
};

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  const owner = createDb(tdb.ownerUrl);
  ({ db, pool } = createDb(tdb.appUrl));
  const [a, b] = await owner.db
    .insert(sites)
    .values([{ name: 'A' }, { name: 'B' }])
    .returning();
  siteId = a!.id;
  otherSiteId = b!.id;
  const [row] = await owner.db
    .insert(themes)
    .values({ slug: 't', name: 'T', origin: 'bundled' })
    .returning();
  await owner.pool.end();
  theme = {
    themeId: row!.id,
    engine: createThemeEngine(files),
    manifest,
    assetUrl: (p) => `/assets/x/${p}`,
  };
  const [u] = await db.insert(users).values({ name: 'A', email: 'a@example.com' }).returning();
  admin = { userId: u!.id, role: 'admin', channel: 'admin' };
  editor = { ...admin, role: 'editor' };
  const [m] = await inSite((tx) =>
    tx
      .insert(media)
      .values({
        siteId,
        path: 'a.jpg',
        originalName: 'a.jpg',
        mime: 'image/jpeg',
        size: 1,
        width: 10,
        height: 10,
      })
      .returning(),
  );
  imageId = m!.id;
});

afterAll(async () => {
  await pool.end();
  await tdb.stop();
});

describe('theme settings', () => {
  it('render defaults until saved', async () => {
    const page = await render();
    expect(page).toContain('--color-accent:#c2410c;');
    expect(page).toContain('<i class="layout">wide|/iletisim/</i>');
    expect(page).toContain('<h1>Hoş geldiniz</h1>');
  });

  it('are validated and admin-only', async () => {
    const save = (actor: Actor, input: unknown) =>
      inSite((tx) =>
        updateThemeSettings(tx, siteId, actor, theme.themeId, manifest.settings!, input),
      );
    await expect(save(editor, { whatsapp: '905550000000' })).rejects.toBeInstanceOf(Forbidden);
    for (const bad of [
      { accent: 'red;}body{display:none' },
      { layout: 'other' },
      { cta: 'javascript:alert(1)' },
      { unknown: 1 },
    ]) {
      await expect(save(admin, bad)).rejects.toBeInstanceOf(ValidationFailed);
    }
    await save(admin, { accent: '#0f766e', whatsapp: '<b>905550000000</b>', layout: 'narrow' });
    const page = await render();
    expect(page).toContain('--color-accent:#0f766e;');
    expect(page).toContain('<i class="wa">&lt;b&gt;905550000000&lt;/b&gt;</i>');
    expect(page).toContain('<i class="layout">narrow|/iletisim/</i>');
    // Another site keeps its own (default) values.
    expect(await render('/', otherSiteId)).toContain('--color-accent:#c2410c;');
  });

  it('store static sections with resolved images and validated blocks', async () => {
    const save = (input: unknown) =>
      inSite((tx) =>
        updateThemeSection(
          tx,
          siteId,
          admin,
          theme.themeId,
          'hero',
          theme.engine.sections.hero!,
          input,
        ),
      );
    await expect(save({ blocks: [{ type: 'video', settings: {} }] })).rejects.toBeInstanceOf(
      ValidationFailed,
    );
    const button = { type: 'button', settings: { label: 'Ara', href: 'tel:+905550000000' } };
    await expect(save({ blocks: [button, button, button] })).rejects.toBeInstanceOf(
      ValidationFailed,
    );
    await save({ settings: { heading: 'Kurslar', image: imageId }, blocks: [button] });
    const page = await render();
    expect(page).toContain(
      '<h1>Kurslar</h1><img src="/media/a.jpg"><a href="tel:+905550000000">Ara</a>',
    );
  });

  it('render page sections, skipping unknown types and invalid values', async () => {
    const page = await inSite(async (tx) => {
      const p = await createPost(
        tx,
        siteId,
        editor,
        PostCreateInput.parse({
          type: 'page',
          title: 'Landing',
          template: 'landing',
          sections: [
            { type: 'gone', settings: {}, blocks: [] },
            { type: 'hero', settings: { heading: 42, image: imageId }, blocks: [] },
          ],
        }),
      );
      return publishPost(tx, siteId, editor, p.id);
    });
    expect(page.slug).toBe('landing');
    expect(await render('/landing/')).toContain('<h1>Hoş geldiniz</h1><img src="/media/a.jpg">');
  });
});
