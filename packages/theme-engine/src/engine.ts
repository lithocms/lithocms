import {
  CycleTag,
  Liquid,
  Tag,
  Value,
  evalToken,
  filters as builtinFilters,
  type Context,
  type Emitter,
  type FilterImplOptions,
  type TagToken,
  type Template,
  type TopLevelToken,
  type ValueToken,
} from 'liquidjs';
import { escapeHtml, SafeHtml, safe, stripHtml } from './html.js';

/** Theme text files keyed by path inside the theme (`templates/post.liquid`, `theme.json`, ...). */
export type ThemeFiles = Record<string, string>;

export interface ThemeImage {
  url: string;
  width: number;
  height: number;
  alt: string;
  variants: { width: number; url: string }[];
}

export interface SectionData {
  settings: Record<string, unknown>;
  blocks: { type: string; settings: Record<string, unknown> }[];
}

/** What core provides to a render. HTML returned here is trusted and output unescaped. */
export interface RenderHooks {
  assetUrl(path: string): string;
  headExtras(): string;
  bodyExtras(): string;
  seo(): string;
  commentForm(): string;
  form(key: string): string;
  slot(key: string): string;
  /** Stored settings of a static section (`{% section 'name' %}`). */
  section(name: string): SectionData | undefined;
}

export interface RenderRequest {
  /** Template key without extension: `index`, `post`, `page.landing`, `404`, ... */
  template: string;
  scope: Record<string, unknown>;
  locale: string;
  timezone: string;
  hooks: RenderHooks;
}

export const LIMITS = {
  parse: 1_000_000, // characters per parse (a .liquid file is at most 200 KB)
  renderMs: 200,
  memory: 50_000_000,
};

// Contract tags only. `include`, `layout` and `block` are not part of it.
const REMOVED_TAGS = ['include', 'layout', 'block'];
const FALLBACKS: Record<string, string> = { tag: 'category', archive: 'index' };

const RENDER = Symbol('litho.render');
type Rendering = RenderRequest & { engine: ThemeEngine };

function rendering(ctx: Context): Rendering {
  return (ctx.globals as Record<symbol, Rendering>)[RENDER] as Rendering;
}

export interface ThemeEngine {
  render(request: RenderRequest): Promise<string>;
  /** Posts per page declared by `{% paginate … by N %}` in a template, if any. */
  pageSize(template: string): number | undefined;
  /** @internal parsed file, cached */
  parse(path: string): Template[];
  has(path: string): boolean;
}

/**
 * A sandboxed renderer for one theme. Templates come only from `files` (no filesystem), only
 * snippets are reachable by `{% render %}`, filters must exist, and every render is bounded in
 * time and memory. Output is HTML-escaped unless it is `SafeHtml`.
 */
export function createThemeEngine(files: ThemeFiles): ThemeEngine {
  const snippets = Object.fromEntries(
    Object.entries(files)
      .filter(([path]) => /^snippets\/[\w-]+\.liquid$/.test(path))
      .map(([path, source]) => [path.slice('snippets/'.length, -'.liquid'.length), source]),
  );
  const locales = parseLocales(files);

  const liquid = new Liquid({
    templates: snippets,
    ownPropertyOnly: true,
    strictFilters: true,
    strictVariables: false,
    parseLimit: LIMITS.parse,
    renderLimit: LIMITS.renderMs,
    memoryLimit: LIMITS.memory,
    cache: true,
    outputEscape: escapeOutput,
  });
  for (const tag of REMOVED_TAGS) delete liquid.tags[tag];
  // `raw` would bypass escaping.
  delete liquid.filters.raw;

  const cache = new Map<string, Template[]>();
  const engine: ThemeEngine = {
    has: (path) => path in files,
    parse(path) {
      let parsed = cache.get(path);
      if (!parsed) {
        const source = files[path];
        if (source === undefined) throw new Error(`Missing theme file: ${path}`);
        parsed = liquid.parse(source, path);
        cache.set(path, parsed);
      }
      return parsed;
    },
    pageSize(template) {
      const source = files[templatePath(engine, template)] ?? '';
      const match = /{%-?\s*paginate\s+[\w.]+\s+by\s+(\d+)/.exec(source);
      return match ? Number(match[1]) : undefined;
    },
    async render(request) {
      const globals = { [RENDER]: { ...request, engine } };
      const content: unknown = await liquid.render(
        engine.parse(templatePath(engine, request.template)),
        request.scope,
        { globals },
      );
      return String(
        await liquid.render(
          engine.parse('layouts/base.liquid'),
          { ...request.scope, content_for_layout: safe(String(content)) },
          { globals },
        ),
      );
    },
  };

  registerTags(liquid);
  registerFilters(liquid, locales);
  return engine;
}

function templatePath(engine: ThemeEngine, template: string): string {
  const candidates = [
    template,
    FALLBACKS[template],
    template.startsWith('page.') ? 'page' : undefined,
  ];
  for (const name of candidates) {
    if (name && engine.has(`templates/${name}.liquid`)) return `templates/${name}.liquid`;
  }
  return `templates/${template}.liquid`;
}

/** The one escaping rule for everything a template outputs. */
function escapeOutput(value: unknown): string {
  return value instanceof SafeHtml ? value.html : escapeHtml(toText(value));
}

function toText(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(toText).join('');
  // Like LiquidJS itself: objects print through their own toString.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value);
}

// --- tags ----------------------------------------------------------------------------------

type HookName = 'headExtras' | 'bodyExtras' | 'seo' | 'commentForm';

function hookTag(hook: HookName) {
  return class extends Tag {
    render(ctx: Context, emitter: Emitter): void {
      emitter.write(rendering(ctx).hooks[hook]());
    }
  };
}

/** `{% tag 'value' %}`: one argument, passed to a hook. */
function argTag(
  run: (
    ctx: Context,
    emitter: Emitter,
    arg: string,
    liquid: Liquid,
  ) => Generator<unknown, void, unknown> | void,
) {
  return class extends Tag {
    private arg: ValueToken;
    constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
      super(token, remain, liquid);
      this.arg = this.tokenizer.readValueOrThrow();
    }
    *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
      const arg = toText(yield evalToken(this.arg, ctx));
      const nested = run(ctx, emitter, arg, this.liquid);
      if (nested) yield* nested;
    }
  };
}

function* renderSection(
  liquid: Liquid,
  ctx: Context,
  emitter: Emitter,
  type: string,
  section: SectionData,
) {
  const { engine } = rendering(ctx);
  const path = `sections/${type}.liquid`;
  if (!/^[\w-]+$/.test(type) || !engine.has(path)) return;
  ctx.push({ section });
  yield liquid.renderer.renderTemplates(engine.parse(path), ctx, emitter);
  ctx.pop();
}

/** Consumes everything up to `{% end<name> %}` and outputs nothing (e.g. `{% schema %}`). */
function ignoredBlock(name: string) {
  return class extends Tag {
    constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
      super(token, remain, liquid);
      while (remain.length) {
        const next = remain.shift();
        if (next && 'name' in next && next.name === `end${name}`) return;
      }
      throw new Error(`tag ${name} not closed`);
    }
    render(): void {}
  };
}

function registerTags(liquid: Liquid): void {
  // The built-in `echo` and `cycle` write values without `outputEscape`; replace them.
  liquid.registerTag(
    'echo',
    class extends Tag {
      private value?: Value;
      constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
        super(token, remain, liquid);
        this.tokenizer.skipBlank();
        if (!this.tokenizer.end())
          this.value = new Value(this.tokenizer.readFilteredValue(), liquid);
      }
      *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
        if (this.value) emitter.write(escapeOutput(yield this.value.value(ctx, false)));
      }
    },
  );
  liquid.registerTag(
    'cycle',
    class extends CycleTag {
      override *render(ctx: Context, emitter: Emitter): Generator<unknown, string, unknown> {
        return escapeOutput(yield* super.render(ctx, emitter));
      }
    },
  );
  liquid.registerTag('head_extras', hookTag('headExtras'));
  liquid.registerTag('body_extras', hookTag('bodyExtras'));
  liquid.registerTag('seo', hookTag('seo'));
  liquid.registerTag('comment_form', hookTag('commentForm'));
  liquid.registerTag(
    'form',
    argTag((ctx, emitter, key) => {
      emitter.write(rendering(ctx).hooks.form(key));
    }),
  );
  liquid.registerTag(
    'slot',
    argTag((ctx, emitter, key) => {
      emitter.write(rendering(ctx).hooks.slot(key));
    }),
  );
  liquid.registerTag(
    'section',
    argTag(function* (ctx, emitter, name, liquid) {
      const data = rendering(ctx).hooks.section(name) ?? { settings: {}, blocks: [] };
      yield* renderSection(liquid, ctx, emitter, name, data);
    }),
  );
  liquid.registerTag(
    'sections',
    class extends Tag {
      *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
        const sections = ctx.getSync(['page', 'sections']);
        if (!Array.isArray(sections)) return;
        for (const s of sections as (SectionData & { type: string })[]) {
          yield* renderSection(this.liquid, ctx, emitter, s.type, s);
        }
      }
    },
  );
  liquid.registerTag('schema', ignoredBlock('schema'));
  liquid.registerTag(
    'paginate',
    class extends Tag {
      private templates: Template[] = [];
      constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
        super(token, remain, liquid);
        if (!/^[\w.]+\s+by\s+\d+$/.test(token.args.trim())) {
          throw new Error(`illegal tag: ${token.getText()} (expected {% paginate posts by 10 %})`);
        }
        const stream = liquid.parser
          .parseStream(remain)
          .on('template', (t: Template) => this.templates.push(t))
          .on('tag:endpaginate', () => stream.stop())
          .on('end', () => {
            throw new Error(`tag ${token.getText()} not closed`);
          });
        stream.start();
      }
      *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
        // The listing in scope is already paginated by core (see `pageSize`).
        yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
      }
    },
  );
}

// --- filters -------------------------------------------------------------------------------

type Locales = Record<string, Record<string, unknown>>;

function parseLocales(files: ThemeFiles): Locales {
  const locales: Locales = {};
  for (const [path, source] of Object.entries(files)) {
    const match = /^locales\/([a-z]{2}(?:-[A-Z]{2})?)\.json$/.exec(path);
    if (!match?.[1]) continue;
    try {
      locales[match[1]] = JSON.parse(source) as Record<string, unknown>;
    } catch {
      // reported by the validator
    }
  }
  return locales;
}

function lookup(tree: Record<string, unknown> | undefined, key: string): string | undefined {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function variantFor(image: ThemeImage, width: number): string {
  const fits = [...image.variants].sort((a, b) => a.width - b.width).find((v) => v.width >= width);
  return fits?.url ?? image.variants.at(-1)?.url ?? image.url;
}

function isImage(value: unknown): value is ThemeImage {
  return typeof value === 'object' && value !== null && 'url' in value && 'variants' in value;
}

const DATE_STYLES = ['short', 'medium', 'long', 'full'] as const;
const words = (value: unknown) => stripHtml(toText(value)).split(' ').filter(Boolean);

function registerFilters(liquid: Liquid, locales: Locales): void {
  const filter = (name: string, handler: FilterImplOptions) => liquid.registerFilter(name, handler);
  const ctxOf = (self: unknown) => rendering((self as { context: Context }).context);

  filter('asset_url', function (this: unknown, path: unknown) {
    return ctxOf(this).hooks.assetUrl(toText(path));
  });

  filter('t', function (this: unknown, key: unknown) {
    const { locale } = ctxOf(this);
    const k = toText(key);
    return lookup(locales[locale], k) ?? lookup(locales.en, k) ?? k;
  });

  filter('date', function (this: unknown, value: unknown, format?: unknown) {
    const { locale, timezone } = ctxOf(this);
    const style = DATE_STYLES.find((s) => s === format);
    if (!style)
      return (builtinFilters.date as (...a: unknown[]) => unknown).call(
        this,
        value,
        format,
        timezone,
      );
    const date = value instanceof Date ? value : new Date(toText(value));
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone: timezone }).format(date);
  });

  filter('reading_time', (value: unknown) => Math.max(1, Math.ceil(words(value).length / 200)));

  filter('excerpt', (value: unknown, count: unknown = 30) => {
    const all = words(value);
    const n = Number(count) || 30;
    return all.length > n ? `${all.slice(0, n).join(' ')}…` : all.join(' ');
  });

  // For <script type="application/json"> only (enforced by the validator): escapes what could
  // end the script element; quotes stay, so it is not safe inside attributes.
  filter('json', (value: unknown) =>
    safe(
      JSON.stringify(value instanceof SafeHtml ? value.html : (value ?? null))
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029'),
    ),
  );

  filter('image_url', (image: unknown, ...args: unknown[]) => {
    if (!isImage(image)) return '';
    const width = Number(hashArg(args, 'width')) || 0;
    return width ? variantFor(image, width) : image.url;
  });

  filter('image_tag', (image: unknown, ...args: unknown[]) => {
    if (!isImage(image)) return '';
    const widths = toText(hashArg(args, 'widths') ?? '')
      .split(',')
      .map(Number)
      .filter((w) => w > 0);
    const srcset = [...new Set(widths.map((w) => variantFor(image, w)))]
      .map((url) => `${url} ${image.variants.find((v) => v.url === url)?.width ?? image.width}w`)
      .join(', ');
    const attrs: [string, string | number | undefined][] = [
      ['src', widths.length ? variantFor(image, Math.max(...widths)) : image.url],
      ['srcset', srcset || undefined],
      ['sizes', toText(hashArg(args, 'sizes') ?? '') || undefined],
      ['alt', toText(hashArg(args, 'alt') ?? image.alt)],
      ['width', image.width],
      ['height', image.height],
      ['loading', toText(hashArg(args, 'loading') ?? 'lazy')],
      ['class', toText(hashArg(args, 'class') ?? '') || undefined],
    ];
    const html = attrs
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}="${escapeHtml(String(v))}"`)
      .join(' ');
    return safe(`<img ${html} decoding="async">`);
  });
}

/** Keyword argument (`width: 800`) from a filter's argument list. */
function hashArg(args: unknown[], key: string): unknown {
  for (const arg of args) {
    if (Array.isArray(arg) && arg[0] === key) return arg[1];
  }
  return undefined;
}
