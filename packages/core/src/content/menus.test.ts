import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations, withSite, type Db } from '../db/client.js';
import { auditLog, sites, users } from '../db/schema.js';
import { Forbidden, ValidationFailed } from '../errors.js';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import type { Actor } from './audit.js';
import { getMenu, MenuUpdateInput, updateMenu } from './menus.js';
import { createPost, PostCreateInput } from './posts.js';

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let siteA: string;
let siteB: string;
let editor: Actor;
let author: Actor;

const save = (actor: Actor, items: unknown, siteId = siteA) =>
  withSite(db, siteId, (tx) =>
    updateMenu(tx, siteId, actor, 'primary', MenuUpdateInput.parse({ items })),
  );

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
  const [u] = await db.insert(users).values({ name: 'E', email: 'e@example.com' }).returning();
  editor = { userId: u!.id, role: 'editor', channel: 'admin' };
  author = { ...editor, role: 'author' };
});

afterAll(async () => {
  await pool.end();
  await tdb.stop();
});

describe('menus', () => {
  it('saves a tree with ids and reads it back', async () => {
    const menu = await save(editor, [
      { label: 'Home', kind: 'url', url: '/' },
      {
        label: 'More',
        kind: 'url',
        url: '#',
        children: [{ label: 'Mail', kind: 'url', url: 'mailto:a@b.co' }],
      },
    ]);
    expect(menu.items[1]!.children[0]).toMatchObject({
      label: 'Mail',
      url: 'mailto:a@b.co',
      children: [],
    });
    expect(menu.items[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await withSite(db, siteA, (tx) => getMenu(tx, siteA, 'primary'))).toEqual(menu);
    expect(await withSite(db, siteA, (tx) => getMenu(tx, siteA, 'footer'))).toEqual({
      location: 'footer',
      items: [],
    });
    const logged = await withSite(db, siteA, (tx) => tx.select().from(auditLog));
    expect(logged.map((l) => l.action)).toContain('menu.update');
  });

  it.each([
    ['a javascript: URL', [{ label: 'x', kind: 'url', url: 'javascript:alert(1)' }]],
    ['a data: URL', [{ label: 'x', kind: 'url', url: 'data:text/html,hi' }]],
    ['a protocol-relative URL', [{ label: 'x', kind: 'url', url: '//evil.example' }]],
    ['a post item without ref', [{ label: 'x', kind: 'post' }]],
    [
      'four levels',
      [
        {
          label: '1',
          kind: 'url',
          url: '/',
          children: [
            {
              label: '2',
              kind: 'url',
              url: '/',
              children: [
                {
                  label: '3',
                  kind: 'url',
                  url: '/',
                  children: [{ label: '4', kind: 'url', url: '/' }],
                },
              ],
            },
          ],
        },
      ],
    ],
    ['too many items', Array.from({ length: 201 }, () => ({ label: 'x', kind: 'url', url: '/' }))],
  ])('rejects %s', (_name, items) => {
    expect(MenuUpdateInput.safeParse({ items }).success).toBe(false);
  });

  it('only lets editors change menus', async () => {
    await expect(save(author, [])).rejects.toBeInstanceOf(Forbidden);
  });

  it('rejects references to unknown or other sites’ content', async () => {
    const theirs = await withSite(db, siteB, (tx) =>
      createPost(tx, siteB, editor, PostCreateInput.parse({ type: 'page', title: 'B page' })),
    );
    await expect(
      save(editor, [{ label: 'x', kind: 'post', ref: theirs.id }]),
    ).rejects.toBeInstanceOf(ValidationFailed);
  });
});
