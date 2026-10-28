import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../db/client.js';
import { posts, REDIRECT_SOURCES, redirects } from '../db/schema.js';
import { Conflict, Forbidden, NotFound } from '../errors.js';
import { can } from '../permissions.js';
import { isLive, loadPublicSite, postUrls } from '../public/resolve.js';
import { audit, type Actor } from './audit.js';

const LOCAL = /^\/(?![/\\])[^\s\\?#]*$/;

/** Stored decoded so `/çay/` and `/%C3%A7ay/` are the same redirect. */
const FromPath = z
  .string()
  .max(1000)
  .transform((p, ctx) => {
    try {
      const decoded = decodeURI(p).normalize('NFC');
      if (LOCAL.test(decoded)) return decoded;
    } catch {
      // reported below
    }
    ctx.addIssue({ code: 'custom', message: 'Use a /path without query string' });
    return z.NEVER;
  });

const Target = z
  .string()
  .max(2000)
  .regex(/^(?:https?:\/\/[^\s]+|\/(?![/\\])[^\s\\]*)?$/, 'Use a /path or a full http(s) URL');

export const RedirectInput = z
  .strictObject({
    fromPath: FromPath,
    to: Target.default(''),
    code: z.union([z.literal(301), z.literal(302), z.literal(410)]).default(301),
  })
  .refine((r) => (r.code === 410) === (r.to === ''), {
    message: 'A 410 has no target; 301 and 302 need one',
    path: ['to'],
  });
export type RedirectInput = z.output<typeof RedirectInput>;

export const RedirectListQuery = z.strictObject({
  query: z.string().max(200).optional(),
  source: z.enum(REDIRECT_SOURCES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type RedirectListQuery = z.output<typeof RedirectListQuery>;

export type Redirect = typeof redirects.$inferSelect;

export function assertRedirectManager(actor: Actor) {
  if (!can(actor.role, 'redirect.manage')) throw new Forbidden('Only admins can manage redirects');
}
const assertManage = assertRedirectManager;

export function listRedirects(tx: Tx, siteId: string, q: RedirectListQuery): Promise<Redirect[]> {
  const pattern = q.query && `%${q.query.replace(/[\\%_]/g, '\\$&')}%`;
  return tx
    .select()
    .from(redirects)
    .where(
      and(
        eq(redirects.siteId, siteId),
        q.source ? eq(redirects.source, q.source) : undefined,
        pattern ? or(ilike(redirects.fromPath, pattern), ilike(redirects.to, pattern)) : undefined,
      ),
    )
    .orderBy(asc(redirects.fromPath))
    .limit(q.limit)
    .offset(q.offset);
}

export async function createRedirect(
  tx: Tx,
  siteId: string,
  actor: Actor,
  input: RedirectInput,
): Promise<Redirect> {
  assertManage(actor);
  const [row] = await tx
    .insert(redirects)
    .values({ siteId, ...input })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new Conflict(`A redirect from ${input.fromPath} exists`);
  await audit(tx, siteId, actor, {
    action: 'redirect.create',
    entityType: 'redirect',
    entityId: row.id,
    diff: { ...input },
  });
  return row;
}

export async function updateRedirect(
  tx: Tx,
  siteId: string,
  actor: Actor,
  id: string,
  input: RedirectInput,
): Promise<Redirect> {
  assertManage(actor);
  const [row] = await tx
    .update(redirects)
    .set(input)
    .where(and(eq(redirects.siteId, siteId), eq(redirects.id, id)))
    .returning()
    .catch((e: unknown) => {
      if ((e as { cause?: { code?: string } }).cause?.code === '23505') {
        throw new Conflict(`A redirect from ${input.fromPath} exists`);
      }
      throw e;
    });
  if (!row) throw new NotFound('Redirect not found');
  await audit(tx, siteId, actor, {
    action: 'redirect.update',
    entityType: 'redirect',
    entityId: id,
    diff: { ...input },
  });
  return row;
}

export async function deleteRedirect(
  tx: Tx,
  siteId: string,
  actor: Actor,
  id: string,
): Promise<void> {
  assertManage(actor);
  const [row] = await tx
    .delete(redirects)
    .where(and(eq(redirects.siteId, siteId), eq(redirects.id, id)))
    .returning({ fromPath: redirects.fromPath });
  if (!row) throw new NotFound('Redirect not found');
  await audit(tx, siteId, actor, {
    action: 'redirect.delete',
    entityType: 'redirect',
    entityId: id,
    diff: { fromPath: row.fromPath },
  });
}

/** The redirect for a request path (with or without trailing slash); counts the hit. */
export async function hitRedirect(
  tx: Tx,
  siteId: string,
  path: string,
): Promise<Redirect | undefined> {
  let decoded: string;
  try {
    decoded = decodeURI(path).normalize('NFC');
  } catch {
    return undefined;
  }
  const other = decoded.endsWith('/') ? decoded.slice(0, -1) : `${decoded}/`;
  const [row] = await tx
    .update(redirects)
    .set({ hits: sql`${redirects.hits} + 1`, lastHitAt: new Date() })
    .where(and(eq(redirects.siteId, siteId), inArray(redirects.fromPath, [decoded, other])))
    .returning();
  return row;
}

/**
 * Call before changing a live post or page; the returned function, called after the change,
 * adds 301s from the old URLs (of the page and its subpages) to the new ones.
 */
export async function watchUrls(
  tx: Tx,
  siteId: string,
  postId: string,
): Promise<() => Promise<void>> {
  const site = await loadPublicSite(tx, siteId);
  const { rows } = await tx.execute<{ id: string }>(sql`
    with recursive tree as (
      select id, 1 as depth from posts where site_id = ${siteId} and id = ${postId}
      union all
      select p.id, tree.depth + 1 from posts p join tree on p.parent_id = tree.id
      where p.site_id = ${siteId} and tree.depth < 50
    )
    select id from tree`);
  const ids = rows.map((r) => r.id);
  const load = () =>
    tx
      .select()
      .from(posts)
      .where(and(eq(posts.siteId, siteId), inArray(posts.id, ids), isLive()));
  const before = await postUrls(tx, site, await load());
  if (!before.size) return async () => {};
  return async () => {
    const after = await postUrls(tx, site, await load());
    for (const [id, from] of before) {
      const to = after.get(id);
      if (to && to !== from) await addMoved(tx, siteId, from, to);
    }
  };
}

async function addMoved(tx: Tx, siteId: string, from: string, to: string): Promise<void> {
  // The new URL serves content again, so no redirect may shadow it; and earlier redirects
  // to the old URL now go straight to the new one (no chains).
  await tx.delete(redirects).where(and(eq(redirects.siteId, siteId), eq(redirects.fromPath, to)));
  await tx
    .update(redirects)
    .set({ to })
    .where(and(eq(redirects.siteId, siteId), eq(redirects.to, from)));
  await tx
    .insert(redirects)
    .values({ siteId, fromPath: from, to, code: 301, source: 'slug_change' })
    .onConflictDoUpdate({
      target: [redirects.siteId, redirects.fromPath],
      set: { to, code: 301, source: 'slug_change' },
    });
}
