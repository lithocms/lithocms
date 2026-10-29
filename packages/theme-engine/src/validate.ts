import { createThemeEngine, type RenderHooks, type ThemeFiles, type ThemeImage } from './engine.js';
import { safe } from './html.js';
import { SCHEMA_BLOCK, SectionSchema, ThemeManifest } from './manifest.js';

export interface ValidationIssue {
  path: string;
  line?: number;
  rule: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ValidateOptions {
  /** Hosts the site's CSP allows (`cdn.example.com`, `*.example.com`). */
  cspAllowlist?: string[];
}

/** Theme files: text for liquid/json/css/js/svg, bytes for everything else. */
export type ThemeBundle = Record<string, string | Uint8Array>;

const REQUIRED = [
  'theme.json',
  'layouts/base.liquid',
  ...['index', 'post', 'page', 'category', 'search', '404'].map((t) => `templates/${t}.liquid`),
];
const OPTIONAL_TEMPLATES = /^templates\/(tag|archive|page\.[a-z0-9_-]+)\.liquid$/;
const LIQUID_PATH =
  /^(layouts\/base|templates\/[a-z0-9._-]+|sections\/[\w-]+|snippets\/[\w-]+)\.liquid$/;
const ASSET_TYPES = [
  'css',
  'js',
  'json',
  'svg',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'avif',
  'gif',
  'woff',
  'woff2',
  'ico',
];
const LIMITS = { files: 300, total: 10 * 1024 * 1024, file: 2 * 1024 * 1024, liquid: 200 * 1024 };

const size = (content: string | Uint8Array) =>
  typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

/**
 * Checks a theme against THEME_CONTRACT.md before it can be activated. Errors block
 * activation; warnings are shown only.
 */
export async function validateTheme(
  bundle: ThemeBundle,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const error = (rule: string, path: string, message: string, line?: number) =>
    errors.push({ path, rule, message, ...(line ? { line } : {}) });
  const warn = (rule: string, path: string, message: string, line?: number) =>
    warnings.push({ path, rule, message, ...(line ? { line } : {}) });

  const text: ThemeFiles = {};
  for (const [path, content] of Object.entries(bundle)) {
    if (typeof content === 'string') text[path] = content;
  }
  const paths = Object.keys(bundle);

  // 9. limits
  if (paths.length > LIMITS.files) error('limits', '', `More than ${LIMITS.files} files`);
  const total = Object.values(bundle).reduce((sum, c) => sum + size(c), 0);
  if (total > LIMITS.total) error('limits', '', 'Theme is larger than 10 MB');

  // 8. layout and file types
  for (const path of paths) {
    const bytes = size(bundle[path] ?? '');
    if (bytes > LIMITS.file) error('limits', path, 'File is larger than 2 MB');
    if (path.endsWith('.liquid') && bytes > LIMITS.liquid)
      error('limits', path, 'Template is larger than 200 KB');
    if (
      path === 'theme.json' ||
      LIQUID_PATH.test(path) ||
      /^locales\/[a-z]{2}(-[A-Z]{2})?\.json$/.test(path)
    )
      continue;
    const ext = /^assets\/[\w./-]+\.([a-z0-9]+)$/.exec(path)?.[1];
    if (!ext || path.includes('..'))
      error('file-types', path, 'Unexpected file; see the theme directory layout');
    else if (!ASSET_TYPES.includes(ext))
      error('file-types', path, `Asset type .${ext} is not allowed`);
  }

  // 1. manifest
  const manifestSource = text['theme.json'];
  if (manifestSource !== undefined) {
    try {
      const parsed = ThemeManifest.safeParse(JSON.parse(manifestSource));
      for (const issue of parsed.error?.issues ?? []) {
        error('manifest', 'theme.json', `${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      if (parsed.success) checkContrast(parsed.data, warn);
    } catch (e) {
      error('manifest', 'theme.json', `Invalid JSON: ${(e as Error).message}`);
    }
  }

  // 2. required files and base layout hooks
  for (const path of REQUIRED) {
    if (!(path in bundle)) error('required', path, 'Required file is missing');
  }
  const base = text['layouts/base.liquid'];
  if (base !== undefined) {
    for (const [pattern, name] of [
      [/{{-?\s*content_for_layout\s*-?}}/, '{{ content_for_layout }}'],
      [/{%-?\s*head_extras\s*-?%}/, '{% head_extras %}'],
      [/{%-?\s*body_extras\s*-?%}/, '{% body_extras %}'],
    ] as const) {
      if (!pattern.test(base)) error('required', 'layouts/base.liquid', `Must contain ${name}`);
    }
    if (!/{%-?\s*seo\s*-?%}/.test(base)) warn('seo', 'layouts/base.liquid', 'Missing {% seo %}');
  }

  // 3. parse, 4. section schemas, 5–7. markup rules
  const engine = createThemeEngine(text);
  for (const [path, source] of Object.entries(text)) {
    if (path.endsWith('.liquid')) {
      try {
        engine.parse(path);
      } catch (e) {
        const err = e as Error & { token?: { getPosition?: () => [number, number] } };
        error(
          'parse',
          path,
          err.message.split(', file:')[0] ?? err.message,
          err.token?.getPosition?.()[0],
        );
      }
      if (path.startsWith('sections/')) checkSectionSchema(path, source, error);
      checkMarkup(path, source, options.cspAllowlist ?? [], error, warn);
    } else if (/\.(css|svg)$/.test(path)) {
      checkMarkup(path, source, options.cspAllowlist ?? [], error, warn);
    } else if (/^locales\/.+\.json$/.test(path)) {
      try {
        JSON.parse(source);
      } catch {
        error('manifest', path, 'Invalid JSON');
      }
    }
  }

  const bytesOf = (ext: string) =>
    paths.filter((p) => p.endsWith(ext)).reduce((sum, p) => sum + size(bundle[p] ?? ''), 0);
  if (bytesOf('.css') > 100 * 1024) warn('weight', 'assets', 'Total CSS is over 100 KB');
  if (bytesOf('.js') > 50 * 1024) warn('weight', 'assets', 'Total JS is over 50 KB');

  // 10. render smoke test, only once everything else passes
  if (!errors.length) {
    const templates = paths.filter((p) => p.startsWith('templates/')).map((p) => p.slice(10, -7));
    for (const template of templates) {
      const path = `templates/${template}.liquid`;
      try {
        const html = await engine.render({
          template,
          scope: FIXTURE,
          locale: 'en',
          timezone: 'UTC',
          hooks: FIXTURE_HOOKS,
        });
        // Markup assembled by Liquid is only visible after rendering: check it again.
        const rendered: Report = (rule, _p, message) =>
          error(rule, path, `${message} (in rendered output)`);
        checkMarkup('rendered.html', html, options.cspAllowlist ?? [], rendered, () => undefined);
      } catch (e) {
        error('render', path, `Render failed: ${(e as Error).message.split(', file:')[0]}`);
      }
    }
  }

  for (const path of paths) {
    if (
      path.startsWith('templates/') &&
      !REQUIRED.includes(path) &&
      !OPTIONAL_TEMPLATES.test(path)
    ) {
      error('required', path, 'Unknown template name');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

type Report = (rule: string, path: string, message: string, line?: number) => void;

function checkSectionSchema(path: string, source: string, error: Report): void {
  const match = SCHEMA_BLOCK.exec(source);
  if (!match?.[1]) return error('section-schema', path, 'Sections need a {% schema %} block');
  try {
    const parsed = SectionSchema.safeParse(JSON.parse(match[1]));
    for (const issue of parsed.error?.issues ?? []) {
      error(
        'section-schema',
        path,
        `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        lineAt(source, match.index),
      );
    }
  } catch (e) {
    error(
      'section-schema',
      path,
      `Invalid JSON in {% schema %}: ${(e as Error).message}`,
      lineAt(source, match.index),
    );
  }
}

const DATA_SCRIPT = /^(application\/(ld\+)?json)$/i;

function checkMarkup(
  path: string,
  source: string,
  allowlist: string[],
  error: Report,
  warn: Report,
): void {
  const at = (i: number) => lineAt(source, i);
  const isCss = path.endsWith('.css');

  if (!isCss) {
    // 5. inline scripts: only data blocks; `json` output only inside them
    const dataRanges: [number, number][] = [];
    for (const m of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const attrs = m[1] ?? '';
      const type = /(?:^|\s)type\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? '';
      if (DATA_SCRIPT.test(type)) {
        dataRanges.push([m.index, m.index + m[0].length]);
      } else if (!/(?:^|\s)src\s*=/.test(attrs) || (m[2] ?? '').trim()) {
        error(
          'inline-script',
          path,
          'Inline scripts are not allowed; use assets/*.js',
          at(m.index),
        );
      }
    }
    for (const m of source.matchAll(/\|\s*json\b/g)) {
      if (!dataRanges.some(([s, e]) => m.index > s && m.index < e)) {
        error(
          'inline-script',
          path,
          'The json filter is only allowed inside <script type="application/json">',
          at(m.index),
        );
      }
    }

    // 6. event handlers (attributes may follow whitespace, `/` or a closing quote)
    for (const m of source.matchAll(/<[a-z][^>]*?[\s/"'](on[a-z]+)\s*=/gi)) {
      error('event-handler', path, `Inline event handler ${m[1]} is not allowed`, at(m.index));
    }

    // Liquid that builds tag or attribute names hides markup from these checks.
    for (const m of source.matchAll(
      /<\/?[a-z0-9-]*{[{%]|[\s/"'][a-z-]*{[{%][^>]*?[}%]}[a-z-]*\s*=/gi,
    )) {
      error(
        'markup',
        path,
        'Liquid inside an HTML tag or attribute name is not allowed',
        at(m.index),
      );
    }

    // Elements that change where the page or its relative URLs point, or load plugins.
    for (const m of source.matchAll(
      /<(base|object|embed|applet)\b|<meta\b[^>]*\bhttp-equiv\s*=/gi,
    )) {
      const what = m[1] ? `<${m[1].toLowerCase()}>` : '<meta http-equiv>';
      error('markup', path, `${what} is not allowed`, at(m.index));
    }

    // warning: images without alt
    for (const m of source.matchAll(/<img\b(?![^>]*\balt\s*=)[^>]*>/gi)) {
      warn('img-alt', path, '<img> without alt', at(m.index));
    }
  }

  // 6. script URLs (any file type), also when hidden behind entities or whitespace
  const SCRIPT_URL = /(?:java|vb)script\s*:/gi;
  const found = [...source.matchAll(SCRIPT_URL)];
  for (const m of found)
    error('javascript-url', path, 'javascript: URLs are not allowed', at(m.index));
  if ([...decodeForUrlCheck(source).matchAll(SCRIPT_URL)].length > found.length) {
    error('javascript-url', path, 'Encoded javascript: URL is not allowed');
  }

  // 7. external hosts
  const external: [string, number][] = [];
  if (isCss) {
    for (const m of source.matchAll(
      /(?:@import\s+(?:url\()?|url\()\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi,
    )) {
      external.push([m[1] ?? '', m.index]);
    }
  } else {
    const loads =
      /<(script|link|iframe|frame)\b[^>]*?[\s/"'](?:src|href)\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi;
    const submits =
      /<(form|button|input)\b[^>]*?[\s/"'](?:action|formaction)\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi;
    for (const m of [...source.matchAll(loads), ...source.matchAll(submits)]) {
      external.push([m[2] ?? '', m.index]);
    }
  }
  for (const [url, index] of external) {
    const host = hostOf(url);
    if (!host || !allowlist.some((pattern) => hostMatches(host, pattern))) {
      error('external-host', path, `${host ?? url} is not in the site's CSP allowlist`, at(index));
    }
    if (host && /fonts\.(googleapis|gstatic)\.com|use\.typekit\.net|fonts\.bunny\.net/.test(host)) {
      warn(
        'external-fonts',
        path,
        'External fonts share visitor data; prefer fonts in assets/',
        at(index),
      );
    }
  }
}

/** What a browser sees in a URL attribute: entities decoded, tabs and newlines dropped. */
function decodeForUrlCheck(source: string): string {
  return source
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&colon;/gi, ':')
    .replace(/&(tab|newline);/gi, '')
    .replace(/[\t\n\r]/g, '');
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url.startsWith('//') ? `https:${url}` : url).hostname;
  } catch {
    return undefined;
  }
}

function hostMatches(host: string, pattern: string): boolean {
  return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern;
}

function checkContrast(manifest: ThemeManifest, warn: Report): void {
  const { fg, bg } = manifest.tokens?.colors ?? {};
  const [a, b] = [fg, bg].map((c) => (c ? luminance(c) : undefined));
  if (a === undefined || b === undefined) return;
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  if (ratio < 4.5) {
    warn(
      'contrast',
      'theme.json',
      `Contrast between tokens.colors.fg and bg is ${ratio.toFixed(2)}:1 (WCAG AA needs 4.5:1)`,
    );
  }
}

function luminance(hex: string): number | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return undefined;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// --- render fixture ---------------------------------------------------------------------------

const IMG: ThemeImage = {
  url: '/media/fixture.jpg',
  width: 1200,
  height: 800,
  alt: 'Fixture',
  variants: [400, 800, 1200].map((width) => ({ width, url: `/media/fixture-${width}.webp` })),
};
const term = {
  name: 'News',
  url: '/category/news/',
  description: '',
  parent: null,
  children: [],
  ancestors: [],
  meta: {},
  post_count: 3,
};
const post = {
  id: '00000000-0000-7000-8000-000000000001',
  title: 'Fixture post',
  url: '/fixture-post/',
  excerpt: safe('<p>Excerpt</p>'),
  content: safe('<p>Content</p>'),
  published_at: '2026-01-01T09:00:00Z',
  updated_at: '2026-01-02T09:00:00Z',
  author: { name: 'Author' },
  featured_image: IMG,
  categories: [term],
  primary_category: term,
  tags: [],
  comment_count: 1,
  comments_open: true,
  comments: [
    {
      id: '1',
      author_name: 'Reader',
      content: 'Nice',
      created_at: '2026-01-03T09:00:00Z',
      replies: [],
    },
  ],
  reading_time: 1,
  seo: {},
};

export const FIXTURE: Record<string, unknown> = {
  site: {
    name: 'Fixture',
    tagline: 'Tagline',
    url: 'https://example.com',
    locale: 'en',
    logo: IMG,
    social: {},
    language_direction: 'ltr',
  },
  theme: { settings: {}, tokens: {}, css_variables: '' },
  request: { path: '/', page_type: 'index', query: 'q' },
  post,
  page: { ...post, parent: null, children: [], sections: [] },
  posts: [post, post],
  term,
  categories: { top: [term], all: [term] },
  menus: {
    primary: { items: [{ label: 'Home', url: '/', active: true, children: [] }] },
    footer: { items: [] },
  },
  collections: {},
  paginate: { current_page: 1, pages: 2, previous: null, next: { url: '/page/2/' }, parts: [] },
  search: { terms: 'q', results: [post], results_count: 1 },
  seo: { title: 'Fixture' },
  archive: { year: 2026, month: 1 },
};

const FIXTURE_HOOKS: RenderHooks = {
  assetUrl: (path) => `/assets/${path}`,
  headExtras: () => '',
  bodyExtras: () => '',
  seo: () => '<title>Fixture</title>',
  commentForm: () => '<form></form>',
  form: () => '<form></form>',
  slot: () => '',
  section: () => undefined,
};
