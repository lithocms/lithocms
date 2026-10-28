import {
  cssVariables,
  escapeHtml,
  safe,
  stripHtml,
  type RenderHooks,
  type ThemeEngine,
  type ThemeImage,
  type ThemeManifest,
} from '@lithocms/theme-engine';
import { and, asc, count, desc, eq, inArray, like, or, sql, type SQL } from 'drizzle-orm';
import type { PostRow } from '../content/posts.js';
import type { Term } from '../content/terms.js';
import { flatten, listMenus } from '../content/menus.js';
import type { Tx } from '../db/client.js';
import { posts, postTerms, terms, users, type MenuItem } from '../db/schema.js';
import { mediaByIds, mediaUrl, type Media } from '../media/media.js';
import { paginatedUrl, splitPagination } from './permalinks.js';
import {
  isLive,
  loadPublicSite,
  postUrls,
  resolvePath,
  termUrl,
  type PublicSite,
  type Resolved,
} from './resolve.js';

/** A loaded theme version, ready to render. */
export interface PublicTheme {
  engine: ThemeEngine;
  manifest: ThemeManifest;
  /** Fingerprinted URL of a file in the theme's `assets/`. */
  assetUrl(path: string): string;
}

export interface PublicRequest {
  path: string;
  /** `?s=` on the home URL. */
  search?: string;
  /** Scheme and primary host, e.g. `https://example.com`. */
  origin: string;
}

export type PublicResponse =
  { status: 200 | 404; html: string } | { status: 301; location: string };

const DEFAULT_PAGE_SIZE = 10;
const RTL = ['ar', 'he', 'fa', 'ur'];
const STRINGS = {
  tr: { page: 'Sayfa', search: 'Arama', notFound: 'Sayfa bulunamadı' },
  en: { page: 'Page', search: 'Search', notFound: 'Page not found' },
};

type Scope = Record<string, unknown>;

interface Seo {
  title: string;
  description: string;
  type: 'website' | 'article';
  image: Media | undefined;
  noindex: boolean;
  canonical?: string;
  jsonLd?: Record<string, unknown>;
}

interface Page {
  template: string;
  pageType: string;
  scope: Scope;
  seo: Seo;
}

/** Renders a public URL of a site with its theme. Runs inside `withSite`. */
export async function renderPublic(
  tx: Tx,
  siteId: string,
  theme: PublicTheme,
  req: PublicRequest,
): Promise<PublicResponse> {
  const site = await loadPublicSite(tx, siteId);
  const resolved = await resolvePath(tx, site, req.path, req.search);
  if (resolved.type === 'redirect') return { status: 301, location: resolved.location };

  const categories = await categoryTree(tx, site);
  const ctx: Ctx = { tx, site, theme, req, categories };
  const page = (await buildPage(ctx, resolved)) ?? notFound(site);
  const status = page.pageType === '404' ? 404 : 200;

  const [logo] = await images(tx, site.id, [setting(site, 'logo')]);
  const canonical = page.seo.canonical ?? req.origin + req.path;
  const scope: Scope = {
    site: {
      name: site.name,
      tagline: setting(site, 'tagline') ?? '',
      url: req.origin,
      locale: site.locale,
      logo: logo ? themeImage(logo) : null,
      social: socialLinks(site),
      language_direction: RTL.includes(site.locale.slice(0, 2)) ? 'rtl' : 'ltr',
    },
    theme: {
      settings: Object.fromEntries(
        (theme.manifest.settings ?? []).map((s) => [s.id, s.default ?? null]),
      ),
      tokens: theme.manifest.tokens ?? {},
      css_variables: safe(cssVariables(theme.manifest)),
    },
    request: { path: req.path, page_type: page.pageType, query: req.search ?? '' },
    categories: { top: categories.top, all: categories.all },
    menus: await menuScope(tx, site, req.path),
    // TODO(phase-1): collections, forms and slots.
    collections: {},
    seo: {
      title: page.seo.title,
      description: page.seo.description,
      canonical,
      noindex: page.seo.noindex,
    },
    ...page.scope,
  };
  const seoImage = page.seo.image ?? logo;
  const html = await theme.engine.render({
    template: page.template,
    scope,
    locale: site.locale,
    timezone: site.timezone,
    hooks: {
      assetUrl: (path) => theme.assetUrl(path),
      headExtras: () => '',
      bodyExtras: () => '',
      seo: () =>
        seoTags(site, { ...page.seo, image: seoImage }, canonical, req.origin, status === 404),
      // TODO(phase-3): core-rendered comment form.
      commentForm: () => '',
      form: () => '',
      slot: () => '',
      section: () => undefined,
    } satisfies RenderHooks,
  });
  return { status, html };
}

interface Ctx {
  tx: Tx;
  site: PublicSite;
  theme: PublicTheme;
  req: PublicRequest;
  categories: CategoryTree;
}

async function buildPage(ctx: Ctx, resolved: Resolved): Promise<Page | undefined> {
  const { site } = ctx;
  const tagline = setting(site, 'tagline') ?? '';
  switch (resolved.type) {
    case 'index': {
      const list = await listing(ctx, 'index', resolved.page);
      if (!list) return undefined;
      return {
        template: 'index',
        pageType: 'index',
        scope: list,
        seo: {
          title: paged(site, tagline ? `${site.name} – ${tagline}` : site.name, resolved.page),
          description: tagline,
          type: 'website',
          image: undefined,
          noindex: false,
          jsonLd: { '@type': 'WebSite', name: site.name, url: ctx.req.origin },
        },
      };
    }
    case 'search': {
      // TODO(phase-1): full-text search.
      return {
        template: 'search',
        pageType: 'search',
        scope: {
          posts: [],
          search: { terms: resolved.query, results: [], results_count: 0 },
          paginate: paginate(ctx, 1, 1),
        },
        seo: {
          title: `${strings(site).search}: ${resolved.query} – ${site.name}`,
          description: '',
          type: 'website',
          image: undefined,
          noindex: true,
        },
      };
    }
    case 'category':
    case 'tag': {
      const node =
        resolved.type === 'category'
          ? ctx.categories.byId.get(resolved.term.id)!
          : (await termNodes(ctx.tx, site, [resolved.term])).get(resolved.term.id)!;
      const list = await listing(ctx, resolved.type, resolved.page, inTerm(ctx.tx, resolved.term));
      if (!list) return undefined;
      return {
        template: resolved.type,
        pageType: resolved.type,
        scope: { ...list, term: node },
        seo: {
          title: paged(site, `${resolved.term.name} – ${site.name}`, resolved.page),
          description: resolved.term.description || tagline,
          type: 'website',
          image: undefined,
          noindex: false,
        },
      };
    }
    case 'archive': {
      const { year, month } = resolved;
      const local = (part: 'year' | 'month') =>
        sql`extract(${sql.raw(part)} from ${posts.publishedAt} at time zone ${site.timezone})`;
      const where = and(
        sql`${local('year')} = ${year}`,
        month ? sql`${local('month')} = ${month}` : undefined,
      );
      const list = await listing(ctx, 'archive', resolved.page, where);
      if (!list) return undefined;
      const label = month
        ? new Intl.DateTimeFormat(site.locale, { year: 'numeric', month: 'long' }).format(
            new Date(Date.UTC(year, month - 1, 15)),
          )
        : String(year);
      return {
        template: 'archive',
        pageType: 'archive',
        scope: { ...list, archive: { year, month } },
        seo: {
          title: paged(site, `${label} – ${site.name}`, resolved.page),
          description: '',
          type: 'website',
          image: undefined,
          noindex: false,
        },
      };
    }
    case 'post':
    case 'page': {
      const row = resolved.post;
      const [object] = await postObjects(ctx, [row]);
      const seo: Seo = {
        title: row.seo.title || `${row.title} – ${site.name}`,
        description: row.seo.description || plainExcerpt(row, 30),
        type: resolved.type === 'post' ? 'article' : 'website',
        image: (await images(ctx.tx, site.id, [row.seo.ogImageId, row.featuredMediaId]))[0],
        noindex: row.seo.noindex === true,
        canonical: row.seo.canonical,
      };
      if (resolved.type === 'post') {
        seo.jsonLd = {
          '@type': 'BlogPosting',
          headline: row.title,
          datePublished: row.publishedAt?.toISOString(),
          dateModified: row.updatedAt.toISOString(),
          author: { '@type': 'Person', name: (object!.author as { name: string }).name },
          url: ctx.req.origin + (object!.url as string),
        };
        return { template: 'post', pageType: 'post', scope: { post: object }, seo };
      }
      return {
        template: row.template ? `page.${row.template}` : 'page',
        pageType: 'page',
        scope: { page: { ...object, ...(await pageExtras(ctx, row)) } },
        seo,
      };
    }
    case 'not_found':
      return undefined;
  }
}

function notFound(site: PublicSite): Page {
  return {
    template: '404',
    pageType: '404',
    scope: {},
    seo: {
      title: `${strings(site).notFound} – ${site.name}`,
      description: '',
      type: 'website',
      image: undefined,
      noindex: true,
    },
  };
}

// --- listings -------------------------------------------------------------------------------

async function listing(ctx: Ctx, template: string, page: number, where?: SQL) {
  const { tx, site, theme } = ctx;
  const size = theme.engine.pageSize(template) ?? pageSizeSetting(site);
  const filter = and(eq(posts.siteId, site.id), eq(posts.type, 'post'), isLive(), where);
  const [{ total } = { total: 0 }] = await tx.select({ total: count() }).from(posts).where(filter);
  const pages = Math.max(1, Math.ceil(total / size));
  if (page > pages) return undefined;
  const rows = await tx
    .select()
    .from(posts)
    .where(filter)
    .orderBy(desc(posts.publishedAt), desc(posts.id))
    .limit(size)
    .offset((page - 1) * size);
  return { posts: await postObjects(ctx, rows), paginate: paginate(ctx, page, pages) };
}

/** Posts in a tag, or in a category or any of its subcategories (like WordPress). */
function inTerm(tx: Tx, term: Term): SQL {
  const matching =
    term.taxonomy === 'tag'
      ? eq(terms.id, term.id)
      : or(
          eq(terms.id, term.id),
          and(
            eq(terms.taxonomy, 'category'),
            like(terms.path, `${term.path.replace(/[\\%_]/g, '\\$&')}/%`),
          ),
        );
  return inArray(
    posts.id,
    tx
      .select({ id: postTerms.postId })
      .from(postTerms)
      .innerJoin(terms, eq(terms.id, postTerms.termId))
      .where(matching),
  );
}

function paginate(ctx: Ctx, current: number, pages: number) {
  const { site, req } = ctx;
  const [base] = splitPagination(site.permalinks, req.path);
  const url = (n: number) => paginatedUrl(site.permalinks, base, n);
  // First, last and two around the current page; gaps become an ellipsis.
  const shown = [
    ...new Set([1, current - 2, current - 1, current, current + 1, current + 2, pages]),
  ]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b);
  const parts: { title: string; url: string | null; is_link: boolean }[] = [];
  for (const [i, n] of shown.entries()) {
    if (i > 0 && n - shown[i - 1]! > 1) parts.push({ title: '…', url: null, is_link: false });
    parts.push({ title: String(n), url: url(n), is_link: n !== current });
  }
  return {
    current_page: current,
    pages,
    previous: current > 1 ? { url: url(current - 1) } : null,
    next: current < pages ? { url: url(current + 1) } : null,
    parts,
  };
}

// --- objects --------------------------------------------------------------------------------

async function postObjects(ctx: Ctx, rows: PostRow[]): Promise<Scope[]> {
  if (!rows.length) return [];
  const { tx, site } = ctx;
  const ids = rows.map((r) => r.id);
  const [urls, authors, media, links] = await Promise.all([
    postUrls(tx, site, rows),
    tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, [...new Set(rows.map((r) => r.authorId))])),
    mediaByIds(
      tx,
      site.id,
      rows.flatMap((r) => (r.featuredMediaId ? [r.featuredMediaId] : [])),
    ),
    tx
      .select({ postId: postTerms.postId, isPrimary: postTerms.isPrimary, term: terms })
      .from(postTerms)
      .innerJoin(terms, eq(terms.id, postTerms.termId))
      .where(inArray(postTerms.postId, ids))
      .orderBy(asc(terms.name)),
  ]);
  const authorName = new Map(authors.map((a) => [a.id, a.name]));
  const tags = await termNodes(
    tx,
    site,
    links.filter((l) => l.term.taxonomy === 'tag').map((l) => l.term),
  );
  const nodeOf = (term: Term) =>
    term.taxonomy === 'category' ? ctx.categories.byId.get(term.id) : tags.get(term.id);

  return rows.map((row) => {
    const own = links.filter((l) => l.postId === row.id);
    const categories = own.filter((l) => l.term.taxonomy === 'category');
    const primary = categories.find((l) => l.isPrimary) ?? categories[0];
    const image = row.featuredMediaId ? media.get(row.featuredMediaId) : undefined;
    return {
      id: row.id,
      title: row.title,
      url: urls.get(row.id) ?? '/',
      excerpt: row.excerpt ? safe(escapeHtml(row.excerpt)) : safe(derivedExcerpt(row, 55)),
      content: safe(row.contentHtml),
      published_at: row.publishedAt?.toISOString() ?? null,
      updated_at: row.updatedAt.toISOString(),
      author: { name: authorName.get(row.authorId) ?? '' },
      featured_image: image ? themeImage(image) : null,
      categories: categories.map((l) => nodeOf(l.term)),
      primary_category: primary ? nodeOf(primary.term) : null,
      tags: own.filter((l) => l.term.taxonomy === 'tag').map((l) => nodeOf(l.term)),
      comment_count: row.commentCount,
      comments_open: row.commentsOpen,
      // TODO(phase-3): approved comments.
      comments: [],
      reading_time: Math.max(1, Math.ceil(words(row.contentHtml) / 200)),
      seo: { title: row.seo.title ?? '', description: row.seo.description ?? '' },
    };
  });
}

async function pageExtras(ctx: Ctx, row: PostRow): Promise<Scope> {
  const { tx, site } = ctx;
  const live = and(eq(posts.siteId, site.id), eq(posts.type, 'page'), isLive());
  const [parents, children] = await Promise.all([
    row.parentId
      ? tx
          .select()
          .from(posts)
          .where(and(live, eq(posts.id, row.parentId)))
      : [],
    tx
      .select()
      .from(posts)
      .where(and(live, eq(posts.parentId, row.id)))
      .orderBy(asc(posts.title)),
  ]);
  const urls = await postUrls(tx, site, [...parents, ...children]);
  const link = (p: PostRow) => ({ title: p.title, url: urls.get(p.id) });
  return {
    parent: parents[0] ? link(parents[0]) : null,
    children: children.map(link),
    sections: row.sections ?? [],
  };
}

interface TermNode {
  name: string;
  slug: string;
  url: string;
  description: string;
  meta: Record<string, unknown>;
  post_count: number;
  parent: Omit<TermNode, 'parent' | 'children' | 'ancestors'> | null;
  children: TermNode[];
  ancestors: Omit<TermNode, 'parent' | 'children' | 'ancestors'>[];
}

interface CategoryTree {
  top: TermNode[];
  all: TermNode[];
  byId: Map<string, TermNode>;
}

/**
 * Every category with its live post count. Children nest downwards; `parent` and `ancestors`
 * are flat copies, so the graph has no cycles (themes may `json` a term).
 */
async function categoryTree(tx: Tx, site: PublicSite): Promise<CategoryTree> {
  const rows = await tx
    .select()
    .from(terms)
    .where(and(eq(terms.siteId, site.id), eq(terms.taxonomy, 'category')))
    .orderBy(asc(terms.sort), asc(terms.name));
  const nodes = await termNodes(tx, site, rows);
  const flat = (n: TermNode) => ({
    name: n.name,
    slug: n.slug,
    url: n.url,
    description: n.description,
    meta: n.meta,
    post_count: n.post_count,
  });
  const top: TermNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
      node.parent = flat(parent);
    } else top.push(node);
  }
  const byPath = new Map(rows.map((r) => [r.path, nodes.get(r.id)!]));
  for (const row of rows) {
    const parts = row.path.split('/');
    nodes.get(row.id)!.ancestors = parts
      .slice(0, -1)
      .map((_, i) => byPath.get(parts.slice(0, i + 1).join('/')))
      .filter((n): n is TermNode => n !== undefined)
      .map(flat);
  }
  const all = [...rows].sort((a, b) => a.path.localeCompare(b.path)).map((r) => nodes.get(r.id)!);
  return { top, all, byId: nodes };
}

async function termNodes(tx: Tx, site: PublicSite, rows: Term[]): Promise<Map<string, TermNode>> {
  const ids = [...new Set(rows.map((r) => r.id))];
  const counts = ids.length
    ? await tx
        .select({ termId: postTerms.termId, n: count() })
        .from(postTerms)
        .innerJoin(posts, eq(posts.id, postTerms.postId))
        .where(and(inArray(postTerms.termId, ids), isLive()))
        .groupBy(postTerms.termId)
    : [];
  const countOf = new Map(counts.map((c) => [c.termId, c.n]));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        name: r.name,
        slug: r.slug,
        url: termUrl(site, r),
        description: r.description,
        meta: r.meta,
        post_count: countOf.get(r.id) ?? 0,
        parent: null,
        children: [],
        ancestors: [],
      },
    ]),
  );
}

/** What the theme's image filters take; the WebP variants plus the original. */
export function themeImage(row: Media): ThemeImage {
  return {
    url: mediaUrl(row.path),
    width: row.width,
    height: row.height,
    alt: row.alt,
    variants: [
      ...row.variants
        .filter((v) => v.format === 'webp')
        .map((v) => ({ width: v.width, url: mediaUrl(v.path) })),
      { width: row.width, url: mediaUrl(row.path) },
    ],
  };
}

/** `menus.<location>.items[]`: links to unpublished posts or deleted terms are left out. */
async function menuScope(tx: Tx, site: PublicSite, path: string): Promise<Scope> {
  const all = await listMenus(tx, site.id);
  const items = all.flatMap((m) => flatten(m.items));
  const refs = (kind: MenuItem['kind']) => [
    ...new Set(items.filter((i) => i.kind === kind).map((i) => i.ref!)),
  ];
  const [postIds, termIds] = [refs('post'), refs('term')];
  const [live, termRows] = await Promise.all([
    postIds.length
      ? tx
          .select()
          .from(posts)
          .where(and(eq(posts.siteId, site.id), inArray(posts.id, postIds), isLive()))
      : [],
    termIds.length
      ? tx
          .select()
          .from(terms)
          .where(and(eq(terms.siteId, site.id), inArray(terms.id, termIds)))
      : [],
  ]);
  const postLinks = await postUrls(tx, site, live);
  const termLinks = new Map(termRows.map((t) => [t.id, termUrl(site, t)]));
  const current = safeDecode(path);
  const build = (list: MenuItem[]): Scope[] =>
    list.flatMap((item) => {
      const url =
        item.kind === 'url'
          ? item.url
          : (item.kind === 'post' ? postLinks : termLinks).get(item.ref!);
      if (!url) return [];
      const children = build(item.children);
      const active = url === current || children.some((c) => c.active === true);
      return [{ label: item.label, url, active, children }];
    });
  return Object.fromEntries(all.map((m) => [m.location, { items: build(m.items) }]));
}

function safeDecode(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

// --- SEO ------------------------------------------------------------------------------------

function seoTags(
  site: PublicSite,
  seo: Seo,
  canonical: string,
  origin: string,
  notFound: boolean,
): string {
  const attr = escapeHtml;
  const meta = (key: 'name' | 'property', name: string, content: string | undefined) =>
    content ? `<meta ${key}="${name}" content="${attr(content)}">` : '';
  const image = seo.image && origin + mediaUrl(seo.image.path);
  return [
    `<title>${escapeHtml(seo.title)}</title>`,
    meta('name', 'description', seo.description),
    notFound ? '' : `<link rel="canonical" href="${attr(canonical)}">`,
    seo.noindex ? meta('name', 'robots', 'noindex') : '',
    meta('property', 'og:site_name', site.name),
    meta('property', 'og:type', seo.type),
    meta('property', 'og:title', seo.title),
    meta('property', 'og:description', seo.description),
    meta('property', 'og:url', canonical),
    meta('property', 'og:locale', site.locale.replace('-', '_')),
    meta('property', 'og:image', image),
    meta('name', 'twitter:card', image ? 'summary_large_image' : 'summary'),
    seo.jsonLd
      ? `<script type="application/ld+json">${scriptJson({
          '@context': 'https://schema.org',
          ...seo.jsonLd,
          ...(image ? { image } : {}),
        })}</script>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** JSON that cannot end a `<script>` element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// --- helpers --------------------------------------------------------------------------------

async function images(
  tx: Tx,
  siteId: string,
  ids: (string | null | undefined)[],
): Promise<Media[]> {
  const wanted = ids.filter(
    (id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id),
  );
  const found = await mediaByIds(tx, siteId, wanted);
  return wanted.flatMap((id) => found.get(id) ?? []);
}

function setting(site: PublicSite, key: string): string | undefined {
  const value = site.settings[key];
  return typeof value === 'string' ? value : undefined;
}

function socialLinks(site: PublicSite): Record<string, string> {
  const value = site.settings.social;
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && /^https?:\/\//.test(e[1]),
    ),
  );
}

function pageSizeSetting(site: PublicSite): number {
  const n = Number(site.settings.posts_per_page);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : DEFAULT_PAGE_SIZE;
}

function strings(site: PublicSite) {
  return site.locale.startsWith('tr') ? STRINGS.tr : STRINGS.en;
}

function paged(site: PublicSite, title: string, page: number): string {
  return page > 1 ? `${title} – ${strings(site).page} ${page}` : title;
}

function words(html: string): number {
  return stripHtml(html).split(' ').filter(Boolean).length;
}

/** First words of the content, as HTML text (entities kept, no tags). */
function derivedExcerpt(row: PostRow, count: number): string {
  const all = stripHtml(row.contentHtml).split(' ').filter(Boolean);
  return all.length > count ? `${all.slice(0, count).join(' ')}…` : all.join(' ');
}

/** Excerpt as plain text, for meta descriptions (escaped again when output). */
function plainExcerpt(row: PostRow, count: number): string {
  if (row.excerpt) return row.excerpt;
  return derivedExcerpt(row, count)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}
