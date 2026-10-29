import { and, count, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { pageCache, pageCacheTags, posts, sites } from '../db/schema.js';

// Page cache bookkeeping (ARCHITECTURE.md, rendering pipeline). Entries and their tags live
// here; the HTML files are the server's. Every write purges by tag through `audit()`, in the
// same transaction, so a purge commits with the change that caused it.

/** Entries are re-rendered at least this often (form tokens, safety net). */
export const CACHE_MAX_AGE_MS = 24 * 3_600_000;

/** Beyond this many entries a site's further pages render uncached (disk bound). */
export const CACHE_MAX_ENTRIES = 20_000;

export type PurgeTags = string[] | 'all';

/** What a write invalidates, from its audit entry. Unknown writes purge the whole site. */
export function purgeTagsFor(entry: {
  action: string;
  entityType: string;
  entityId: string;
}): PurgeTags {
  switch (entry.entityType) {
    case 'post':
      // Listings, archives and category post counts may change too.
      return [`post:${entry.entityId}`, 'lists', 'categories'];
    case 'page':
      // Pages link their parent and children.
      return [`post:${entry.entityId}`, 'pages'];
    case 'menu':
      return ['menus'];
    case 'slot':
      return ['slots'];
    case 'collection':
    case 'collection_entry':
      return ['collections'];
    case 'form':
      return ['forms'];
    // Uploading or deleting a theme the site does not use changes no page (activation does).
    case 'form_submission':
    case 'theme_version':
    case 'theme_package':
      return [];
    case 'media':
      return entry.action === 'media.upload' ? [] : 'all';
    // Terms change URLs, names and counts shown almost everywhere; they rarely change.
    default:
      return 'all';
  }
}

export async function purgeCache(tx: Tx, siteId: string, tags: PurgeTags): Promise<void> {
  if (tags !== 'all' && !tags.length) return;
  // First: renders that overlapped this write see the new version and are not stored, and a
  // store holding the site row lock finishes before the delete below runs (see `storeCached`).
  await tx
    .update(sites)
    .set({ cacheVersion: sql`${sites.cacheVersion} + 1` })
    .where(eq(sites.id, siteId));
  await tx.delete(pageCache).where(
    and(
      eq(pageCache.siteId, siteId),
      tags === 'all'
        ? undefined
        : inArray(
            pageCache.id,
            tx
              .select({ id: pageCacheTags.cacheId })
              .from(pageCacheTags)
              .where(and(eq(pageCacheTags.siteId, siteId), inArray(pageCacheTags.tag, tags))),
          ),
    ),
  );
}

export async function cacheVersion(tx: Tx, siteId: string): Promise<number> {
  const [row] = await tx.select({ v: sites.cacheVersion }).from(sites).where(eq(sites.id, siteId));
  return row?.v ?? 0;
}

/** The id of a usable cache entry for `path`. */
export async function findCached(
  tx: Tx,
  siteId: string,
  path: string,
): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: pageCache.id, createdAt: pageCache.createdAt })
    .from(pageCache)
    .where(
      and(
        eq(pageCache.siteId, siteId),
        eq(pageCache.path, path),
        gt(pageCache.createdAt, expiry()),
      ),
    );
  if (!row) return undefined;
  // A scheduled post went live since: listings, counts and menus may have changed.
  const [due] = await tx
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        eq(posts.siteId, siteId),
        eq(posts.status, 'scheduled'),
        gt(posts.publishedAt, row.createdAt),
        lte(posts.publishedAt, sql`now()`),
      ),
    )
    .limit(1);
  return due ? undefined : row.id;
}

/**
 * Records a rendered page; returns its id, or undefined when a purge happened since the render
 * read `version` (the page may show old content).
 */
export async function storeCached(
  tx: Tx,
  siteId: string,
  path: string,
  version: number,
  tags: string[],
): Promise<string | undefined> {
  // Shares the row lock a purge takes, so purge and store never interleave.
  const [site] = await tx
    .select({ v: sites.cacheVersion })
    .from(sites)
    .where(eq(sites.id, siteId))
    .for('share');
  if (site?.v !== version) return undefined;
  await tx.delete(pageCache).where(and(eq(pageCache.siteId, siteId), eq(pageCache.path, path)));
  // Live entries only; expired ones are deleted by `cachedIds` (the sweep). Concurrent stores
  // may overshoot the limit by a few entries.
  const [{ n } = { n: 0 }] = await tx
    .select({ n: count() })
    .from(pageCache)
    .where(and(eq(pageCache.siteId, siteId), gt(pageCache.createdAt, expiry())));
  if (n >= CACHE_MAX_ENTRIES) return undefined;
  const [row] = await tx.insert(pageCache).values({ siteId, path }).returning({ id: pageCache.id });
  if (tags.length) {
    await tx
      .insert(pageCacheTags)
      .values([...new Set(tags)].map((tag) => ({ siteId, cacheId: row!.id, tag })));
  }
  return row!.id;
}

/** Deletes the site's expired entries and returns the ids of the rest; other files are stale. */
export async function cachedIds(tx: Tx, siteId: string): Promise<Set<string>> {
  await tx
    .delete(pageCache)
    .where(and(eq(pageCache.siteId, siteId), lte(pageCache.createdAt, expiry())));
  const rows = await tx
    .select({ id: pageCache.id })
    .from(pageCache)
    .where(eq(pageCache.siteId, siteId));
  return new Set(rows.map((r) => r.id));
}

const expiry = () => new Date(Date.now() - CACHE_MAX_AGE_MS);
