import { and, desc, eq } from 'drizzle-orm';
import { audit, type Actor } from '../content/audit.js';
import type { Db, Tx } from '../db/client.js';
import {
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
} from '../db/schema.js';
import { NotFound } from '../errors.js';

/** An MCP client (Claude.ai, Claude Desktop, ...) the user connected to a site over OAuth. */
export interface OAuthApp {
  /** The consent: one per client, user and site. */
  id: string;
  clientId: string;
  name: string | null;
  uri: string | null;
  scopes: string[];
  createdAt: Date | null;
}

const grantOf = (siteId: string, actor: Actor) =>
  and(eq(oauthConsents.userId, actor.userId), eq(oauthConsents.referenceId, siteId));

/** The acting user's connected apps on this site. */
export function listOAuthApps(tx: Tx, siteId: string, actor: Actor): Promise<OAuthApp[]> {
  return tx
    .select({
      id: oauthConsents.id,
      clientId: oauthConsents.clientId,
      name: oauthClients.name,
      uri: oauthClients.uri,
      scopes: oauthConsents.scopes,
      createdAt: oauthConsents.createdAt,
    })
    .from(oauthConsents)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthConsents.clientId))
    .where(grantOf(siteId, actor))
    .orderBy(desc(oauthConsents.createdAt));
}

/** Records the consent the user just gave on this site (better-auth wrote it). */
export async function auditOAuthGrant(tx: Tx, siteId: string, actor: Actor): Promise<void> {
  const [consent] = await tx
    .select({
      id: oauthConsents.id,
      clientId: oauthConsents.clientId,
      scopes: oauthConsents.scopes,
    })
    .from(oauthConsents)
    .where(grantOf(siteId, actor))
    .orderBy(desc(oauthConsents.updatedAt))
    .limit(1);
  if (!consent) return;
  await audit(tx, siteId, actor, {
    action: 'oauth_app.grant',
    entityType: 'oauth_app',
    entityId: consent.id,
    diff: { clientId: consent.clientId, scopes: consent.scopes },
  });
}

/** Disconnects an app: its consent and every token issued under it, effective immediately. */
export async function revokeOAuthApp(
  tx: Tx,
  siteId: string,
  actor: Actor,
  id: string,
): Promise<void> {
  const [consent] = await tx
    .delete(oauthConsents)
    .where(and(eq(oauthConsents.id, id), grantOf(siteId, actor)))
    .returning({ clientId: oauthConsents.clientId });
  if (!consent) throw new NotFound('App not found');
  for (const table of [oauthAccessTokens, oauthRefreshTokens]) {
    await tx
      .delete(table)
      .where(
        and(
          eq(table.clientId, consent.clientId),
          eq(table.userId, actor.userId),
          eq(table.referenceId, siteId),
        ),
      );
  }
  await audit(tx, siteId, actor, {
    action: 'oauth_app.revoke',
    entityType: 'oauth_app',
    entityId: id,
    diff: { clientId: consent.clientId },
  });
}

/** The consent behind an OAuth access token, if the user has not disconnected the app. */
export async function findOAuthGrant(
  db: Db,
  grant: { clientId: string; userId: string; siteId: string },
): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: oauthConsents.id })
    .from(oauthConsents)
    .where(
      and(
        eq(oauthConsents.clientId, grant.clientId),
        eq(oauthConsents.userId, grant.userId),
        eq(oauthConsents.referenceId, grant.siteId),
      ),
    );
  return row;
}
