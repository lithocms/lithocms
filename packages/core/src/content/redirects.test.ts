import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations, withSite, type Db, type Tx } from '../db/client.js';
import { redirects, sites, users } from '../db/schema.js';
import { Conflict, Forbidden } from '../errors.js';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import type { Actor } from './audit.js';
import { createPost, PostCreateInput, publishPost, updatePost } from './posts.js';
import { createRedirect, hitRedirect, RedirectInput } from './redirects.js';

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let siteId: string;
let admin: Actor;
let editor: Actor;

const inSite = <T>(fn: (tx: Tx) => Promise<T>) => withSite(db, siteId, fn);
const table = async () =>
  (await inSite((tx) => tx.select().from(redirects))).map((r) => `${r.fromPath} -> ${r.to}`).sort();
const live = (input: Record<string, unknown>) =>
  inSite(async (tx) => {
    const p = await createPost(
      tx,
      siteId,
      editor,
      PostCreateInput.parse({ type: 'post', ...input }),
    );
    return publishPost(tx, siteId, editor, p.id);
  });
const rename = (id: string, change: Record<string, unknown>) =>
  inSite((tx) => updatePost(tx, siteId, editor, id, change));

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  ({ db, pool } = createDb(tdb.appUrl));
  const [site] = await db.insert(sites).values({ name: 'S', locale: 'tr' }).returning();
  siteId = site!.id;
  const [u] = await db.insert(users).values({ name: 'A', email: 'a@example.com' }).returning();
  admin = { userId: u!.id, role: 'admin', channel: 'admin' };
  editor = { ...admin, role: 'editor' };
});

afterAll(async () => {
  await pool.end();
  await tdb.stop();
});

describe('manual redirects', () => {
  it.each([
    [{ fromPath: '/a/', to: 'javascript:alert(1)' }],
    [{ fromPath: '/a/', to: '//evil.example' }],
    [{ fromPath: '//a', to: '/b/' }],
    [{ fromPath: '/a/?x=1', to: '/b/' }],
    [{ fromPath: '/a/', to: '/b/', code: 410 }],
    [{ fromPath: '/a/', code: 301 }],
    [{ fromPath: '/a/', to: '/b/', code: 307 }],
  ])('rejects %o', (input) => {
    expect(RedirectInput.safeParse(input).success).toBe(false);
  });

  it('are admin-only, unique and matched decoded, with or without the slash', async () => {
    const input = RedirectInput.parse({ fromPath: '/%C3%A7ay', to: 'https://example.org/tea' });
    expect(input.fromPath).toBe('/çay');
    await expect(inSite((tx) => createRedirect(tx, siteId, editor, input))).rejects.toBeInstanceOf(
      Forbidden,
    );
    await inSite((tx) => createRedirect(tx, siteId, admin, input));
    await expect(inSite((tx) => createRedirect(tx, siteId, admin, input))).rejects.toBeInstanceOf(
      Conflict,
    );
    const hit = await inSite((tx) => hitRedirect(tx, siteId, '/%C3%A7ay/'));
    expect(hit).toMatchObject({ to: 'https://example.org/tea', code: 301, hits: 1 });
    expect(await inSite((tx) => hitRedirect(tx, siteId, '/%E0%A4%A'))).toBeUndefined();
  });
});

describe('automatic redirects', () => {
  it('follow slug changes of published posts without chains or loops', async () => {
    const post = await live({ title: 'Eski' });
    await rename(post.id, { slug: 'yeni' });
    expect(await table()).toContain('/eski/ -> /yeni/');
    await rename(post.id, { slug: 'en-yeni' });
    expect(await table()).toEqual(
      expect.arrayContaining(['/eski/ -> /en-yeni/', '/yeni/ -> /en-yeni/']),
    );
    // Back to an old slug: that URL serves the post again.
    await rename(post.id, { slug: 'eski' });
    const rows = await table();
    expect(rows.filter((r) => r.startsWith('/eski/'))).toEqual([]);
    expect(rows).toEqual(expect.arrayContaining(['/yeni/ -> /eski/', '/en-yeni/ -> /eski/']));
  });

  it('cover subpages when a page moves', async () => {
    const parent = await live({ type: 'page', title: 'Kurumsal' });
    const child = await live({ type: 'page', title: 'Ekip', parentId: parent.id });
    await rename(parent.id, { slug: 'hakkimizda' });
    expect(await table()).toEqual(
      expect.arrayContaining([
        '/kurumsal/ -> /hakkimizda/',
        '/kurumsal/ekip/ -> /hakkimizda/ekip/',
      ]),
    );
    await rename(child.id, { parentId: null });
    expect(await table()).toContain('/hakkimizda/ekip/ -> /ekip/');
  });

  it('ignore drafts', async () => {
    const draft = await inSite((tx) =>
      createPost(tx, siteId, editor, PostCreateInput.parse({ type: 'post', title: 'Taslak' })),
    );
    const before = await table();
    await rename(draft.id, { slug: 'taslak-2' });
    expect(await table()).toEqual(before);
  });
});
