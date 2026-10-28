import { renderHtml, type Doc } from '@lithocms/content-format';
import { and, desc, eq, ilike, inArray, isNull, like, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../db/client.js';
import {
  POST_STATUSES,
  POST_TYPES,
  posts,
  postTerms,
  revisions,
  terms,
  type Channel,
  type RevisionSnapshot,
} from '../db/schema.js';
import { Conflict, Forbidden, NotFound, ValidationFailed } from '../errors.js';
import { can } from '../permissions.js';
import { audit, type Actor } from './audit.js';
import { DocInput } from './input.js';
import { SLUG, slugify } from './slug.js';

const Key = z.string().regex(/^[a-z0-9_-]{1,64}$/);

const Seo = z.strictObject({
  title: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  ogImageId: z.uuid().optional(),
  canonical: z.url({ protocol: /^https?$/ }).optional(),
  noindex: z.boolean().optional(),
});

const Section = z.strictObject({
  type: Key,
  settings: z.record(z.string(), z.unknown()),
  blocks: z
    .array(z.strictObject({ type: Key, settings: z.record(z.string(), z.unknown()) }))
    .max(50),
});

const PostFields = z.strictObject({
  title: z.string().trim().min(1).max(300),
  content: DocInput,
  excerpt: z.string().max(1000),
  slug: z.string().max(100).regex(SLUG, 'Use lowercase letters, digits and dashes'),
  parentId: z.uuid().nullable(),
  termIds: z.array(z.uuid()).max(100),
  primaryCategoryId: z.uuid().nullable(),
  template: z
    .string()
    .regex(/^[a-z0-9._-]{1,64}$/)
    .nullable(),
  sections: z.array(Section).max(100).nullable(),
  seo: Seo,
  commentsOpen: z.boolean(),
});

export const PostCreateInput = PostFields.partial().extend({
  type: z.enum(POST_TYPES),
  title: PostFields.shape.title,
});
export type PostCreateInput = z.output<typeof PostCreateInput>;

export const PostUpdateInput = PostFields.partial();
export type PostUpdateInput = z.output<typeof PostUpdateInput>;

export const PostListQuery = z.strictObject({
  type: z.enum(POST_TYPES).optional(),
  status: z.enum(POST_STATUSES).optional(),
  termId: z.uuid().optional(),
  authorId: z.uuid().optional(),
  query: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});
export type PostListQuery = z.output<typeof PostListQuery>;

export type PostRow = typeof posts.$inferSelect;
export type Post = PostRow & { termIds: string[]; primaryCategoryId: string | null };

const EMPTY_DOC: Doc = { type: 'doc', content: [] };
const KEEP_REVISIONS = 50;
const REVISION_SOURCE: Record<Channel, 'admin' | 'mcp' | 'import'> = {
  admin: 'admin',
  api: 'admin',
  system: 'admin',
  mcp: 'mcp',
  import: 'import',
};

// --- reads ---------------------------------------------------------------------------------

export async function getPost(tx: Tx, siteId: string, id: string): Promise<Post> {
  const [row] = await tx
    .select()
    .from(posts)
    .where(and(eq(posts.siteId, siteId), eq(posts.id, id)));
  if (!row) throw new NotFound('Post not found');
  return withTerms(tx, row);
}

export async function listPosts(
  tx: Tx,
  siteId: string,
  q: PostListQuery,
): Promise<{ items: PostRow[]; nextCursor: string | null }> {
  const where: (SQL | undefined)[] = [
    eq(posts.siteId, siteId),
    q.type ? eq(posts.type, q.type) : undefined,
    q.status ? eq(posts.status, q.status) : ne(posts.status, 'trash'),
    q.authorId ? eq(posts.authorId, q.authorId) : undefined,
    q.query ? ilike(posts.title, `%${q.query.replace(/[\\%_]/g, '\\$&')}%`) : undefined,
    q.termId
      ? inArray(
          posts.id,
          tx.select({ id: postTerms.postId }).from(postTerms).where(eq(postTerms.termId, q.termId)),
        )
      : undefined,
  ];
  if (q.cursor) {
    const [at, id] = decodeCursor(q.cursor);
    where.push(sql`(${posts.updatedAt}, ${posts.id}) < (${at}, ${id})`);
  }
  const rows = await tx
    .select()
    .from(posts)
    .where(and(...where))
    .orderBy(desc(posts.updatedAt), desc(posts.id))
    .limit(q.limit + 1);
  const items = rows.slice(0, q.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > q.limit && last ? encodeCursor(last) : null,
  };
}

export async function listRevisions(tx: Tx, siteId: string, postId: string, limit = 20) {
  await getPost(tx, siteId, postId);
  return tx
    .select()
    .from(revisions)
    .where(and(eq(revisions.siteId, siteId), eq(revisions.postId, postId)))
    .orderBy(desc(revisions.createdAt), desc(revisions.id))
    .limit(Math.min(limit, 50));
}

// --- writes --------------------------------------------------------------------------------

/** Creates a draft. Publishing is a separate step (`publishPost`). */
export async function createPost(
  tx: Tx,
  siteId: string,
  actor: Actor,
  input: PostCreateInput,
): Promise<Post> {
  if (!can(actor.role, 'post.write_own')) throw new Forbidden('You cannot create posts');
  const parentId = input.parentId ?? null;
  if (parentId) await checkParent(tx, siteId, input.type, parentId);
  const content = input.content ?? EMPTY_DOC;
  const slug = input.slug
    ? await requireFreeSlug(tx, siteId, input.type, parentId, input.slug)
    : await freeSlug(tx, siteId, input.type, parentId, slugify(input.title));

  const [row] = await tx
    .insert(posts)
    .values({
      siteId,
      type: input.type,
      title: input.title,
      slug,
      parentId,
      content,
      contentHtml: await renderContent(tx, content),
      excerpt: input.excerpt ?? '',
      authorId: actor.userId,
      template: input.template ?? null,
      sections: input.sections ?? null,
      seo: input.seo ?? {},
      commentsOpen: input.commentsOpen ?? input.type === 'post',
    })
    .returning();
  const post = row!;
  await setTerms(tx, siteId, post.id, input.termIds ?? [], input.primaryCategoryId ?? null);
  await saveRevision(tx, siteId, actor, post);
  await audit(tx, siteId, actor, {
    action: `${post.type}.create`,
    entityType: post.type,
    entityId: post.id,
    diff: { title: post.title },
  });
  return withTerms(tx, post);
}

/** Changes content and metadata. Never changes the publish state. */
export async function updatePost(
  tx: Tx,
  siteId: string,
  actor: Actor,
  id: string,
  input: PostUpdateInput,
): Promise<Post> {
  const current = await getPost(tx, siteId, id);
  assertCanEdit(actor, current);

  const parentId = input.parentId === undefined ? current.parentId : input.parentId;
  if (input.parentId) await checkParent(tx, siteId, current.type, input.parentId, id);
  let slug = current.slug;
  if (input.slug !== undefined || parentId !== current.parentId) {
    slug = await requireFreeSlug(
      tx,
      siteId,
      current.type,
      parentId,
      input.slug ?? current.slug,
      id,
    );
  }

  const changes: Partial<typeof posts.$inferInsert> = {
    ...pick(input, ['title', 'excerpt', 'template', 'sections', 'seo', 'commentsOpen']),
    slug,
    parentId,
  };
  if (input.content) {
    changes.content = input.content;
    changes.contentHtml = await renderContent(tx, input.content);
  }
  const [row] = await tx
    .update(posts)
    .set({ ...changes, updatedAt: new Date() })
    .where(and(eq(posts.siteId, siteId), eq(posts.id, id)))
    .returning();
  if (input.termIds || input.primaryCategoryId !== undefined) {
    await setTerms(
      tx,
      siteId,
      id,
      input.termIds ?? current.termIds,
      input.primaryCategoryId === undefined ? current.primaryCategoryId : input.primaryCategoryId,
    );
  }
  await saveRevision(tx, siteId, actor, row!);
  await audit(tx, siteId, actor, {
    action: `${current.type}.update`,
    entityType: current.type,
    entityId: id,
    diff: { changed: Object.keys(input).sort() },
  });
  return withTerms(tx, row!);
}

/** Publishes now, at a past date, or schedules for a future `at`. */
export async function publishPost(
  tx: Tx,
  siteId: string,
  actor: Actor,
  id: string,
  at?: Date,
): Promise<Post> {
  if (!can(actor.role, 'post.publish')) throw new Forbidden('Only editors can publish');
  const current = await getPost(tx, siteId, id);
  if (current.status === 'trash') throw new Conflict('Restore the post from the trash first');
  const now = new Date();
  const publishedAt = at ?? (current.status === 'published' ? current.publishedAt : null) ?? now;
  const status = publishedAt > now ? 'scheduled' : 'published';
  return setStatus(tx, siteId, actor, current, { status, publishedAt }, 'publish');
}

export async function unpublishPost(tx: Tx, siteId: string, actor: Actor, id: string) {
  if (!can(actor.role, 'post.publish')) throw new Forbidden('Only editors can unpublish');
  const current = await getPost(tx, siteId, id);
  return setStatus(tx, siteId, actor, current, { status: 'draft' }, 'unpublish');
}

/** Soft delete. Nothing is hard-deleted through the API or MCP. */
export async function trashPost(tx: Tx, siteId: string, actor: Actor, id: string) {
  const current = await getPost(tx, siteId, id);
  assertCanEdit(actor, current);
  return setStatus(tx, siteId, actor, current, { status: 'trash', trashedAt: new Date() }, 'trash');
}

/** Brings a revision's content back as the current version (recorded as a new revision). */
export async function restoreRevision(
  tx: Tx,
  siteId: string,
  actor: Actor,
  revisionId: string,
): Promise<Post> {
  const [revision] = await tx
    .select()
    .from(revisions)
    .where(and(eq(revisions.siteId, siteId), eq(revisions.id, revisionId)));
  if (!revision) throw new NotFound('Revision not found');
  const { title, excerpt, content, sections, seo } = revision.snapshot;
  return updatePost(tx, siteId, actor, revision.postId, {
    title,
    excerpt,
    content: DocInput.parse(content),
    sections,
    seo,
  });
}

// --- helpers -------------------------------------------------------------------------------

function assertCanEdit(actor: Actor, post: PostRow): void {
  if (post.authorId !== actor.userId && !can(actor.role, 'post.write_any')) {
    throw new Forbidden('You can only edit your own posts');
  }
  if (
    (post.status === 'published' || post.status === 'scheduled') &&
    !can(actor.role, 'post.publish')
  ) {
    throw new Forbidden('Published posts can only be changed by an editor');
  }
}

async function setStatus(
  tx: Tx,
  siteId: string,
  actor: Actor,
  current: Post,
  changes: Partial<Pick<PostRow, 'status' | 'publishedAt' | 'trashedAt'>>,
  verb: string,
): Promise<Post> {
  const [row] = await tx
    .update(posts)
    .set({ trashedAt: null, ...changes, updatedAt: new Date() })
    .where(and(eq(posts.siteId, siteId), eq(posts.id, current.id)))
    .returning();
  await audit(tx, siteId, actor, {
    action: `${current.type}.${verb}`,
    entityType: current.type,
    entityId: current.id,
    diff: { status: [current.status, row!.status], publishedAt: row!.publishedAt },
  });
  return { ...row!, termIds: current.termIds, primaryCategoryId: current.primaryCategoryId };
}

async function withTerms(tx: Tx, row: PostRow): Promise<Post> {
  const rows = await tx
    .select({ termId: postTerms.termId, isPrimary: postTerms.isPrimary })
    .from(postTerms)
    .where(eq(postTerms.postId, row.id))
    .orderBy(postTerms.termId);
  return {
    ...row,
    termIds: rows.map((r) => r.termId),
    primaryCategoryId: rows.find((r) => r.isPrimary)?.termId ?? null,
  };
}

async function setTerms(
  tx: Tx,
  siteId: string,
  postId: string,
  termIds: string[],
  primaryCategoryId: string | null,
): Promise<void> {
  const ids = [...new Set(termIds)];
  const found = ids.length
    ? await tx
        .select({ id: terms.id, taxonomy: terms.taxonomy })
        .from(terms)
        .where(and(eq(terms.siteId, siteId), inArray(terms.id, ids)))
    : [];
  if (found.length !== ids.length) {
    throw new ValidationFailed([{ path: ['termIds'], message: 'Unknown term' }]);
  }
  const categories = found.filter((t) => t.taxonomy === 'category').map((t) => t.id);
  if (primaryCategoryId && !categories.includes(primaryCategoryId)) {
    throw new ValidationFailed([
      { path: ['primaryCategoryId'], message: 'Must be one of the post’s categories' },
    ]);
  }
  const primary = primaryCategoryId ?? ids.find((id) => categories.includes(id)) ?? null;
  await tx.delete(postTerms).where(eq(postTerms.postId, postId));
  if (ids.length) {
    await tx
      .insert(postTerms)
      .values(ids.map((termId) => ({ siteId, postId, termId, isPrimary: termId === primary })));
  }
}

async function saveRevision(tx: Tx, siteId: string, actor: Actor, post: PostRow): Promise<void> {
  const snapshot: RevisionSnapshot = {
    title: post.title,
    excerpt: post.excerpt,
    content: post.content,
    sections: post.sections,
    seo: post.seo,
  };
  await tx.insert(revisions).values({
    siteId,
    postId: post.id,
    snapshot,
    createdBy: actor.userId,
    source: REVISION_SOURCE[actor.channel],
  });
  await tx.execute(sql`
    delete from revisions where post_id = ${post.id} and id not in (
      select id from revisions where post_id = ${post.id}
      order by created_at desc, id desc limit ${KEEP_REVISIONS})`);
}

async function checkParent(
  tx: Tx,
  siteId: string,
  type: PostRow['type'],
  parentId: string,
  selfId?: string,
): Promise<void> {
  const fail = (message: string) => new ValidationFailed([{ path: ['parentId'], message }]);
  if (type !== 'page') throw fail('Only pages can have a parent');
  // Walk up from the new parent: it must exist, be a page, and not be this page or below it.
  const { rows } = await tx.execute<{ id: string; type: string }>(sql`
    with recursive up as (
      select id, type, parent_id, 1 as depth from posts where site_id = ${siteId} and id = ${parentId}
      union all
      select p.id, p.type, p.parent_id, up.depth + 1 from posts p join up on p.id = up.parent_id
      where up.depth < 50
    ) select id, type from up`);
  if (!rows[0] || rows[0].type !== 'page') throw fail('Parent page not found');
  if (selfId && rows.some((r) => r.id === selfId)) throw fail('A page cannot be its own ancestor');
}

async function slugsLike(
  tx: Tx,
  siteId: string,
  type: PostRow['type'],
  parentId: string | null,
  base: string,
  excludeId?: string,
): Promise<Set<string>> {
  const rows = await tx
    .select({ slug: posts.slug })
    .from(posts)
    .where(
      and(
        eq(posts.siteId, siteId),
        eq(posts.type, type),
        parentId ? eq(posts.parentId, parentId) : isNull(posts.parentId),
        or(eq(posts.slug, base), like(posts.slug, `${base}-%`)),
        excludeId ? ne(posts.id, excludeId) : undefined,
      ),
    );
  return new Set(rows.map((r) => r.slug));
}

async function freeSlug(...args: Parameters<typeof slugsLike>): Promise<string> {
  const base = args[4];
  const taken = await slugsLike(...args);
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

async function requireFreeSlug(...args: Parameters<typeof slugsLike>): Promise<string> {
  const slug = args[4];
  if ((await slugsLike(...args)).has(slug)) throw new Conflict(`The slug "${slug}" is taken`);
  return slug;
}

/**
 * Sanitized HTML for `content_html`. Links to other posts (`post:<id>`) use the default
 * WordPress-style URLs.
 * TODO(phase-1): site permalink settings, media lookups, and re-rendering when a linked
 * post's URL changes.
 */
async function renderContent(tx: Tx, doc: Doc): Promise<string> {
  const ids = [
    ...new Set([...JSON.stringify(doc).matchAll(/"post:([0-9a-f-]{36})"/g)].map((m) => m[1]!)),
  ];
  const urls = new Map<string, string>();
  if (ids.length) {
    const { rows } = await tx.execute<{ id: string; path: string }>(sql`
      with recursive up as (
        select id as start, parent_id, slug, 1 as depth from posts
        where id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
        union all
        select up.start, p.parent_id, p.slug, up.depth + 1
        from posts p join up on p.id = up.parent_id where up.depth < 50
      )
      select start as id, string_agg(slug, '/' order by depth desc) as path
      from up group by start`);
    for (const r of rows) urls.set(r.id, `/${r.path}/`);
  }
  return renderHtml(doc, { media: () => undefined, postUrl: (id) => urls.get(id) });
}

function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Partial<Pick<T, K>> {
  return Object.fromEntries(
    keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]),
  ) as Partial<Pick<T, K>>;
}

function encodeCursor(row: PostRow): string {
  return Buffer.from(`${row.updatedAt.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): [Date, string] {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const date = new Date(at ?? '');
  if (Number.isNaN(date.getTime()) || !z.uuid().safeParse(id).success) {
    throw new ValidationFailed([{ path: ['cursor'], message: 'Invalid cursor' }]);
  }
  return [date, id!];
}
