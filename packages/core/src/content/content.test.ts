import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations, withSite, type Db, type Tx } from '../db/client.js';
import { auditLog, sites, users, type Role } from '../db/schema.js';
import { Conflict, Forbidden, NotFound, ValidationFailed } from '../errors.js';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import type { Actor } from './audit.js';
import { DocInput, MarkdownInput } from './input.js';
import {
  createPost,
  getPost,
  listPosts,
  listRevisions,
  PostCreateInput,
  PostListQuery,
  publishPost,
  restoreRevision,
  trashPost,
  unpublishPost,
  updatePost,
} from './posts.js';
import { slugify } from './slug.js';
import { createTerm, listTerms, termFields, updateTerm, updateTermFields } from './terms.js';

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let siteA: string;
let siteB: string;
const actors = {} as Record<Role | 'author2', Actor>;

const doc = (text: string) =>
  DocInput.parse({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
const inA = <T>(fn: (tx: Tx) => Promise<T>) => withSite(db, siteA, fn);
const post = (actor: Actor, input: Record<string, unknown>) =>
  inA((tx) => createPost(tx, siteA, actor, PostCreateInput.parse({ type: 'post', ...input })));

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
  for (const role of ['owner', 'admin', 'editor', 'author', 'author2'] as const) {
    const [user] = await db
      .insert(users)
      .values({ name: role, email: `${role}@example.com` })
      .returning();
    actors[role] = {
      userId: user!.id,
      role: role === 'author2' ? 'author' : role,
      channel: 'admin',
    };
  }
});

afterAll(async () => {
  await pool.end();
  await tdb.stop();
});

describe('slugify', () => {
  it.each([
    ['Merhaba Dünya', 'merhaba-dunya'],
    ['Işık, Şiir ve Ağaç', 'isik-siir-ve-agac'],
    ['İstanbul’da Çay', 'istanbul-da-cay'],
    ['  --  ', 'untitled'],
  ])('%s → %s', (input, expected) => expect(slugify(input)).toBe(expected));
});

describe('content input', () => {
  it('rejects documents outside the allowlist with paths', () => {
    const result = DocInput.safeParse({ type: 'doc', content: [{ type: 'script' }] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['content', 0, 'type']);
  });

  it('converts Markdown', () => {
    expect(MarkdownInput.parse('# Hi').content[0]).toMatchObject({ type: 'heading' });
  });
});

describe('posts', () => {
  it('creates a draft with a unique slug, rendered HTML, a revision and an audit row', async () => {
    const first = await post(actors.author, { title: 'Merhaba Dünya', content: doc('<b>hi</b>') });
    const second = await post(actors.author, { title: 'Merhaba Dünya' });
    expect(first).toMatchObject({
      status: 'draft',
      slug: 'merhaba-dunya',
      authorId: actors.author.userId,
      contentHtml: '<p>&lt;b&gt;hi&lt;/b&gt;</p>',
      commentsOpen: true,
    });
    expect(second.slug).toBe('merhaba-dunya-2');
    const revisions = await inA((tx) => listRevisions(tx, siteA, first.id));
    expect(revisions).toMatchObject([{ source: 'admin', snapshot: { title: 'Merhaba Dünya' } }]);
    const audits = await inA((tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityId, first.id)),
    );
    expect(audits).toMatchObject([{ action: 'post.create', channel: 'admin', siteId: siteA }]);
  });

  it('refuses an explicit slug that is taken', async () => {
    await post(actors.editor, { title: 'One', slug: 'taken' });
    await expect(post(actors.editor, { title: 'Two', slug: 'taken' })).rejects.toBeInstanceOf(
      Conflict,
    );
  });

  it('links to other posts by their current URL', async () => {
    const parent = await post(actors.editor, { type: 'page', title: 'About' });
    const child = await post(actors.editor, { type: 'page', title: 'Team', parentId: parent.id });
    const link = await post(actors.editor, {
      title: 'Linking',
      content: DocInput.parse({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'team',
                marks: [{ type: 'link', attrs: { href: `post:${child.id}` } }],
              },
            ],
          },
        ],
      }),
    });
    expect(link.contentHtml).toContain('href="/about/team/"');
  });

  it('keeps page parents within pages and free of cycles', async () => {
    const a = await post(actors.editor, { type: 'page', title: 'A' });
    const b = await post(actors.editor, { type: 'page', title: 'B', parentId: a.id });
    await expect(post(actors.editor, { title: 'Post', parentId: a.id })).rejects.toBeInstanceOf(
      ValidationFailed,
    );
    await expect(
      inA((tx) => updatePost(tx, siteA, actors.editor, a.id, { parentId: b.id })),
    ).rejects.toThrow(/own ancestor/);
  });

  it('assigns terms with a primary category, only from this site', async () => {
    const news = await inA((tx) =>
      createTerm(tx, siteA, actors.editor, { taxonomy: 'category', name: 'News' }),
    );
    const tag = await inA((tx) =>
      createTerm(tx, siteA, actors.editor, { taxonomy: 'tag', name: 'Go' }),
    );
    const created = await post(actors.author, { title: 'Termed', termIds: [tag.id, news.id] });
    expect(created).toMatchObject({ primaryCategoryId: news.id });
    expect(created.termIds.sort()).toEqual([news.id, tag.id].sort());

    const foreign = await withSite(db, siteB, (tx) =>
      createTerm(tx, siteB, { ...actors.editor }, { taxonomy: 'tag', name: 'Theirs' }),
    );
    await expect(post(actors.author, { title: 'X', termIds: [foreign.id] })).rejects.toBeInstanceOf(
      ValidationFailed,
    );
    await expect(
      post(actors.author, { title: 'X', termIds: [tag.id], primaryCategoryId: tag.id }),
    ).rejects.toBeInstanceOf(ValidationFailed);
  });

  it('does not reach posts of another site', async () => {
    const mine = await post(actors.editor, { title: 'Mine' });
    await expect(withSite(db, siteB, (tx) => getPost(tx, siteB, mine.id))).rejects.toBeInstanceOf(
      NotFound,
    );
    await expect(
      withSite(db, siteB, (tx) => updatePost(tx, siteB, actors.editor, mine.id, { title: 'x' })),
    ).rejects.toBeInstanceOf(NotFound);
  });

  describe('permissions', () => {
    it('lets authors edit only their own drafts', async () => {
      const own = await post(actors.author, { title: 'Own' });
      const edited = await inA((tx) =>
        updatePost(tx, siteA, actors.author, own.id, { title: 'Own 2' }),
      );
      expect(edited.title).toBe('Own 2');
      await expect(
        inA((tx) => updatePost(tx, siteA, actors.author2, own.id, { title: 'x' })),
      ).rejects.toBeInstanceOf(Forbidden);
      await expect(
        inA((tx) => publishPost(tx, siteA, actors.author, own.id)),
      ).rejects.toBeInstanceOf(Forbidden);
      await inA((tx) => publishPost(tx, siteA, actors.editor, own.id));
      await expect(
        inA((tx) => updatePost(tx, siteA, actors.author, own.id, { title: 'x' })),
      ).rejects.toThrow(/editor/);
      await expect(inA((tx) => trashPost(tx, siteA, actors.author, own.id))).rejects.toBeInstanceOf(
        Forbidden,
      );
    });

    it('does not let authors manage terms', async () => {
      await expect(
        inA((tx) => createTerm(tx, siteA, actors.author, { taxonomy: 'tag', name: 'Nope' })),
      ).rejects.toBeInstanceOf(Forbidden);
    });
  });

  describe('publishing', () => {
    it('publishes, schedules, unpublishes and trashes', async () => {
      const p = await post(actors.editor, { title: 'Lifecycle' });
      const published = await inA((tx) => publishPost(tx, siteA, actors.editor, p.id));
      expect(published.status).toBe('published');
      expect(published.publishedAt).toBeInstanceOf(Date);

      const future = new Date(Date.now() + 86_400_000);
      const scheduled = await inA((tx) => publishPost(tx, siteA, actors.editor, p.id, future));
      expect(scheduled).toMatchObject({ status: 'scheduled', publishedAt: future });

      expect((await inA((tx) => unpublishPost(tx, siteA, actors.editor, p.id))).status).toBe(
        'draft',
      );
      const trashed = await inA((tx) => trashPost(tx, siteA, actors.editor, p.id));
      expect(trashed.status).toBe('trash');
      expect(trashed.trashedAt).toBeInstanceOf(Date);
      await expect(inA((tx) => publishPost(tx, siteA, actors.editor, p.id))).rejects.toBeInstanceOf(
        Conflict,
      );
    });

    it('does not change the publish state on update', async () => {
      const p = await post(actors.editor, { title: 'Stays' });
      await inA((tx) => publishPost(tx, siteA, actors.editor, p.id));
      const updated = await inA((tx) =>
        updatePost(tx, siteA, actors.editor, p.id, { title: 'Still' }),
      );
      expect(updated.status).toBe('published');
    });
  });

  it('restores a revision as a new revision', async () => {
    const p = await post(actors.editor, { title: 'v1', content: doc('one') });
    await inA((tx) =>
      updatePost(tx, siteA, actors.editor, p.id, { title: 'v2', content: doc('two') }),
    );
    const [, first] = await inA((tx) => listRevisions(tx, siteA, p.id));
    const restored = await inA((tx) => restoreRevision(tx, siteA, actors.editor, first!.id));
    expect(restored).toMatchObject({ title: 'v1', contentHtml: '<p>one</p>' });
    expect(await inA((tx) => listRevisions(tx, siteA, p.id))).toHaveLength(3);
  });

  it('lists with filters and a cursor', async () => {
    const tag = await inA((tx) =>
      createTerm(tx, siteA, actors.editor, { taxonomy: 'tag', name: 'Paged' }),
    );
    for (const n of [1, 2, 3])
      await post(actors.editor, { title: `Paged ${n}`, termIds: [tag.id] });
    const page1 = await inA((tx) =>
      listPosts(tx, siteA, PostListQuery.parse({ termId: tag.id, limit: 2 })),
    );
    expect(page1.items.map((p) => p.title)).toEqual(['Paged 3', 'Paged 2']);
    const page2 = await inA((tx) =>
      listPosts(
        tx,
        siteA,
        PostListQuery.parse({ termId: tag.id, limit: 2, cursor: page1.nextCursor }),
      ),
    );
    expect(page2).toMatchObject({ items: [{ title: 'Paged 1' }], nextCursor: null });
    const searched = await inA((tx) =>
      listPosts(tx, siteA, PostListQuery.parse({ query: 'paged 2' })),
    );
    expect(searched.items.map((p) => p.title)).toEqual(['Paged 2']);
    await expect(
      inA((tx) => listPosts(tx, siteA, PostListQuery.parse({ cursor: 'garbage' }))),
    ).rejects.toBeInstanceOf(ValidationFailed);
  });
});

describe('terms', () => {
  it('nests categories and rewrites paths when a parent moves or is renamed', async () => {
    const t = (input: Parameters<typeof createTerm>[3]) =>
      inA((tx) => createTerm(tx, siteA, actors.editor, input));
    const games = await t({ taxonomy: 'category', name: 'Oyunlar' });
    const pc = await t({ taxonomy: 'category', name: 'PC', parentId: games.id });
    const rpg = await t({ taxonomy: 'category', name: 'RPG', parentId: pc.id });
    expect(rpg.path).toBe('oyunlar/pc/rpg');

    await inA((tx) => updateTerm(tx, siteA, actors.editor, games.id, { slug: 'games' }));
    const all = await inA((tx) => listTerms(tx, siteA, { taxonomy: 'category' }));
    expect(all.filter((x) => x.path.startsWith('games')).map((x) => x.path)).toEqual([
      'games',
      'games/pc',
      'games/pc/rpg',
    ]);

    await expect(
      inA((tx) => updateTerm(tx, siteA, actors.editor, games.id, { parentId: rpg.id })),
    ).rejects.toThrow(/inside itself/);
    await expect(
      t({ taxonomy: 'tag', name: 'Child tag', parentId: games.id }),
    ).rejects.toBeInstanceOf(ValidationFailed);
    await expect(
      t({ taxonomy: 'category', name: 'PC', parentId: games.id }),
    ).rejects.toBeInstanceOf(Conflict);
  });

  it('validates meta against the taxonomy field schema', async () => {
    const t = (input: Parameters<typeof createTerm>[3]) =>
      inA((tx) => createTerm(tx, siteA, actors.editor, input));
    // No schema yet: no meta.
    await expect(t({ taxonomy: 'tag', name: 'X', meta: { a: 1 } })).rejects.toBeInstanceOf(
      ValidationFailed,
    );
    await expect(
      inA((tx) =>
        updateTermFields(tx, siteA, actors.author, 'tag', [
          { key: 'a', label: 'A', type: 'number' },
        ]),
      ),
    ).rejects.toBeInstanceOf(Forbidden);
    await inA((tx) =>
      updateTermFields(tx, siteA, actors.editor, 'tag', [
        { key: 'a', label: 'A', type: 'number' },
        { key: 'img', label: 'Img', type: 'image' },
      ]),
    );
    const tag = await t({ taxonomy: 'tag', name: 'Y', meta: { a: 1 } });
    expect(tag.meta).toEqual({ a: 1 });
    const error = await inA((tx) =>
      updateTerm(tx, siteA, actors.editor, tag.id, {
        meta: { a: 'x', img: '00000000-0000-4000-8000-000000000000' },
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationFailed);
    expect((error as ValidationFailed).issues[0]!.path).toEqual(['meta', 'a']);
    // Images must exist in this site.
    await expect(
      inA((tx) =>
        updateTerm(tx, siteA, actors.editor, tag.id, {
          meta: { img: '00000000-0000-4000-8000-000000000000' },
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationFailed);
    // Other sites have their own schemas.
    expect(await withSite(db, siteB, (tx) => termFields(tx, siteB, 'tag'))).toEqual([]);
  });
});
