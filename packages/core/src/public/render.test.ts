import { createThemeEngine, ThemeManifest } from '@lithocms/theme-engine';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../content/audit.js';
import { DocInput } from '../content/input.js';
import {
  CollectionCreateInput,
  createCollection,
  EntryInput,
  updateCollection,
  upsertEntry,
} from '../content/collections.js';
import { MenuUpdateInput, updateMenu } from '../content/menus.js';
import { updateSlot } from '../content/slots.js';
import { Forbidden } from '../errors.js';
import {
  createPost,
  listPosts,
  PostCreateInput,
  PostListQuery,
  publishPost,
} from '../content/posts.js';
import { createTerm } from '../content/terms.js';
import { createDb, runMigrations, withSite, type Db, type Tx } from '../db/client.js';
import { sites, users } from '../db/schema.js';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import { renderPublic, type PublicResponse, type PublicTheme } from './render.js';

const manifest = {
  name: 'Test',
  slug: 'test',
  version: '1.0.0',
  tokens: { colors: { bg: '#fff' }, fonts: { body: 'Georgia, serif' } },
  dark_tokens: { colors: { bg: '#000' } },
  settings: [{ id: 'show_author', type: 'boolean', default: true }],
};
const files = {
  'theme.json': JSON.stringify(manifest),
  'layouts/base.liquid':
    '<html><head>{% seo %}<style>{{ theme.css_variables }}</style>{% head_extras %}</head>' +
    '<body data-type="{{ request.page_type }}">{{ content_for_layout }}{% body_extras %}</body></html>',
  'templates/index.liquid':
    '{% paginate posts by 2 %}{% for p in posts %}<a class="post" href="{{ p.url }}">{{ p.title }}</a>{% endfor %}' +
    '<nav>{{ paginate.current_page }}/{{ paginate.pages }}{% if paginate.next %} <a rel="next" href="{{ paginate.next.url }}">next</a>{% endif %}</nav>{% endpaginate %}',
  'templates/post.liquid':
    '<h1>{{ post.title }}</h1><p class="by">{{ post.author.name }}</p>{{ post.content }}' +
    '<p class="cat">{{ post.primary_category.name }} {{ post.primary_category.url }}</p>' +
    '{% for t in post.tags %}<i>{{ t.name }}</i>{% endfor %}<p class="ex">{{ post.excerpt }}</p>' +
    '<nav>{% for i in menus.primary.items %}<a{% if i.active %} aria-current="page"{% endif %} href="{{ i.url }}">{{ i.label }}</a>' +
    '{% for c in i.children %}<a class="sub" href="{{ c.url }}">{{ c.label }}</a>{% endfor %}{% endfor %}</nav>',
  'templates/page.liquid':
    '<h1>{{ page.title }}</h1>{% if page.parent %}<a class="parent" href="{{ page.parent.url }}">{{ page.parent.title }}</a>{% endif %}' +
    '{% for c in page.children %}<a class="child" href="{{ c.url }}">{{ c.title }}</a>{% endfor %}',
  'templates/category.liquid':
    '<h1>{{ term.name }} ({{ term.post_count }})</h1>{% for a in term.ancestors %}<b>{{ a.name }}</b>{% endfor %}' +
    '{% for p in posts %}<a class="post" href="{{ p.url }}">{{ p.title }}</a>{% endfor %}',
  'templates/search.liquid':
    '<h1>{{ search.terms }}</h1>{% slot "ad" %}{% slot "off" %}{% slot "none" %}' +
    '{% for e in collections.faq.entries %}<dl><dt>{{ e.question }}</dt><dd>{{ e.answer }}</dd>' +
    '{% if e.link %}<a href="{{ e.link.url }}">{{ e.link.title }}</a>{% endif %}</dl>{% endfor %}',
  'templates/404.liquid': '<h1>Not here</h1>',
};
const theme: PublicTheme = {
  engine: createThemeEngine(files),
  manifest: ThemeManifest.parse(manifest),
  assetUrl: (path) => `/assets/abc/${path}`,
};

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let siteId: string;
let editor: Actor;

const inSite = <T>(fn: (tx: Tx) => Promise<T>) => withSite(db, siteId, fn);
const get = (path: string, search?: string) =>
  inSite((tx) => renderPublic(tx, siteId, theme, { path, search, origin: 'https://example.com' }));
const html = async (path: string, search?: string) => {
  const res = await get(path, search);
  if (res.status === 301) throw new Error(`redirected to ${res.location}`);
  return res.html;
};
const links = (page: string, cls: string) =>
  [...page.matchAll(new RegExp(`class="${cls}" href="([^"]+)"`, 'g'))].map((m) => m[1]);

async function publish(input: Record<string, unknown>, at: string) {
  return inSite(async (tx) => {
    const p = await createPost(
      tx,
      siteId,
      editor,
      PostCreateInput.parse({ type: 'post', ...input }),
    );
    return publishPost(tx, siteId, editor, p.id, new Date(at));
  });
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  ({ db, pool } = createDb(tdb.appUrl));
  const [site] = await db
    .insert(sites)
    .values({
      name: 'Örnek',
      locale: 'tr',
      timezone: 'Europe/Istanbul',
      settings: { tagline: 'Haberler', social: { x: 'https://x.com/ornek', bad: 'javascript:1' } },
    })
    .returning();
  siteId = site!.id;
  const [user] = await db
    .insert(users)
    .values({ name: 'Ayşe', email: 'a@example.com' })
    .returning();
  editor = { userId: user!.id, role: 'editor', channel: 'admin' };

  const news = await inSite((tx) =>
    createTerm(tx, siteId, editor, { taxonomy: 'category', name: 'Haber' }),
  );
  const world = await inSite((tx) =>
    createTerm(tx, siteId, editor, { taxonomy: 'category', name: 'Dünya', parentId: news.id }),
  );
  const tag = await inSite((tx) =>
    createTerm(tx, siteId, editor, { taxonomy: 'tag', name: 'Ekonomi' }),
  );

  await publish({ title: 'Bir', termIds: [news.id] }, '2026-01-10T09:00:00Z');
  await publish({ title: 'İki', termIds: [world.id, tag.id] }, '2026-02-10T09:00:00Z');
  await publish(
    {
      title: 'Üç <script>alert(1)</script>',
      slug: 'uc',
      termIds: [world.id],
      content: DocInput.parse({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Merhaba <dünya> & herkes' }] },
        ],
      }),
    },
    '2026-03-10T09:00:00Z',
  );
  const about = await publish({ type: 'page', title: 'Hakkımızda' }, '2026-01-01T09:00:00Z');
  const draft = await inSite((tx) =>
    createPost(tx, siteId, editor, PostCreateInput.parse({ type: 'page', title: 'Taslak' })),
  );
  const uc = await inSite(
    async (tx) => (await listPosts(tx, siteId, PostListQuery.parse({ query: 'Üç' }))).items[0]!,
  );
  await inSite((tx) =>
    updateMenu(
      tx,
      siteId,
      editor,
      'primary',
      MenuUpdateInput.parse({
        items: [
          {
            label: 'Haber',
            kind: 'term',
            ref: news.id,
            children: [{ label: 'Üç', kind: 'post', ref: uc.id }],
          },
          { label: 'Taslak', kind: 'post', ref: draft.id },
          { label: 'Dış', kind: 'url', url: 'https://example.org/' },
        ],
      }),
    ),
  );
  await publish({ type: 'page', title: 'Ekip', parentId: about.id }, '2026-01-01T09:00:00Z');
});

afterAll(async () => {
  await pool.end();
  await tdb.stop();
});

describe('renderPublic', () => {
  it('lists posts newest first, paginated by the template', async () => {
    const first = await html('/');
    expect(links(first, 'post')).toEqual(['/uc/', '/iki/']);
    expect(first).toContain('1/2 <a rel="next" href="/page/2/">');
    expect(first).toContain('<title>Örnek – Haberler</title>');
    expect(first).toContain('"@type":"WebSite"');
    expect(links(await html('/page/2/'), 'post')).toEqual(['/bir/']);
    expect(await html('/page/2/')).toContain('<title>Örnek – Haberler – Sayfa 2</title>');
    expect((await get('/page/3/')).status).toBe(404);
  });

  it('renders a post with escaped fields and SEO tags', async () => {
    const page = await html('/uc/');
    expect(page).toContain('<h1>Üç &lt;script&gt;alert(1)&lt;/script&gt;</h1>');
    expect(page).not.toContain('<script>alert');
    expect(page).toContain('<p class="by">Ayşe</p>');
    expect(page).toContain('<p>Merhaba &lt;dünya&gt; &amp; herkes</p>');
    expect(page).toContain('<p class="ex">Merhaba &lt;dünya&gt; &amp; herkes</p>');
    expect(page).toContain('<p class="cat">Dünya /kategori/haber/dunya/</p>');
    expect(page).toContain('<link rel="canonical" href="https://example.com/uc/">');
    expect(page).toContain('<meta property="og:type" content="article">');
    expect(page).toContain(
      '<meta name="description" content="Merhaba &lt;dünya&gt; &amp; herkes">',
    );
    // JSON-LD cannot be closed early by content.
    const ld = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page)![1]!;
    expect(ld).not.toMatch(/[<>]/);
    expect(JSON.parse(ld)).toMatchObject({ '@type': 'BlogPosting', author: { name: 'Ayşe' } });
    expect(await html('/iki/')).toContain('<i>Ekonomi</i>');
  });

  it('renders menus with live links and the active trail', async () => {
    const nav = /<nav>(.*?)<\/nav>/s.exec(await html('/uc/'))![1];
    expect(nav).toBe(
      '<a aria-current="page" href="/kategori/haber/">Haber</a><a class="sub" href="/uc/">Üç</a>' +
        '<a href="https://example.org/">Dış</a>',
    );
  });

  it('renders nested pages with parent and children', async () => {
    expect(links(await html('/hakkimizda/'), 'child')).toEqual(['/hakkimizda/ekip/']);
    expect(links(await html('/hakkimizda/ekip/'), 'parent')).toEqual(['/hakkimizda/']);
  });

  it('includes subcategory posts in category archives', async () => {
    const page = await html('/kategori/haber/');
    expect(page).toContain('<h1>Haber (1)</h1>');
    expect(links(page, 'post')).toEqual(['/uc/', '/iki/', '/bir/']);
    const child = await html('/kategori/haber/dunya/');
    expect(child).toContain('<h1>Dünya (2)</h1><b>Haber</b>');
    expect(links(child, 'post')).toEqual(['/uc/', '/iki/']);
  });

  it('renders date archives with the index template as fallback', async () => {
    const page = await html('/2026/02/');
    expect(links(page, 'post')).toEqual(['/iki/']);
    expect(page).toContain('data-type="archive"');
    expect(page).toContain('<title>Şubat 2026 – Örnek</title>');
  });

  it('answers unknown URLs with the 404 template', async () => {
    const res = (await get('/yok/')) as Extract<PublicResponse, { html: string }>;
    expect(res.status).toBe(404);
    expect(res.html).toContain('<h1>Not here</h1>');
    expect(res.html).toContain('<meta name="robots" content="noindex">');
    expect(res.html).not.toContain('rel="canonical"');
  });

  it('redirects to the canonical form', async () => {
    expect(await get('/uc')).toEqual({ status: 301, location: '/uc/' });
  });

  it('escapes the search query and keeps search pages out of indexes', async () => {
    const page = await html('/', '<img src=x onerror=alert(1)>');
    expect(page).toContain('<h1>&lt;img src=x onerror=alert(1)&gt;</h1>');
    expect(page).toContain('<meta name="robots" content="noindex">');
  });

  it('outputs enabled slots raw and only lets admins edit them', async () => {
    const admin: Actor = { ...editor, role: 'admin' };
    await inSite(async (tx) => {
      await updateSlot(tx, siteId, admin, 'ad', {
        html: '<ins class="ad">Ad</ins>',
        enabled: true,
      });
      await updateSlot(tx, siteId, admin, 'off', { html: '<b>hidden</b>' });
    });
    await expect(
      inSite((tx) => updateSlot(tx, siteId, editor, 'ad', { enabled: false })),
    ).rejects.toBeInstanceOf(Forbidden);
    expect(await html('/', 'x')).toContain('<h1>x</h1><ins class="ad">Ad</ins></body>');
  });

  it('renders published collection entries with resolved fields', async () => {
    const doc = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const uc = await inSite(
      async (tx) => (await listPosts(tx, siteId, PostListQuery.parse({ query: 'Üç' }))).items[0]!,
    );
    await inSite(async (tx) => {
      await createCollection(
        tx,
        siteId,
        editor,
        CollectionCreateInput.parse({
          key: 'faq',
          label: 'SSS',
          fields: [
            { key: 'question', label: 'Q', type: 'text', required: true },
            { key: 'answer', label: 'A', type: 'richtext' },
            { key: 'link', label: 'Link', type: 'reference' },
          ],
        }),
      );
      const add = (data: Record<string, unknown>, status: 'draft' | 'published', sort: number) =>
        upsertEntry(tx, siteId, editor, 'faq', undefined, EntryInput.parse({ data, status, sort }));
      await add({ question: 'İkinci <b>?', answer: doc('<i>x</i>') }, 'published', 2);
      await add({ question: 'Birinci', link: { kind: 'post', id: uc.id } }, 'published', 1);
      await add({ question: 'Taslak' }, 'draft', 0);
    });
    const page = await html('/', 'x');
    expect(page).toContain(
      '<dl><dt>Birinci</dt><dd></dd><a href="/uc/">Üç &lt;script&gt;alert(1)&lt;/script&gt;</a></dl>' +
        '<dl><dt>İkinci &lt;b&gt;?</dt><dd><p>&lt;i&gt;x&lt;/i&gt;</p></dd></dl>',
    );
    expect(page).not.toContain('Taslak');

    // A field whose type changed: old values that do not fit the new type are not rendered.
    await inSite(async (tx) => {
      await upsertEntry(
        tx,
        siteId,
        editor,
        'faq',
        undefined,
        EntryInput.parse({ data: { question: 'javascript:alert(1)', link: null }, sort: 3 }),
      );
      await updateCollection(tx, siteId, editor, 'faq', {
        fields: [
          { key: 'question', label: 'Q', type: 'url' },
          { key: 'answer', label: 'A', type: 'text' },
          { key: 'link', label: 'Link', type: 'image' },
        ],
      });
    });
    const changed = await html('/', 'x');
    expect(changed).not.toContain('javascript:');
    expect(changed).toContain('<dl><dt></dt><dd></dd></dl>');
  });

  it('outputs theme tokens as CSS variables', async () => {
    expect(await html('/')).toContain(
      '<style>:root{--color-bg:#fff;--font-body:Georgia, serif;}' +
        '@media (prefers-color-scheme: dark){:root{--color-bg:#000;}}</style>',
    );
  });
});
