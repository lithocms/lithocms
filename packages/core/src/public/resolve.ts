import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { posts, postTerms, sites, terms } from '../db/schema.js';
import type { PostRow } from '../content/posts.js';
import type { Term } from '../content/terms.js';
import {
  categoryUrl,
  defaultPermalinks,
  matchPattern,
  pageUrl,
  Permalinks,
  postUrl,
  splitPagination,
  tagUrl,
} from './permalinks.js';

/** What the public router needs to know about a site. */
export interface PublicSite {
  id: string;
  locale: string;
  timezone: string;
  permalinks: Permalinks;
}

export type Resolved =
  | { type: 'index'; page: number }
  | { type: 'search'; query: string; page: number }
  | { type: 'post' | 'page'; post: PostRow }
  | { type: 'category' | 'tag'; term: Term; page: number }
  | { type: 'archive'; year: number; month: number | null; page: number }
  | { type: 'redirect'; location: string }
  | { type: 'not_found' };

/** Published, or scheduled with its time reached (the scheduler only tidies the status). */
export const isLive = (): SQL =>
  sql`(${posts.status} = 'published' or (${posts.status} = 'scheduled' and ${posts.publishedAt} <= now()))`;

export async function loadPublicSite(tx: Tx, siteId: string): Promise<PublicSite> {
  const [row] = await tx
    .select({
      id: sites.id,
      locale: sites.locale,
      timezone: sites.timezone,
      permalinks: sites.permalinks,
    })
    .from(sites)
    .where(eq(sites.id, siteId));
  if (!row) throw new Error(`Unknown site ${siteId}`);
  const parsed = Permalinks.safeParse(row.permalinks);
  return { ...row, permalinks: parsed.success ? parsed.data : defaultPermalinks(row.locale) };
}

/** Maps a request path (and `?s=` search) to what should be rendered there. */
export async function resolvePath(
  tx: Tx,
  site: PublicSite,
  path: string,
  search?: string,
): Promise<Resolved> {
  const p = site.permalinks;
  // WordPress style: every page URL ends with a slash.
  if (!path.endsWith('/') && !/\.[a-z0-9]+$/i.test(path)) {
    return { type: 'redirect', location: `${path}/` };
  }
  const [base, page] = splitPagination(p, path);
  const decoded = safeDecode(base);
  if (decoded === null) return { type: 'not_found' };

  if (base === '/') {
    if (search !== undefined) return { type: 'search', query: search.slice(0, 200), page };
    return { type: 'index', page };
  }

  const category = matchPattern(p.category, decoded);
  if (category) {
    const term = await findTerm(tx, site.id, 'category', eq(terms.path, category.path!));
    return term ? { type: 'category', term, page } : { type: 'not_found' };
  }
  const tag = matchPattern(p.tag, decoded);
  if (tag) {
    const term = await findTerm(tx, site.id, 'tag', eq(terms.slug, tag.slug!));
    return term ? { type: 'tag', term, page } : { type: 'not_found' };
  }
  const archive = matchPattern(p.archive, decoded) ?? matchPattern('/:year/', decoded);
  if (archive && isArchiveDate(archive)) {
    return {
      type: 'archive',
      year: Number(archive.year),
      month: archive.month ? Number(archive.month) : null,
      page,
    };
  }
  if (page > 1) return { type: 'not_found' };

  const pagePath = matchPattern(p.page, decoded);
  if (pagePath) {
    const found = await findPage(tx, site.id, pagePath.path!);
    if (found) return { type: 'page', post: found };
  }
  const postMatch = matchPattern(p.post, decoded);
  if (postMatch) {
    const where = postMatch.id ? eq(posts.id, postMatch.id) : eq(posts.slug, postMatch.slug!);
    const [found] = await tx
      .select()
      .from(posts)
      .where(and(eq(posts.siteId, site.id), eq(posts.type, 'post'), where, isLive()))
      .limit(1);
    if (found) {
      const canonical = (await postUrls(tx, site, [found])).get(found.id)!;
      // Same post under an outdated date or category: send it to its current address.
      return canonical === decoded
        ? { type: 'post', post: found }
        : { type: 'redirect', location: encodeURI(canonical) };
    }
  }
  return { type: 'not_found' };
}

/** Current public URLs (paths) of posts and pages, following the site's permalinks. */
export async function postUrls(
  tx: Tx,
  site: PublicSite,
  rows: Pick<PostRow, 'id' | 'type' | 'slug' | 'parentId' | 'publishedAt'>[],
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  const pages = rows.filter((r) => r.type === 'page');
  const postsOnly = rows.filter((r) => r.type === 'post');

  if (pages.length) {
    const { rows: paths } = await tx.execute<{ id: string; path: string }>(sql`
      with recursive up as (
        select id as start, parent_id, slug, 1 as depth from posts
        where id in (${sql.join(
          pages.map((r) => sql`${r.id}`),
          sql`, `,
        )})
        union all
        select up.start, p.parent_id, p.slug, up.depth + 1
        from posts p join up on p.id = up.parent_id where up.depth < 50
      )
      select start as id, string_agg(slug, '/' order by depth desc) as path from up group by start`);
    for (const r of paths) urls.set(r.id, pageUrl(site.permalinks, r.path));
  }
  if (postsOnly.length) {
    const categories = site.permalinks.post.includes(':category')
      ? await primaryCategories(
          tx,
          postsOnly.map((r) => r.id),
        )
      : new Map<string, string>();
    for (const r of postsOnly) {
      urls.set(
        r.id,
        postUrl(
          site.permalinks,
          {
            id: r.id,
            slug: r.slug,
            publishedAt: r.publishedAt,
            category: categories.get(r.id) ?? null,
          },
          site.timezone,
        ),
      );
    }
  }
  return urls;
}

export const termUrl = (site: PublicSite, term: Pick<Term, 'taxonomy' | 'path' | 'slug'>) =>
  term.taxonomy === 'category'
    ? categoryUrl(site.permalinks, term.path)
    : tagUrl(site.permalinks, term.slug);

async function primaryCategories(tx: Tx, postIds: string[]): Promise<Map<string, string>> {
  const rows = await tx
    .select({ postId: postTerms.postId, path: terms.path })
    .from(postTerms)
    .innerJoin(terms, eq(terms.id, postTerms.termId))
    .where(and(inArray(postTerms.postId, postIds), eq(postTerms.isPrimary, true)));
  return new Map(rows.map((r) => [r.postId, r.path]));
}

async function findTerm(tx: Tx, siteId: string, taxonomy: Term['taxonomy'], where: SQL) {
  const [term] = await tx
    .select()
    .from(terms)
    .where(and(eq(terms.siteId, siteId), eq(terms.taxonomy, taxonomy), where))
    .limit(1);
  return term;
}

async function findPage(tx: Tx, siteId: string, path: string): Promise<PostRow | undefined> {
  const last = path.split('/').at(-1)!;
  const { rows } = await tx.execute<{ id: string }>(sql`
    with recursive up as (
      select id as start, parent_id, slug, 1 as depth from posts
      where site_id = ${siteId} and type = 'page' and slug = ${last} and ${isLive()}
      union all
      select up.start, p.parent_id, p.slug, up.depth + 1
      from posts p join up on p.id = up.parent_id where up.depth < 50
    )
    select start as id from up group by start
    having string_agg(slug, '/' order by depth desc) = ${path} limit 1`);
  if (!rows[0]) return undefined;
  const [row] = await tx.select().from(posts).where(eq(posts.id, rows[0].id));
  return row;
}

function isArchiveDate(m: Record<string, string>): boolean {
  const year = Number(m.year);
  const month = m.month ? Number(m.month) : 1;
  return year >= 1990 && year <= 2200 && month >= 1 && month <= 12;
}

function safeDecode(path: string): string | null {
  try {
    return decodeURIComponent(path).normalize('NFC').toLowerCase();
  } catch {
    return null;
  }
}
