import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import { createDb, runMigrations, withSite, type Db } from './client.js';
import { auditLog, posts, postTerms, revisions, sites, terms, users } from './schema.js';

// Tables with site_id that are deliberately instance-level (no RLS).
const INSTANCE_TABLES = ['site_domains', 'memberships'];

const fails = (cause: RegExp) => ({ cause: { message: expect.stringMatching(cause) as unknown } });

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let siteA: string;
let siteB: string;
let author: string;
const ids: Record<'a' | 'b', { post: string; term: string }> = {
  a: { post: '', term: '' },
  b: { post: '', term: '' },
};

const doc = { type: 'doc', content: [] };

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
  const [user] = await db
    .insert(users)
    .values({ name: 'Author', email: 'a@example.com' })
    .returning();
  author = user!.id;

  for (const [key, siteId] of [
    ['a', siteA],
    ['b', siteB],
  ] as const) {
    await withSite(db, siteId, async (tx) => {
      const [post] = await tx
        .insert(posts)
        .values({ siteId, type: 'post', slug: 'hello', title: key, content: doc, authorId: author })
        .returning();
      const [term] = await tx
        .insert(terms)
        .values({ siteId, taxonomy: 'category', slug: 'news', name: 'News', path: 'news' })
        .returning();
      await tx.insert(postTerms).values({ siteId, postId: post!.id, termId: term!.id });
      await tx.insert(revisions).values({
        siteId,
        postId: post!.id,
        source: 'admin',
        snapshot: { title: key, excerpt: '', content: doc, sections: null, seo: {} },
      });
      await tx.insert(auditLog).values({
        siteId,
        channel: 'admin',
        action: 'post.create',
        entityType: 'post',
        entityId: post!.id,
      });
      ids[key] = { post: post!.id, term: term!.id };
    });
  }
});

afterAll(async () => {
  await pool.end();
  await tdb.stop();
});

describe('row-level security', () => {
  it('is enabled with the tenant policy on every tenant table', async () => {
    const { rows } = await db.execute<{ table: string; rls: boolean; policies: string }>(sql`
      select c.relname as table, c.relrowsecurity as rls,
             (select count(*) from pg_policies p where p.tablename = c.relname) as policies
      from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'site_id'
      where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace
      order by 1`);
    const tenant = rows.filter((r) => !INSTANCE_TABLES.includes(r.table));
    expect(tenant.map((r) => r.table)).toEqual([
      'audit_log',
      'media',
      'menus',
      'post_terms',
      'posts',
      'revisions',
      'terms',
      'theme_versions',
      'themes',
    ]);
    for (const row of tenant) expect(row, row.table).toMatchObject({ rls: true });
    for (const row of tenant) expect(Number(row.policies), row.table).toBeGreaterThan(0);
  });

  it.each([
    ['posts', posts],
    ['terms', terms],
    ['post_terms', postTerms],
    ['revisions', revisions],
    ['audit_log', auditLog],
  ] as const)('%s: each site reads only its own rows', async (_name, table) => {
    const count = (siteId: string) =>
      withSite(db, siteId, async (tx) => (await tx.select().from(table)).map((r) => r.siteId));
    expect(await count(siteA)).toEqual([siteA]);
    expect(await count(siteB)).toEqual([siteB]);
    expect(await db.select().from(table)).toEqual([]);
  });

  it('site A cannot write rows for site B', async () => {
    await expect(
      withSite(db, siteA, (tx) =>
        tx.insert(terms).values({
          siteId: siteB,
          taxonomy: 'tag',
          slug: 'x',
          name: 'x',
          path: 'x',
        }),
      ),
    ).rejects.toMatchObject(fails(/row-level security/));
  });

  it("site A cannot change or delete site B's rows", async () => {
    await withSite(db, siteA, async (tx) => {
      const updated = await tx.execute(
        sql`update posts set title = 'pwned' where site_id = ${siteB}`,
      );
      const deleted = await tx.execute(sql`delete from terms where site_id = ${siteB}`);
      expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
    });
  });

  it("site A cannot point at site B's rows", async () => {
    const attempts = [
      sql`insert into posts (site_id, type, slug, title, content, author_id, parent_id)
          values (${siteA}, 'page', 'child', 'x', '{}', ${author}, ${ids.b.post})`,
      sql`insert into post_terms (site_id, post_id, term_id)
          values (${siteA}, ${ids.a.post}, ${ids.b.term})`,
      sql`insert into revisions (site_id, post_id, source, snapshot)
          values (${siteA}, ${ids.b.post}, 'admin', '{}')`,
    ];
    for (const attempt of attempts) {
      await expect(withSite(db, siteA, (tx) => tx.execute(attempt))).rejects.toMatchObject(
        fails(/foreign key/),
      );
    }
  });
});

describe('audit_log', () => {
  it('is append-only for the runtime role', async () => {
    await withSite(db, siteA, async (tx) => {
      await expect(tx.execute(sql`update audit_log set action = 'x'`)).rejects.toMatchObject(
        fails(/permission denied/),
      );
    });
    await withSite(db, siteA, async (tx) => {
      await expect(tx.execute(sql`delete from audit_log`)).rejects.toMatchObject(
        fails(/permission denied/),
      );
    });
  });

  it('accepts instance events but not rows for another site', async () => {
    await db
      .insert(auditLog)
      .values({ channel: 'system', action: 'instance.start', entityType: 'instance' });
    await expect(
      withSite(db, siteA, (tx) =>
        tx
          .insert(auditLog)
          .values({ siteId: siteB, channel: 'admin', action: 'x', entityType: 'x' }),
      ),
    ).rejects.toMatchObject(fails(/row-level security/));
  });
});

describe('content constraints', () => {
  it('keeps slugs unique per site, type and parent, including top level', async () => {
    await expect(
      withSite(db, siteA, (tx) =>
        tx.insert(posts).values({
          siteId: siteA,
          type: 'post',
          slug: 'hello',
          title: 'dup',
          content: doc,
          authorId: author,
        }),
      ),
    ).rejects.toMatchObject(fails(/unique/));
  });

  it('allows one primary category per post', async () => {
    const other = await withSite(db, siteA, async (tx) => {
      await tx.update(postTerms).set({ isPrimary: true });
      const [term] = await tx
        .insert(terms)
        .values({
          siteId: siteA,
          taxonomy: 'category',
          slug: 'other',
          name: 'Other',
          path: 'other',
        })
        .returning();
      return term!.id;
    });
    await expect(
      withSite(db, siteA, (tx) =>
        tx
          .insert(postTerms)
          .values({ siteId: siteA, postId: ids.a.post, termId: other, isPrimary: true }),
      ),
    ).rejects.toMatchObject(fails(/post_terms_one_primary/));
  });
});
