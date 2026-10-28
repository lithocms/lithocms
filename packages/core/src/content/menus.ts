import { and, asc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Tx } from '../db/client.js';
import { menus, posts, terms, type MenuItem } from '../db/schema.js';
import { Forbidden, ValidationFailed } from '../errors.js';
import { can } from '../permissions.js';
import { audit, type Actor } from './audit.js';

const MAX_DEPTH = 3;
const MAX_ITEMS = 200;

export const MenuLocation = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Expected a lowercase key');

// Links people can follow from a menu; never `javascript:` or `data:`.
const Href = z
  .string()
  .max(2000)
  .regex(
    /^(?:https?:\/\/[^\s]+|\/(?![/\\])[^\s\\]*|#[^\s]*|mailto:[^\s]+|tel:[+\d\s()-]+)$/,
    'Use a full http(s) URL, a /path, #anchor, mailto: or tel:',
  );

type MenuItemInput = {
  id?: string;
  label: string;
  kind: MenuItem['kind'];
  ref?: string;
  url?: string;
  children?: MenuItemInput[];
};

const MenuItemInput: z.ZodType<MenuItemInput> = z.lazy(() =>
  z
    .strictObject({
      id: z.uuid().optional(),
      label: z.string().trim().min(1).max(200),
      kind: z.enum(['post', 'term', 'url']),
      ref: z.uuid().optional(),
      url: Href.optional(),
      children: z.array(MenuItemInput).optional(),
    })
    .refine((i) => (i.kind === 'url' ? i.url !== undefined : i.ref !== undefined), {
      message: 'A post or term item needs `ref`; a url item needs `url`',
    }),
);

export const MenuUpdateInput = z.strictObject({
  items: z.array(MenuItemInput).superRefine((items, ctx) => {
    let count = 0;
    const walk = (list: MenuItemInput[], depth: number) => {
      for (const item of list) {
        count++;
        if (depth > MAX_DEPTH) {
          ctx.addIssue({ code: 'custom', message: `Menus nest at most ${MAX_DEPTH} levels` });
          return;
        }
        walk(item.children ?? [], depth + 1);
      }
    };
    walk(items, 1);
    if (count > MAX_ITEMS) {
      ctx.addIssue({ code: 'custom', message: `A menu has at most ${MAX_ITEMS} items` });
    }
  }),
});
export type MenuUpdateInput = z.output<typeof MenuUpdateInput>;

export interface Menu {
  location: string;
  items: MenuItem[];
}

export async function listMenus(tx: Tx, siteId: string): Promise<Menu[]> {
  return tx
    .select({ location: menus.location, items: menus.items })
    .from(menus)
    .where(eq(menus.siteId, siteId))
    .orderBy(asc(menus.location));
}

/** A location without a saved menu is an empty menu. */
export async function getMenu(tx: Tx, siteId: string, location: string): Promise<Menu> {
  const [row] = await tx
    .select({ location: menus.location, items: menus.items })
    .from(menus)
    .where(and(eq(menus.siteId, siteId), eq(menus.location, location)));
  return row ?? { location, items: [] };
}

export async function updateMenu(
  tx: Tx,
  siteId: string,
  actor: Actor,
  location: string,
  input: MenuUpdateInput,
): Promise<Menu> {
  if (!can(actor.role, 'menu.manage')) throw new Forbidden('Only editors can manage menus');
  const items = normalize(input.items);
  await checkRefs(tx, siteId, items);
  const [row] = await tx
    .insert(menus)
    .values({ siteId, location, items })
    .onConflictDoUpdate({
      target: [menus.siteId, menus.location],
      set: { items, updatedAt: new Date() },
    })
    .returning({ id: menus.id, location: menus.location, items: menus.items });
  await audit(tx, siteId, actor, {
    action: 'menu.update',
    entityType: 'menu',
    entityId: row!.id,
    diff: { location, items: flatten(items).length },
  });
  return { location: row!.location, items: row!.items };
}

function normalize(items: MenuItemInput[]): MenuItem[] {
  return items.map((i) => ({
    id: i.id ?? randomUUID(),
    label: i.label,
    kind: i.kind,
    ...(i.kind === 'url' ? { url: i.url } : { ref: i.ref }),
    children: normalize(i.children ?? []),
  }));
}

export function flatten(items: MenuItem[]): MenuItem[] {
  return items.flatMap((i) => [i, ...flatten(i.children)]);
}

/** Referenced posts and terms must exist in this site (they may be unpublished). */
async function checkRefs(tx: Tx, siteId: string, items: MenuItem[]): Promise<void> {
  const all = flatten(items);
  const want = (kind: MenuItem['kind']) => [
    ...new Set(all.filter((i) => i.kind === kind).map((i) => i.ref!)),
  ];
  const [postIds, termIds] = [want('post'), want('term')];
  const [foundPosts, foundTerms] = await Promise.all([
    postIds.length
      ? tx
          .select({ id: posts.id })
          .from(posts)
          .where(and(eq(posts.siteId, siteId), inArray(posts.id, postIds)))
      : [],
    termIds.length
      ? tx
          .select({ id: terms.id })
          .from(terms)
          .where(and(eq(terms.siteId, siteId), inArray(terms.id, termIds)))
      : [],
  ]);
  const missing = [
    ...postIds.filter((id) => !foundPosts.some((p) => p.id === id)),
    ...termIds.filter((id) => !foundTerms.some((t) => t.id === id)),
  ];
  if (missing.length) {
    throw new ValidationFailed(
      missing.map((id) => ({ path: ['items'], message: `Unknown post or term: ${id}` })),
    );
  }
}
