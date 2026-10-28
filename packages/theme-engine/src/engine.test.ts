import { describe, expect, it } from 'vitest';
import { createThemeEngine, type RenderHooks, type ThemeFiles, type ThemeImage } from './engine.js';
import { safe } from './html.js';

const BASE = '<html>{% head_extras %}<main>{{ content_for_layout }}</main>{% body_extras %}</html>';

const hooks: RenderHooks = {
  assetUrl: (p) => `/assets/${p}?v=abc`,
  headExtras: () => '<link rel="alternate" href="/feed.xml">',
  bodyExtras: () => '<script src="/core.js"></script>',
  seo: () => '<title>SEO</title>',
  commentForm: () => '<form class="comments"></form>',
  form: (key) => `<form data-key="${key}"></form>`,
  slot: (key) => (key === 'ad' ? '<div class="ad"></div>' : ''),
  section: (name) =>
    name === 'hero' ? { settings: { heading: 'Static <hero>' }, blocks: [] } : undefined,
};

function render(template: string, scope: Record<string, unknown> = {}, extra: ThemeFiles = {}) {
  const engine = createThemeEngine({
    'layouts/base.liquid': '{{ content_for_layout }}',
    'templates/index.liquid': template,
    ...extra,
  });
  return engine.render({
    template: 'index',
    scope,
    locale: 'tr',
    timezone: 'Europe/Istanbul',
    hooks,
  });
}

const IMAGE: ThemeImage = {
  url: '/media/a.jpg',
  width: 1600,
  height: 900,
  alt: 'A "cat"',
  variants: [
    { width: 400, url: '/media/a-400.webp' },
    { width: 800, url: '/media/a-800.webp' },
    { width: 1600, url: '/media/a-1600.webp' },
  ],
};

describe('layout and escaping', () => {
  it('wraps templates in the base layout with core extras', async () => {
    const engine = createThemeEngine({
      'layouts/base.liquid': BASE,
      'templates/index.liquid': 'hi',
    });
    expect(
      await engine.render({ template: 'index', scope: {}, locale: 'en', timezone: 'UTC', hooks }),
    ).toBe(
      '<html><link rel="alternate" href="/feed.xml"><main>hi</main><script src="/core.js"></script></html>',
    );
  });

  it('escapes every value except pre-sanitized HTML', async () => {
    const out = await render('{{ post.title }}|{{ post.content }}|{{ post.content | upcase }}', {
      post: { title: '<script>x</script>', content: safe('<p>ok</p>') },
    });
    expect(out).toBe('&lt;script&gt;x&lt;/script&gt;|<p>ok</p>|&lt;P&gt;OK&lt;/P&gt;');
  });

  it.each([
    ['echo', '{% echo post.title %}'],
    ['liquid echo', '{% liquid\n echo post.title\n %}'],
    ['cycle', '{% cycle post.title, "b" %}'],
  ])('escapes %s output too', async (_name, template) => {
    expect(await render(template, { post: { title: '<b>x</b>' } })).toBe('&lt;b&gt;x&lt;/b&gt;');
  });

  it('falls back to the contract templates', async () => {
    const engine = createThemeEngine({
      'layouts/base.liquid': '{{ content_for_layout }}',
      'templates/index.liquid': 'index',
      'templates/category.liquid': 'category',
      'templates/page.liquid': 'page',
    });
    const r = (template: string) =>
      engine.render({ template, scope: {}, locale: 'en', timezone: 'UTC', hooks });
    expect([await r('tag'), await r('archive'), await r('page.landing')]).toEqual([
      'category',
      'index',
      'page',
    ]);
  });
});

describe('sandbox', () => {
  it.each([
    ['include', "{% include 'x' %}"],
    ['layout', "{% layout 'x' %}"],
    ['block', '{% block x %}{% endblock %}'],
    ['the raw filter', '{{ x | raw }}'],
    ['an unknown filter', '{{ x | exec }}'],
  ])('rejects %s', async (_name, template) => {
    await expect(render(template)).rejects.toThrow();
  });

  it('reads only own properties', async () => {
    expect(
      await render('[{{ post.constructor }}{{ post.__proto__ }}{{ post.title.length }}]', {
        post: { title: 'abc' },
      }),
    ).toBe('[3]');
  });

  it('renders snippets only, never other theme files', async () => {
    const files = { 'snippets/card.liquid': 'card:{{ x }}', 'templates/post.liquid': 'secret' };
    expect(await render("{% render 'card', x: 1 %}", {}, files)).toBe('card:1');
    await expect(render("{% render 'templates/post' %}", {}, files)).rejects.toThrow();
    await expect(render("{% render '../templates/post.liquid' %}", {}, files)).rejects.toThrow();
  });

  it('stops renders that run too long', async () => {
    const loop = '{% for i in (1..100000) %}{% for j in (1..100000) %}x{% endfor %}{% endfor %}';
    await expect(render(loop)).rejects.toThrow(/limit/i);
  });
});

describe('tags', () => {
  it('outputs core-rendered HTML', async () => {
    expect(
      await render(
        "{% seo %}{% comment_form %}{% form 'contact' %}{% slot 'ad' %}{% slot 'none' %}",
      ),
    ).toBe(
      '<title>SEO</title><form class="comments"></form><form data-key="contact"></form><div class="ad"></div>',
    );
  });

  it('renders static and page sections, ignoring schema blocks', async () => {
    const files = {
      'sections/hero.liquid':
        '<h1>{{ section.settings.heading }}</h1>{% for b in section.blocks %}[{{ b.settings.label }}]{% endfor %}{% schema %}{"name": "Hero"}{% endschema %}',
    };
    const page = {
      sections: [
        {
          type: 'hero',
          settings: { heading: 'Page' },
          blocks: [{ type: 'button', settings: { label: 'Go' } }],
        },
        { type: 'missing', settings: {}, blocks: [] },
        { type: '../layouts/base', settings: {}, blocks: [] },
      ],
    };
    expect(await render("{% section 'hero' %}|{% sections %}", { page }, files)).toBe(
      '<h1>Static &lt;hero&gt;</h1>|<h1>Page</h1>[Go]',
    );
  });

  it('paginates and reports the page size', async () => {
    const template =
      '{% paginate posts by 12 %}{% for p in posts %}{{ p }}{% endfor %}{% endpaginate %}';
    const engine = createThemeEngine({
      'layouts/base.liquid': '{{ content_for_layout }}',
      'templates/index.liquid': template,
    });
    expect(engine.pageSize('index')).toBe(12);
    expect(await render(template, { posts: ['a', 'b'] })).toBe('ab');
    await expect(render('{% paginate posts %}{% endpaginate %}')).rejects.toThrow(/paginate/);
  });
});

describe('filters', () => {
  it('asset_url and t', async () => {
    const files = {
      'locales/tr.json': '{"blog": {"read_more": "Devamı"}}',
      'locales/en.json': '{"only_en": "EN"}',
    };
    expect(
      await render(
        "{{ 'style.css' | asset_url }}|{{ 'blog.read_more' | t }}|{{ 'only_en' | t }}|{{ 'nope' | t }}",
        {},
        files,
      ),
    ).toBe('/assets/style.css?v=abc|Devamı|EN|nope');
  });

  it('formats dates for the site locale and timezone', async () => {
    const at = '2026-11-02T06:30:00Z';
    expect(await render('{{ at | date: "long" }}|{{ at | date: "%Y-%m-%d %H:%M" }}', { at })).toBe(
      '2 Kasım 2026|2026-11-02 09:30',
    );
  });

  it('excerpt and reading_time work on HTML', async () => {
    const content = safe(`<p>${'word '.repeat(450)}</p><script>bad()</script>`);
    expect(await render('{{ c | excerpt: 3 }}|{{ c | reading_time }}', { c: content })).toBe(
      'word word word…|3',
    );
  });

  it('json is safe inside a script element', async () => {
    expect(await render('{{ data | json }}', { data: { a: '</script><b>&' } })).toBe(
      '{"a":"\\u003c/script\\u003e\\u003cb\\u003e\\u0026"}',
    );
  });

  it('image_url picks the nearest variant and image_tag escapes attributes', async () => {
    expect(
      await render('{{ img | image_url: width: 500 }}|{{ img | image_url: width: 5000 }}', {
        img: IMAGE,
      }),
    ).toBe('/media/a-800.webp|/media/a-1600.webp');
    expect(
      await render('{{ img | image_tag: widths: "400,800", sizes: "100vw" }}', { img: IMAGE }),
    ).toBe(
      '<img src="/media/a-800.webp" srcset="/media/a-400.webp 400w, /media/a-800.webp 800w" sizes="100vw" ' +
        'alt="A &quot;cat&quot;" width="1600" height="900" loading="lazy" decoding="async">',
    );
  });
});
