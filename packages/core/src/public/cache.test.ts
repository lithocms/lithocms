import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../content/audit.js';
import { createPost, PostCreateInput, publishPost, updatePost } from '../content/posts.js';
import { createDb, runMigrations, withSite, type Db, type Tx } from '../db/client.js';
import { pageCache, posts, sites, users } from '../db/schema.js';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import {
  CACHE_MAX_ENTRIES,
  CACHE_MAX_AGE_MS,
  cachedIds,
  cacheVersion,
  findCached,
  purgeCache,
  purgeTagsFor,
  storeCached,
} from './cache.js';

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let siteA: string;
let siteB: string;
let editor: Actor;

const inA = <T>(fn: (tx: Tx) => Promise<T>) => withSite(db, siteA, fn);
const store = async (path: string, tags: string[]) =>
  inA(async (tx) => storeCached(tx, siteA, path, await cacheVersion(tx, siteA), tags));
const find = (path: string) => inA((tx) => findCached(tx, siteA, path));

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  ({ db, pool } = createDb(tdb.appUrl));
  [siteA, siteB] = (
    await db
      .insert(sites)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning()
  ).map((s) => s.id) as [string, string];
  const [user] = await db.insert(users).values({ name: 'E', email: 'e@example.com' }).returning();
  editor = { userId: user!.id, role: 'editor', channel: 'admin' };
});

afterAll(async () => {
  await pool.end();
  await tdb.stop();
});

describe('page cache', () => {
  it('maps writes to tags, purging everything for unknown ones', () => {
    expect(purgeTagsFor({ action: 'post.update', entityType: 'post', entityId: '1' })).toEqual([
      'post:1',
      'lists',
      'categories',
    ]);
    expect(purgeTagsFor({ action: 'media.upload', entityType: 'media', entityId: '1' })).toEqual(
      [],
    );
    expect(purgeTagsFor({ action: 'category.update', entityType: 'category', entityId: '1' })).toBe(
      'all',
    );
    expect(purgeTagsFor({ action: 'x.y', entityType: 'something-new', entityId: '1' })).toBe('all');
  });

  it('purges entries by tag, or all of a site, never another site', async () => {
    const a = await store('/a/', ['post:1', 'lists']);
    const b = await store('/b/', ['menus']);
    await withSite(db, siteB, async (tx) =>
      storeCached(tx, siteB, '/a/', await cacheVersion(tx, siteB), ['lists']),
    );
    expect([await find('/a/'), await find('/b/')]).toEqual([a, b]);
    await inA((tx) => purgeCache(tx, siteA, ['lists']));
    expect([await find('/a/'), await find('/b/')]).toEqual([undefined, b]);
    await inA((tx) => purgeCache(tx, siteA, 'all'));
    expect(await find('/b/')).toBeUndefined();
    expect(await withSite(db, siteB, (tx) => findCached(tx, siteB, '/a/'))).toEqual(
      expect.any(String),
    );
  });

  it('stops storing at the per-site entry limit', async () => {
    await inA((tx) =>
      tx.insert(pageCache).values(
        Array.from({ length: CACHE_MAX_ENTRIES }, (_, i) => ({
          siteId: siteA,
          path: `/fill/${i}/`,
        })),
      ),
    );
    expect(await store('/one-more/', [])).toBeUndefined();
    // Replacing an existing entry still works.
    expect(await store('/fill/1/', [])).toEqual(expect.any(String));
    // Expired entries neither count nor stay once swept.
    await inA((tx) =>
      tx.update(pageCache).set({ createdAt: new Date(Date.now() - CACHE_MAX_AGE_MS - 1000) }),
    );
    expect(await store('/one-more/', [])).toEqual(expect.any(String));
    expect((await inA((tx) => cachedIds(tx, siteA))).size).toBe(1);
    await inA((tx) => purgeCache(tx, siteA, 'all'));
  });

  it('does not store a render that overlapped a purge', async () => {
    const version = await inA((tx) => cacheVersion(tx, siteA));
    await inA((tx) => purgeCache(tx, siteA, ['menus']));
    expect(await inA((tx) => storeCached(tx, siteA, '/c/', version, []))).toBeUndefined();
    expect(await find('/c/')).toBeUndefined();
  });

  it('is purged by audited writes', async () => {
    const post = await inA(async (tx) => {
      const p = await createPost(
        tx,
        siteA,
        editor,
        PostCreateInput.parse({ type: 'post', title: 'P' }),
      );
      return publishPost(tx, siteA, editor, p.id);
    });
    await store('/p/', [`post:${post.id}`]);
    await store('/other/', ['post:someone-else']);
    await inA((tx) => updatePost(tx, siteA, editor, post.id, { title: 'P2' }));
    expect(await find('/p/')).toBeUndefined();
    expect(await find('/other/')).toEqual(expect.any(String));
  });

  it('expires entries when a scheduled post goes live', async () => {
    await store('/s/', []);
    expect(await find('/s/')).toEqual(expect.any(String));
    // Written directly: going live is a matter of time, not a write.
    await inA((tx) =>
      tx.insert(posts).values({
        siteId: siteA,
        type: 'post',
        slug: 'later',
        title: 'Later',
        content: { type: 'doc', content: [] },
        status: 'scheduled',
        publishedAt: new Date(Date.now() + 1500),
        authorId: editor.userId,
      }),
    );
    expect(await find('/s/')).toEqual(expect.any(String));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await find('/s/')).toBeUndefined();
  });
});
