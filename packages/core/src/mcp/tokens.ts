import { and, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { audit, type Actor } from '../content/audit.js';
import type { Db, Tx } from '../db/client.js';
import { MCP_SCOPES, mcpTokens, type McpScope, type Role } from '../db/schema.js';
import { Forbidden, NotFound } from '../errors.js';
import { can } from '../permissions.js';

// Personal access tokens for MCP clients. A token is bound to one user and one site; what it
// may do is its scopes, cut down at every request to what the user's current role allows.

export const TOKEN_PREFIX = 'litho_pat_';

export const McpTokenInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  scopes: z
    .array(z.enum(MCP_SCOPES))
    .min(1)
    .transform((s) => [...new Set(s)]),
  /** Null or missing: never expires. */
  expiresInDays: z.int().min(1).max(365).nullable().optional(),
});
export type McpTokenInput = z.output<typeof McpTokenInput>;

export type McpToken = Omit<typeof mcpTokens.$inferSelect, 'tokenHash'>;

/** The scopes a role can hold (MCP_SPEC.md): content from author up, design and admin for admins. */
export function scopesFor(role: Role): McpScope[] {
  return can(role, 'settings.manage') ? [...MCP_SCOPES] : ['content'];
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

const columns = {
  id: mcpTokens.id,
  userId: mcpTokens.userId,
  siteId: mcpTokens.siteId,
  name: mcpTokens.name,
  scopes: mcpTokens.scopes,
  lastUsedAt: mcpTokens.lastUsedAt,
  expiresAt: mcpTokens.expiresAt,
  revokedAt: mcpTokens.revokedAt,
  createdAt: mcpTokens.createdAt,
};

/** Creates a token for the acting user on this site; the returned `token` is shown once. */
export async function createMcpToken(
  tx: Tx,
  siteId: string,
  actor: Actor,
  input: McpTokenInput,
): Promise<{ token: string; record: McpToken }> {
  const allowed = scopesFor(actor.role);
  const extra = input.scopes.filter((s) => !allowed.includes(s));
  if (extra.length) throw new Forbidden(`Your role cannot grant: ${extra.join(', ')}`);
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const [record] = await tx
    .insert(mcpTokens)
    .values({
      userId: actor.userId,
      siteId,
      name: input.name,
      scopes: input.scopes,
      tokenHash: hash(token),
      expiresAt: input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 86_400_000)
        : null,
    })
    .returning(columns);
  await audit(tx, siteId, actor, {
    action: 'mcp_token.create',
    entityType: 'mcp_token',
    entityId: record!.id,
    diff: { name: input.name, scopes: input.scopes },
  });
  return { token, record: record! };
}

/** The acting user's live tokens on this site. */
export function listMcpTokens(tx: Tx, siteId: string, actor: Actor): Promise<McpToken[]> {
  return tx
    .select(columns)
    .from(mcpTokens)
    .where(
      and(
        eq(mcpTokens.siteId, siteId),
        eq(mcpTokens.userId, actor.userId),
        isNull(mcpTokens.revokedAt),
        or(isNull(mcpTokens.expiresAt), gt(mcpTokens.expiresAt, new Date())),
      ),
    )
    .orderBy(desc(mcpTokens.createdAt));
}

export async function revokeMcpToken(
  tx: Tx,
  siteId: string,
  actor: Actor,
  id: string,
): Promise<void> {
  const [row] = await tx
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(mcpTokens.id, id),
        eq(mcpTokens.siteId, siteId),
        eq(mcpTokens.userId, actor.userId),
        isNull(mcpTokens.revokedAt),
      ),
    )
    .returning({ id: mcpTokens.id });
  if (!row) throw new NotFound('Token not found');
  await audit(tx, siteId, actor, {
    action: 'mcp_token.revoke',
    entityType: 'mcp_token',
    entityId: id,
  });
}

/** The live token for a presented secret, or undefined. Records when it was last used. */
export async function verifyMcpToken(db: Db, presented: string): Promise<McpToken | undefined> {
  if (!presented.startsWith(TOKEN_PREFIX) || presented.length > 200) return undefined;
  const now = new Date();
  const [row] = await db
    .select(columns)
    .from(mcpTokens)
    .where(
      and(
        eq(mcpTokens.tokenHash, hash(presented)),
        isNull(mcpTokens.revokedAt),
        or(isNull(mcpTokens.expiresAt), gt(mcpTokens.expiresAt, now)),
      ),
    );
  if (!row) return undefined;
  // At most one write a minute per token.
  await db
    .update(mcpTokens)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(mcpTokens.id, row.id),
        or(
          isNull(mcpTokens.lastUsedAt),
          lt(mcpTokens.lastUsedAt, new Date(now.getTime() - 60_000)),
        ),
      ),
    );
  return row;
}
