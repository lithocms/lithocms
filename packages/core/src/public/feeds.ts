import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { posts, postTerms, terms, users } from '../db/schema.js';
import { isLive, loadPublicSite, postUrls, termUrl } from './resolve.js';

// sitemap.xml, robots.txt and the RSS feed of a site. `origin` is the site's primary origin.

const PER_SITEMAP = 2000;
const FEED_SIZE = 20;

const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
/** URLs in XML: paths may hold non-ASCII slugs. */
const loc = (origin: string, path: string) => xml(origin + encodeURI(path));

const indexable = () => sql`coalesce((${posts.seo}->>'noindex')::boolean, false) = false`;

/** Search engines asked to stay away (site setting). */
const hidden = (settings: Record<string, unknown>) => settings.search_engines === false;

export function robotsTxt(settings: Record<string, unknown>, origin: string): string {
  if (hidden(settings)) return 'User-agent: *\nDisallow: /\n';
  return `User-agent: *\nDisallow: /_forms/\n\nSitemap: ${origin}/sitemap.xml\n`;
}

type SitemapKind = 'posts' | 'pages' | 'categories' | 'tags';

/** `/sitemap.xml`: one child sitemap per kind and chunk. */
export async function sitemapIndex(tx: Tx, siteId: string, origin: string): Promise<string> {
  const counts = await Promise.all(
    (['post', 'page'] as const).map(async (type) => {
      const [row] = await tx
        .select({ n: count() })
        .from(posts)
        .where(and(eq(posts.siteId, siteId), eq(posts.type, type), isLive(), indexable()));
      return row?.n ?? 0;
    }),
  );
  const parts: string[] = [];
  for (const [i, kind] of (['posts', 'pages'] as const).entries()) {
    const chunks = Math.ceil(counts[i]! / PER_SITEMAP);
    for (let n = 1; n <= chunks; n++) parts.push(`/sitemap-${kind}-${n}.xml`);
  }
  parts.push('/sitemap-categories-1.xml', '/sitemap-tags-1.xml');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...parts.map((p) => `<sitemap><loc>${loc(origin, p)}</loc></sitemap>`),
    '</sitemapindex>',
  ].join('\n');
}

/** One child sitemap, or undefined when that chunk does not exist. */
export async function sitemapPart(
  tx: Tx,
  siteId: string,
  origin: string,
  kind: SitemapKind,
  chunk: number,
): Promise<string | undefined> {
  const site = await loadPublicSite(tx, siteId);
  let entries: { path: string; lastmod?: Date }[];
  if (kind === 'posts' || kind === 'pages') {
    const rows = await tx
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.siteId, siteId),
          eq(posts.type, kind === 'posts' ? 'post' : 'page'),
          isLive(),
          indexable(),
        ),
      )
      .orderBy(asc(posts.publishedAt), asc(posts.id))
      .limit(PER_SITEMAP)
      .offset((chunk - 1) * PER_SITEMAP);
    if (!rows.length && chunk > 1) return undefined;
    const urls = await postUrls(tx, site, rows);
    entries = rows.map((r) => ({ path: urls.get(r.id)!, lastmod: r.updatedAt }));
  } else {
    if (chunk !== 1) return undefined;
    // Only terms with live posts: empty archives are thin pages.
    const rows = await tx
      .selectDistinct({ term: terms })
      .from(terms)
      .innerJoin(postTerms, eq(postTerms.termId, terms.id))
      .innerJoin(posts, eq(posts.id, postTerms.postId))
      .where(
        and(
          eq(terms.siteId, siteId),
          eq(terms.taxonomy, kind === 'categories' ? 'category' : 'tag'),
          isLive(),
        ),
      )
      .limit(50_000);
    entries = rows.map((r) => ({ path: termUrl(site, r.term) }));
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(
      (e) =>
        `<url><loc>${loc(origin, e.path)}</loc>${e.lastmod ? `<lastmod>${e.lastmod.toISOString()}</lastmod>` : ''}</url>`,
    ),
    '</urlset>',
  ].join('\n');
}

/** `/feed/`: RSS 2.0 with the latest posts and their full content. */
export async function rssFeed(tx: Tx, siteId: string, origin: string): Promise<string> {
  const site = await loadPublicSite(tx, siteId);
  const rows = await tx
    .select({ post: posts, author: users.name })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(and(eq(posts.siteId, siteId), eq(posts.type, 'post'), isLive()))
    .orderBy(desc(posts.publishedAt), desc(posts.id))
    .limit(FEED_SIZE);
  const urls = await postUrls(
    tx,
    site,
    rows.map((r) => r.post),
  );
  const tagline = typeof site.settings.tagline === 'string' ? site.settings.tagline : '';
  const items = rows.map(({ post, author }) => {
    const link = loc(origin, urls.get(post.id)!);
    return [
      '<item>',
      `<title>${xml(post.title)}</title>`,
      `<link>${link}</link>`,
      `<guid isPermaLink="false">${post.id}</guid>`,
      `<pubDate>${(post.publishedAt ?? post.createdAt).toUTCString()}</pubDate>`,
      `<dc:creator>${xml(author)}</dc:creator>`,
      post.excerpt ? `<description>${xml(post.excerpt)}</description>` : '',
      // Sanitized at save time; escaped here, so no CDATA edge cases.
      `<content:encoded>${xml(post.contentHtml)}</content:encoded>`,
      '</item>',
    ]
      .filter(Boolean)
      .join('');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `<title>${xml(site.name)}</title>`,
    `<link>${xml(origin)}/</link>`,
    `<atom:link href="${xml(origin)}/feed/" rel="self" type="application/rss+xml"/>`,
    `<description>${xml(tagline)}</description>`,
    `<language>${xml(site.locale)}</language>`,
    ...items,
    '</channel>',
    '</rss>',
  ].join('\n');
}
