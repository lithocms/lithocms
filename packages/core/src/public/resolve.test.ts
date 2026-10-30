import { eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../content/audit.js';
import { DocInput } from '../content/input.js';
import { createPost, PostCreateInput, publishPost, type Post } from '../content/posts.js';
import { createTerm } from '../content/terms.js';
import { createDb, runMigrations, withSite, type Db, type Tx } from '../db/client.js';
import { posts, sites, users } from '../db/schema.js';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import { loadPublicSite, resolvePath, type Resolved } from './resolve.js';

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let siteId: string;
let editor: Actor;
const ids: Record<string, string> = {};

const inSite = <T>(fn: (tx: Tx) => Promise<T>) => withSite(db, siteId, fn);
const resolve = (path: string, search?: string) =>
  inSite(async (tx) => resolvePath(tx, await loadPublicSite(tx, siteId), path, search));
const summary = (r: Resolved) =>
  r.type === 'post' || r.type === 'page'
    ? { type: r.type, id: r.post.id }
    : r.type === 'category' || r.type === 'tag'
      ? { type: r.type, path: r.term.path, page: r.page }
      : r;

async function make(input: Record<string, unknown>, publish = true): Promise<Post> {
  return inSite(async (tx) => {
    const p = await createPost(
      tx,
      siteId,
      editor,
      PostCreateInput.parse({ type: 'post', ...input }),
    );
    return publish ? publishPost(tx, siteId, editor, p.id, new Date('2026-02-01T09:00:00Z')) : p;
  });
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  ({ db, pool } = createDb(tdb.appUrl));
  const [site] = await db
    .insert(sites)
    .values({ name: 'Site', locale: 'tr', timezone: 'Europe/Istanbul' })
    .returning();
  siteId = site!.id;
  const [user] = await db.insert(users).values({ name: 'E', email: 'e@example.com' }).returning();
  editor = { userId: user!.id, role: 'editor', channel: 'admin' };

  const news = await inSite((tx) =>
    createTerm(tx, siteId, editor, { taxonomy: 'category', name: 'Haber' }),
  );
  const world = await inSite((tx) =>
    createTerm(tx, siteId, editor, { taxonomy: 'category', name: 'Dünya', parentId: news.id }),
  );
  ids.world = world.id;
  await inSite((tx) => createTerm(tx, siteId, editor, { taxonomy: 'tag', name: 'Ekonomi' }));
  ids.post = (await make({ title: 'Merhaba', termIds: [world.id] })).id;
  ids.draft = (await make({ title: 'Taslak' }, false)).id;
  const about = await make({ type: 'page', title: 'Hakkımızda' });
  ids.about = about.id;
  ids.team = (await make({ type: 'page', title: 'Ekip', parentId: about.id })).id;
});

afterAll(async () => {
  await pool.end();
  await tdb.stop();
});

describe('resolvePath', () => {
  it.each([
    ['/', { type: 'index', page: 1 }],
    ['/page/2/', { type: 'index', page: 2 }],
    ['/kategori/haber/dunya/', { type: 'category', path: 'haber/dunya', page: 1 }],
    ['/kategori/haber/page/2/', { type: 'category', path: 'haber', page: 2 }],
    ['/etiket/ekonomi/', { type: 'tag', path: 'ekonomi', page: 1 }],
    ['/2026/02/', { type: 'archive', year: 2026, month: 2, page: 1 }],
    ['/2026/', { type: 'archive', year: 2026, month: null, page: 1 }],
    ['/hakkimizda', { type: 'redirect', location: '/hakkimizda/' }],
    ['/kategori/yok/', { type: 'not_found' }],
    ['/taslak/', { type: 'not_found' }],
    ['/hakkimizda/page/2/', { type: 'not_found' }],
    ['/%E0%A4%A/', { type: 'not_found' }],
    ['//evil.example', { type: 'not_found' }],
    ['/\\evil.example', { type: 'not_found' }],
    ['/a\\b', { type: 'not_found' }],
  ])('%s', async (path, expected) => {
    expect(summary(await resolve(path))).toEqual(expected);
  });

  it('finds posts and nested pages', async () => {
    expect(summary(await resolve('/merhaba/'))).toEqual({ type: 'post', id: ids.post });
    expect(summary(await resolve('/hakkimizda/'))).toEqual({ type: 'page', id: ids.about });
    expect(summary(await resolve('/hakkimizda/ekip/'))).toEqual({ type: 'page', id: ids.team });
    expect(summary(await resolve('/ekip/'))).toEqual({ type: 'not_found' });
  });

  it('answers searches on the home URL', async () => {
    expect(await resolve('/', 'çay')).toEqual({ type: 'search', query: 'çay', page: 1 });
  });

  it('serves scheduled posts once their time has come', async () => {
    const future = await inSite(async (tx) => {
      const p = await createPost(
        tx,
        siteId,
        editor,
        PostCreateInput.parse({ type: 'post', title: 'Yakında' }),
      );
      return publishPost(tx, siteId, editor, p.id, new Date(Date.now() + 3_600_000));
    });
    expect((await resolve('/yakinda/')).type).toBe('not_found');
    // The database clock decides, not this process's (they can drift in test containers).
    await inSite((tx) =>
      tx
        .update(posts)
        .set({ publishedAt: sql`now() - interval '1 minute'` })
        .where(eq(posts.id, future.id)),
    );
    expect((await resolve('/yakinda/')).type).toBe('post');
  });

  describe('with date and category permalinks', () => {
    beforeAll(async () => {
      await db
        .update(sites)
        .set({
          permalinks: {
            post: '/:category/:year/:slug/',
            page: '/:path/',
            category: '/konu/:path/',
            tag: '/etiket/:slug/',
            pagination: '/sayfa/:n/',
            archive: '/arsiv/:year/:month/',
          },
        })
        .where(eq(sites.id, siteId));
    });

    it('resolves the canonical URL and redirects outdated ones', async () => {
      expect(summary(await resolve('/haber/dunya/2026/merhaba/'))).toEqual({
        type: 'post',
        id: ids.post,
      });
      expect(await resolve('/eski/2019/merhaba/')).toEqual({
        type: 'redirect',
        location: '/haber/dunya/2026/merhaba/',
      });
      expect(summary(await resolve('/konu/haber/sayfa/2/'))).toEqual({
        type: 'category',
        path: 'haber',
        page: 2,
      });
      expect((await resolve('/arsiv/2026/02/')).type).toBe('archive');
    });

    it('renders links in content with the current permalink', async () => {
      const linking = await make({
        title: 'Bağlantı',
        content: DocInput.parse({
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'x',
                  marks: [{ type: 'link', attrs: { href: `post:${ids.post}` } }],
                },
              ],
            },
          ],
        }),
      });
      expect(linking.contentHtml).toContain('href="/haber/dunya/2026/merhaba/"');
    });
  });
});
