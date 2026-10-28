import { describe, expect, it } from 'vitest';
import { validateTheme, type ThemeBundle } from './validate.js';

const MANIFEST = {
  name: 'Fixture',
  slug: 'fixture',
  version: '1.0.0',
  tokens: { colors: { bg: '#ffffff', fg: '#111111' } },
  settings: [
    { id: 'show_author', type: 'boolean', default: true, label: { tr: 'Yazar', en: 'Author' } },
  ],
};

const VALID: ThemeBundle = {
  'theme.json': JSON.stringify(MANIFEST),
  'layouts/base.liquid':
    '<!doctype html><html><head>{% seo %}<link rel="stylesheet" href="{{ \'style.css\' | asset_url }}">{% head_extras %}</head>' +
    '<body>{{ content_for_layout }}<script src="{{ \'app.js\' | asset_url }}"></script>{% body_extras %}</body></html>',
  'templates/index.liquid':
    "{% paginate posts by 10 %}{% for p in posts %}{% render 'card', post: p %}{% endfor %}{% endpaginate %}",
  'templates/post.liquid':
    '<h1>{{ post.title }}</h1>{{ post.featured_image | image_tag: widths: "400,800" }}{{ post.content }}{% comment_form %}',
  'templates/page.liquid': '<h1>{{ page.title }}</h1>{% sections %}',
  'templates/category.liquid': '<h1>{{ term.name }}</h1>',
  'templates/search.liquid': '{{ search.results_count }}',
  'templates/404.liquid': "{{ 'not_found' | t }}",
  'sections/hero.liquid':
    '<h2>{{ section.settings.heading }}</h2>{% schema %}{"name": {"en": "Hero"}, "settings": [{"id": "heading", "type": "text"}]}{% endschema %}',
  'snippets/card.liquid':
    '<a href="{{ post.url }}">{{ post.title }}</a> <time>{{ post.published_at | date: "long" }}</time>',
  'assets/style.css': 'body { color: var(--color-fg); }',
  'assets/app.js': 'console.log(1);',
  'assets/logo.png': new Uint8Array([137, 80, 78, 71]),
  'locales/en.json': '{"not_found": "Not found"}',
};

const check = (changes: ThemeBundle, options = {}) =>
  validateTheme({ ...VALID, ...changes }, options);
const rules = async (changes: ThemeBundle, options = {}) =>
  (await check(changes, options)).errors.map((e) => e.rule);

describe('validateTheme', () => {
  it('accepts a complete theme', async () => {
    expect(await check({})).toEqual({ valid: true, errors: [], warnings: [] });
  });

  describe('1. manifest', () => {
    it.each([
      ['invalid JSON', '{'],
      ['a bad slug', JSON.stringify({ ...MANIFEST, slug: 'Bad Slug' })],
      ['a bad version', JSON.stringify({ ...MANIFEST, version: 'one' })],
      [
        'an unknown setting type',
        JSON.stringify({ ...MANIFEST, settings: [{ id: 'x', type: 'html' }] }),
      ],
      [
        'CSS injection in a token',
        JSON.stringify({ ...MANIFEST, tokens: { radius: '0; } body { background: url(x)' } }),
      ],
    ])('rejects %s', async (_name, json) => {
      expect(await rules({ 'theme.json': json })).toContain('manifest');
    });
  });

  describe('2. required files', () => {
    it('requires every contract template', async () => {
      const rest = { ...VALID };
      delete rest['templates/search.liquid'];
      const report = await validateTheme(rest);
      expect(report.errors).toEqual([
        { path: 'templates/search.liquid', rule: 'required', message: 'Required file is missing' },
      ]);
    });

    it.each(['{{ content_for_layout }}', '{% head_extras %}', '{% body_extras %}'])(
      'requires %s in base.liquid',
      async (tag) => {
        const base = (VALID['layouts/base.liquid'] as string).replace(tag, '');
        expect(await rules({ 'layouts/base.liquid': base })).toEqual(['required']);
      },
    );

    it('rejects unknown template names', async () => {
      expect(await rules({ 'templates/admin.liquid': 'x' })).toEqual(['required']);
      expect(
        await rules({ 'templates/page.landing.liquid': 'x', 'templates/tag.liquid': 'x' }),
      ).toEqual([]);
    });
  });

  describe('3. parse', () => {
    it.each([
      ['a syntax error', '{% if %}'],
      ['an unclosed tag', '{% for p in posts %}'],
      ['a non-contract tag', "{% include 'card' %}"],
      ['an unknown filter', '{{ post.title | shell }}'],
    ])('rejects %s', async (_name, source) => {
      expect(await rules({ 'templates/category.liquid': source })).toEqual(['parse']);
    });
  });

  describe('4. section schema', () => {
    it.each([
      ['a missing schema', '<h2>x</h2>'],
      ['invalid JSON', '{% schema %}{name:}{% endschema %}'],
      [
        'an invalid schema',
        '{% schema %}{"settings": [{"id": "x", "type": "text"}]}{% endschema %}',
      ],
    ])('rejects %s', async (_name, source) => {
      expect(await rules({ 'sections/hero.liquid': source })).toEqual(['section-schema']);
    });
  });

  describe('5. inline scripts', () => {
    it('rejects executable inline scripts', async () => {
      expect(await rules({ 'templates/search.liquid': '<script>alert(1)</script>' })).toEqual([
        'inline-script',
      ]);
      expect(
        await rules({ 'templates/search.liquid': '<script type="module">x()</script>' }),
      ).toEqual(['inline-script']);
    });

    it('allows data blocks and json inside them only', async () => {
      const ok = '<script type="application/ld+json">{{ post | json }}</script>';
      expect(await rules({ 'templates/post.liquid': ok })).toEqual([]);
      expect(
        await rules({ 'templates/post.liquid': '<div data-x="{{ post | json }}"></div>' }),
      ).toEqual(['inline-script']);
    });
  });

  describe('6. event handlers and javascript: URLs', () => {
    it.each([
      ['templates/search.liquid', '<img src="x.png" alt="" onerror="alert(1)">', 'event-handler'],
      ['templates/search.liquid', '<a href="javascript:alert(1)">x</a>', 'javascript-url'],
      ['assets/style.css', 'a { background: url("javascript:alert(1)") }', 'javascript-url'],
      ['assets/icon.svg', '<svg onload="alert(1)"></svg>', 'event-handler'],
    ])('rejects %s: %s', async (path, source, rule) => {
      expect(await rules({ [path]: source })).toContain(rule);
    });
  });

  describe('7. external hosts', () => {
    const script = '<script src="https://cdn.example.com/x.js"></script>';
    it('rejects hosts outside the CSP allowlist', async () => {
      expect(await rules({ 'templates/search.liquid': script })).toEqual(['external-host']);
      expect(
        await rules({ 'assets/style.css': '@import url("https://evil.example/x.css");' }),
      ).toEqual(['external-host']);
      expect(
        await rules({ 'templates/search.liquid': '<iframe src="//evil.example/"></iframe>' }),
      ).toEqual(['external-host']);
    });

    it('accepts allowlisted hosts, including wildcards', async () => {
      expect(
        await rules({ 'templates/search.liquid': script }, { cspAllowlist: ['*.example.com'] }),
      ).toEqual([]);
    });
  });

  describe('8. file types', () => {
    it.each([
      ['assets/run.php', 'x'],
      ['assets/movie.mp4', new Uint8Array(1)],
      ['server.js', 'x'],
      ['assets/../theme.json', '{}'],
    ])('rejects %s', async (path, content) => {
      expect(await rules({ [path]: content })).toContain('file-types');
    });
  });

  describe('9. limits', () => {
    it('rejects oversized templates and assets', async () => {
      expect(await rules({ 'snippets/big.liquid': 'x'.repeat(201 * 1024) })).toEqual(['limits']);
      expect(await rules({ 'assets/big.png': new Uint8Array(2 * 1024 * 1024 + 1) })).toEqual([
        'limits',
      ]);
    });

    it('rejects too many files', async () => {
      const many = Object.fromEntries(
        Array.from({ length: 300 }, (_, i) => [`assets/i${i}.png`, new Uint8Array(1)]),
      );
      expect(await rules(many)).toEqual(['limits']);
    });
  });

  describe('10. render smoke test', () => {
    it('rejects templates that fail against fixture data', async () => {
      const report = await check({ 'templates/search.liquid': "{% render 'missing' %}" });
      expect(report.errors).toMatchObject([{ rule: 'render', path: 'templates/search.liquid' }]);
    });
  });

  describe('bypass attempts', () => {
    it.each([
      [
        'a decoy data-type attribute',
        '<script data-type="application/json">alert(1)</script>',
        'inline-script',
      ],
      ['a slash before the handler', '<img/onerror=alert(1) src="x.png" alt="">', 'event-handler'],
      ['a handler right after a quote', '<a href="/"onclick="x()">x</a>', 'event-handler'],
      ['an entity-encoded scheme', '<a href="jav&#x61;script:alert(1)">x</a>', 'javascript-url'],
      ['a tab inside the scheme', '<a href="java\tscript:alert(1)">x</a>', 'javascript-url'],
      ['Liquid inside a tag name', "<scr{{ '' }}ipt>alert(1)</script>", 'markup'],
      ['Liquid inside an attribute name', '<a on{{ \'click\' }}="x()">x</a>', 'markup'],
    ])('catches %s', async (_name, source, rule) => {
      expect(await rules({ 'templates/search.liquid': source })).toContain(rule);
    });

    it('checks markup that only exists after rendering', async () => {
      const report = await check({
        'templates/search.liquid': '<script src="{{ \'https://evil.example/x.js\' }}"></script>',
      });
      expect(report.errors).toMatchObject([
        {
          rule: 'external-host',
          path: 'templates/search.liquid',
          message: expect.stringContaining('rendered') as unknown,
        },
      ]);
    });

    it.each([
      ['an escaped semicolon', 'red\\3b background: red'],
      ['an unlisted function', 'attr(data-x)'],
      ['an unbalanced quote', '"Inter, sans-serif'],
    ])('rejects a token with %s', async (_name, value) => {
      expect(
        await rules({
          'theme.json': JSON.stringify({ ...MANIFEST, tokens: { fonts: { body: value } } }),
        }),
      ).toContain('manifest');
    });

    it('accepts ordinary token values', async () => {
      const tokens = {
        colors: { fg: 'oklch(20% 0.02 260)', bg: '#fff' },
        fonts: { body: '"Inter", system-ui, sans-serif' },
        radius: 'calc(0.5rem + 2px)',
      };
      expect(await rules({ 'theme.json': JSON.stringify({ ...MANIFEST, tokens }) })).toEqual([]);
    });
  });

  describe('warnings', () => {
    it('reports but does not block', async () => {
      const report = await check(
        {
          'theme.json': JSON.stringify({
            ...MANIFEST,
            tokens: { colors: { bg: '#ffffff', fg: '#aaaaaa' } },
          }),
          'layouts/base.liquid': (VALID['layouts/base.liquid'] as string).replace('{% seo %}', ''),
          'templates/search.liquid': '<img src="/a.png">',
          'assets/style.css': `@import url("https://fonts.googleapis.com/css2?family=Inter");${'a{}'.repeat(40_000)}`,
        },
        { cspAllowlist: ['fonts.googleapis.com'] },
      );
      expect(report.valid).toBe(true);
      expect(report.warnings.map((w) => w.rule).sort()).toEqual([
        'contrast',
        'external-fonts',
        'img-alt',
        'seo',
        'weight',
      ]);
    });
  });

  it('reports line numbers', async () => {
    const report = await check({ 'templates/search.liquid': 'ok\nok\n<b onclick="x()">' });
    expect(report.errors).toEqual([
      {
        path: 'templates/search.liquid',
        rule: 'event-handler',
        message: 'Inline event handler onclick is not allowed',
        line: 3,
      },
    ]);
  });
});
