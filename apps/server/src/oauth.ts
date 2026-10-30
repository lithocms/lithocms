import { findOAuthGrant, schema, scopesFor, type Db } from '@lithocms/core';
import {
  createDpopReplayStore,
  enforceDpopBinding,
  parseAccessTokenAuthorization,
  verifyJwsAccessToken,
} from 'better-auth/oauth2';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getSession, mcpResource, type Auth } from './auth.js';

/** A verified OAuth access token for the MCP endpoint. */
export interface OAuthGrant {
  userId: string;
  siteId: string;
  scopes: string[];
  /** The consent the token was issued under; audit rows name it as the token. */
  grantId: string;
}

/**
 * Checks an OAuth access token presented to /mcp: signed by this instance for the MCP
 * resource, sender-bound when DPoP was used, and issued under a consent the user has not
 * since disconnected.
 */
export function createOAuthVerifier({ auth, db, adminUrl }: { auth: Auth; db: Db; adminUrl: URL }) {
  const verifyOptions = { issuer: `${adminUrl.origin}/api/auth`, audience: mcpResource(adminUrl) };
  const jwksCacheKey = {};
  const replayStore = auth.$context.then((ctx) => createDpopReplayStore(ctx.internalAdapter));

  return async (request: FastifyRequest): Promise<OAuthGrant | undefined> => {
    const authorization = parseAccessTokenAuthorization(request.headers.authorization);
    if (!authorization?.token) return undefined;
    let payload;
    try {
      payload = await verifyJwsAccessToken(authorization.token, {
        jwksFetch: () => auth.api.getJwks(),
        jwksCacheKey,
        verifyOptions,
      });
      await enforceDpopBinding({
        payload,
        authorization,
        proofJwt: request.headers.dpop as string | undefined,
        method: request.method,
        url: new URL(request.url, adminUrl).href,
        replayStore: await replayStore,
      });
    } catch (err) {
      request.log.info({ err }, 'OAuth access token rejected');
      return undefined;
    }
    const { sub: userId, client_id: clientId, site_id: siteId, scope } = payload;
    if (typeof userId !== 'string' || typeof clientId !== 'string' || typeof siteId !== 'string') {
      return undefined;
    }
    const grant = await findOAuthGrant(db, { clientId, userId, siteId });
    if (!grant) return undefined;
    const scopes = typeof scope === 'string' ? scope.split(' ') : [];
    return { userId, siteId, scopes, grantId: grant.id };
  };
}

/** Where MCP clients discover how to authorize (RFC 9728), named in 401 challenges. */
export const resourceMetadataUrl = (adminUrl: URL) =>
  new URL('/.well-known/oauth-protected-resource/mcp', adminUrl).href;

/**
 * OAuth discovery documents, and the two steps of the authorization flow that are ours: the
 * site picker and the consent screen's details (the admin SPA renders both).
 */
export function registerOAuth(
  app: FastifyInstance,
  { auth, db, adminUrl }: { auth: Auth; db: Db; adminUrl: URL },
) {
  // Admin origin only; site origins have their own /.well-known.
  const adminOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.site) return reply.code(404).send({ error: 'not_found' });
  };

  const resourceMetadata = {
    resource: mcpResource(adminUrl),
    authorization_servers: [`${adminUrl.origin}/api/auth`],
    bearer_methods_supported: ['header'],
    scopes_supported: [...schema.MCP_SCOPES],
  };
  for (const url of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    app.get(url, { onRequest: adminOnly }, () => resourceMetadata);
  }
  // RFC 8414 puts the issuer's path after the well-known name; some clients ask at the root.
  for (const url of [
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/api/auth',
  ]) {
    app.get(url, { onRequest: adminOnly }, () => auth.api.getOAuthServerConfig());
  }

  const membership = async (userId: string, siteId: string) => {
    const [row] = await db
      .select({ role: schema.memberships.role, name: schema.sites.name })
      .from(schema.memberships)
      .innerJoin(schema.sites, eq(schema.sites.id, schema.memberships.siteId))
      .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.siteId, siteId)));
    return row;
  };

  // Request validation uses the compiler registerApi sets on the app.
  const api = app.withTypeProvider<ZodTypeProvider>();

  // Step 1 (after sign-in): the site this grant is for. The SPA then resumes the flow with
  // better-auth's /oauth2/continue, which checks the choice again.
  api.post(
    '/api/oauth/site',
    { schema: { body: z.strictObject({ siteId: z.uuid() }) } },
    async (request, reply) => {
      const session = await getSession(auth, request);
      if (!session) return reply.code(401).send({ error: 'unauthorized' });
      const { siteId } = request.body;
      if (!(await membership(session.user.id, siteId))) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      await db
        .update(schema.sessions)
        .set({ oauthSiteId: siteId })
        .where(eq(schema.sessions.id, session.session.id));
      return reply.code(204).send();
    },
  );

  // Step 2: what the consent screen shows. The scopes to grant come from the signed query.
  api.get(
    '/api/oauth/consent',
    { schema: { querystring: z.object({ client_id: z.string().max(2048) }) } },
    async (request, reply) => {
      const session = await getSession(auth, request);
      if (!session) return reply.code(401).send({ error: 'unauthorized' });
      const siteId = session.session.oauthSiteId;
      const site = typeof siteId === 'string' && (await membership(session.user.id, siteId));
      if (!site) return reply.code(409).send({ error: 'no_site' });
      const { client_id: clientId } = request.query;
      const [client] = await db
        .select({
          name: schema.oauthClients.name,
          uri: schema.oauthClients.uri,
          icon: schema.oauthClients.icon,
        })
        .from(schema.oauthClients)
        .where(eq(schema.oauthClients.clientId, clientId));
      if (!client) return reply.code(404).send({ error: 'not_found' });
      return {
        client: { id: clientId, ...client },
        site: { id: siteId, name: site.name },
        grantable: scopesFor(site.role),
      };
    },
  );
}
