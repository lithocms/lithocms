import { and, asc, eq, ilike, isNull, like, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../db/client.js';
import { TAXONOMIES, terms } from '../db/schema.js';
import { Conflict, Forbidden, NotFound, ValidationFailed } from '../errors.js';
import { can } from '../permissions.js';
import { audit, type Actor } from './audit.js';
import { SLUG, slugify } from './slug.js';

const TermFields = z.strictObject({
  name: z.string().trim().min(1).max(200),
  slug: z.string().max(100).regex(SLUG, 'Use lowercase letters, digits and dashes'),
  parentId: z.uuid().nullable(),
  description: z.string().max(5000),
  // TODO(phase-1): validate against the site's field schema for `term:<taxonomy>`.
  meta: z.record(z.string(), z.unknown()),
  sort: z.int().min(-10_000).max(10_000),
});

export const TermCreateInput = TermFields.partial().extend({
  taxonomy: z.enum(TAXONOMIES),
  name: TermFields.shape.name,
});
export type TermCreateInput = z.output<typeof TermCreateInput>;

export const TermUpdateInput = TermFields.partial();
export type TermUpdateInput = z.output<typeof TermUpdateInput>;

export const TermListQuery = z.strictObject({
  taxonomy: z.enum(TAXONOMIES),
  parentId: z.uuid().optional(),
  query: z.string().max(200).optional(),
});
export type TermListQuery = z.output<typeof TermListQuery>;

export type Term = typeof terms.$inferSelect;

export async function getTerm(tx: Tx, siteId: string, id: string): Promise<Term> {
  const [row] = await tx
    .select()
    .from(terms)
    .where(and(eq(terms.siteId, siteId), eq(terms.id, id)));
  if (!row) throw new NotFound('Term not found');
  return row;
}

export function listTerms(tx: Tx, siteId: string, q: TermListQuery): Promise<Term[]> {
  const where: (SQL | undefined)[] = [
    eq(terms.siteId, siteId),
    eq(terms.taxonomy, q.taxonomy),
    q.parentId ? eq(terms.parentId, q.parentId) : undefined,
    q.query ? ilike(terms.name, `%${q.query.replace(/[\\%_]/g, '\\$&')}%`) : undefined,
  ];
  return tx
    .select()
    .from(terms)
    .where(and(...where))
    .orderBy(asc(terms.path), asc(terms.sort))
    .limit(1000);
}

export async function createTerm(
  tx: Tx,
  siteId: string,
  actor: Actor,
  input: TermCreateInput,
): Promise<Term> {
  if (!can(actor.role, 'term.manage')) throw new Forbidden('Only editors can manage terms');
  const parent = input.parentId
    ? await getParent(tx, siteId, input.taxonomy, input.parentId)
    : null;
  const slug = input.slug ?? slugify(input.name);
  await assertFreeSlug(tx, siteId, input.taxonomy, parent?.id ?? null, slug);
  const [row] = await tx
    .insert(terms)
    .values({
      siteId,
      taxonomy: input.taxonomy,
      name: input.name,
      slug,
      parentId: parent?.id ?? null,
      path: parent ? `${parent.path}/${slug}` : slug,
      description: input.description ?? '',
      meta: input.meta ?? {},
      sort: input.sort ?? 0,
    })
    .returning();
  await audit(tx, siteId, actor, {
    action: `${input.taxonomy}.create`,
    entityType: input.taxonomy,
    entityId: row!.id,
    diff: { name: row!.name, path: row!.path },
  });
  return row!;
}

/** Updates a term; moving or renaming a category rewrites the paths of everything below it. */
export async function updateTerm(
  tx: Tx,
  siteId: string,
  actor: Actor,
  id: string,
  input: TermUpdateInput,
): Promise<Term> {
  if (!can(actor.role, 'term.manage')) throw new Forbidden('Only editors can manage terms');
  const current = await getTerm(tx, siteId, id);
  const parentId = input.parentId === undefined ? current.parentId : input.parentId;
  const parent = parentId ? await getParent(tx, siteId, current.taxonomy, parentId) : null;
  if (parent && (parent.id === id || parent.path.startsWith(`${current.path}/`))) {
    throw new ValidationFailed([
      { path: ['parentId'], message: 'A category cannot be inside itself' },
    ]);
  }
  const slug = input.slug ?? current.slug;
  if (slug !== current.slug || parentId !== current.parentId) {
    await assertFreeSlug(tx, siteId, current.taxonomy, parentId, slug, id);
  }
  const path = parent ? `${parent.path}/${slug}` : slug;

  const [row] = await tx
    .update(terms)
    .set({
      name: input.name,
      description: input.description,
      meta: input.meta,
      sort: input.sort,
      slug,
      parentId,
      path,
      updatedAt: new Date(),
    })
    .where(and(eq(terms.siteId, siteId), eq(terms.id, id)))
    .returning();
  if (path !== current.path) {
    await tx
      .update(terms)
      .set({ path: sql`${path} || substr(${terms.path}, ${current.path.length + 1})` })
      .where(
        and(
          eq(terms.siteId, siteId),
          eq(terms.taxonomy, current.taxonomy),
          like(terms.path, `${current.path}/%`),
        ),
      );
  }
  await audit(tx, siteId, actor, {
    action: `${current.taxonomy}.update`,
    entityType: current.taxonomy,
    entityId: id,
    diff: { changed: Object.keys(input).sort(), path: [current.path, path] },
  });
  return row!;
}

async function getParent(tx: Tx, siteId: string, taxonomy: Term['taxonomy'], parentId: string) {
  const fail = (message: string) => new ValidationFailed([{ path: ['parentId'], message }]);
  if (taxonomy !== 'category') throw fail('Only categories can have a parent');
  const parent = await getTerm(tx, siteId, parentId).catch(() => undefined);
  if (parent?.taxonomy !== 'category') throw fail('Parent category not found');
  return parent;
}

async function assertFreeSlug(
  tx: Tx,
  siteId: string,
  taxonomy: Term['taxonomy'],
  parentId: string | null,
  slug: string,
  excludeId?: string,
): Promise<void> {
  const [taken] = await tx
    .select({ id: terms.id })
    .from(terms)
    .where(
      and(
        eq(terms.siteId, siteId),
        eq(terms.taxonomy, taxonomy),
        parentId ? eq(terms.parentId, parentId) : isNull(terms.parentId),
        eq(terms.slug, slug),
        excludeId ? ne(terms.id, excludeId) : undefined,
      ),
    );
  if (taken) throw new Conflict(`The slug "${slug}" is taken`);
}
