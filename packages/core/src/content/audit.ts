import type { Tx } from '../db/client.js';
import { auditLog, type Channel, type Role } from '../db/schema.js';
import { purgeCache, purgeTagsFor } from '../public/cache.js';

/** Who is acting, through which channel. Built by the REST/MCP boundary from the session or token. */
export interface Actor {
  userId: string;
  role: Role;
  channel: Channel;
  tokenId?: string;
  ipHash?: string;
}

/** Records a write and purges the cached pages it affects (every write is audited). */
export async function audit(
  tx: Tx,
  siteId: string,
  actor: Actor,
  entry: { action: string; entityType: string; entityId: string; diff?: Record<string, unknown> },
): Promise<void> {
  await tx.insert(auditLog).values({
    siteId,
    actorUserId: actor.userId,
    channel: actor.channel,
    tokenId: actor.tokenId,
    ipHash: actor.ipHash,
    ...entry,
  });
  await purgeCache(tx, siteId, purgeTagsFor(entry));
}
