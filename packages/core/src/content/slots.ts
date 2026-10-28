import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../db/client.js';
import { slots } from '../db/schema.js';
import { Forbidden } from '../errors.js';
import { can } from '../permissions.js';
import { audit, type Actor } from './audit.js';

export const SlotKey = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Expected a lowercase key');

export const SlotUpdateInput = z.strictObject({
  html: z.string().max(100_000).optional(),
  enabled: z.boolean().optional(),
});
export type SlotUpdateInput = z.output<typeof SlotUpdateInput>;

export type Slot = typeof slots.$inferSelect;

export function listSlots(tx: Tx, siteId: string): Promise<Slot[]> {
  return tx.select().from(slots).where(eq(slots.siteId, siteId)).orderBy(asc(slots.key));
}

/**
 * Slot HTML is output raw, so only admins may write it (CLAUDE.md security rule 3). The site
 * CSP still applies: scripts load only from `self` and the CSP allowlist.
 */
export async function updateSlot(
  tx: Tx,
  siteId: string,
  actor: Actor,
  key: string,
  input: SlotUpdateInput,
): Promise<Slot> {
  if (!can(actor.role, 'slot.manage')) throw new Forbidden('Only admins can edit slots');
  const [row] = await tx
    .insert(slots)
    .values({ siteId, key, ...input, updatedBy: actor.userId })
    .onConflictDoUpdate({
      target: [slots.siteId, slots.key],
      set: { ...input, updatedBy: actor.userId, updatedAt: new Date() },
    })
    .returning();
  await audit(tx, siteId, actor, {
    action: 'slot.update',
    entityType: 'slot',
    entityId: row!.id,
    // The HTML itself can be large; record its size.
    diff: { key, enabled: row!.enabled, htmlLength: row!.html.length },
  });
  return row!;
}

/** Enabled slots by key, for rendering. */
export async function enabledSlots(tx: Tx, siteId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ key: slots.key, html: slots.html })
    .from(slots)
    .where(and(eq(slots.siteId, siteId), eq(slots.enabled, true)));
  return new Map(rows.map((r) => [r.key, r.html]));
}
