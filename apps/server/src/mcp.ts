import {
  safeFetch,
  schema,
  scopesFor,
  TOKEN_PREFIX,
  verifyMcpToken,
  withSite,
  type Db,
  type MediaStore,
} from '@lithocms/core';
import { createMcpServer, RateLimiter } from '@lithocms/mcp';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { roleOn } from './api.js';
import { ipHash } from './client-ip.js';
import { resourceMetadataUrl, type OAuthGrant } from './oauth.js';
import { publicSite, type ThemeService } from './theme-service.js';
import type { ThemeSet } from './themes.js';

const VERSION = '0.0.0';

/**
 * The MCP endpoint (MCP_SPEC.md): Streamable HTTP, stateless, on the admin origin only. Each
 * request carries a personal access token or an OAuth access token; its effective rights are
 * the token's scopes cut down to the user's current role on the token's site.
 */
export function registerMcp(
  app: FastifyInstance,
  {
    db,
    secret,
    store,
    themes,
    themeService,
    adminUrl,
    verifyOAuth,
  }: {
    db: Db;
    secret: string;
    store: MediaStore;
    themes: ThemeSet;
    themeService: ThemeService;
    adminUrl: URL;
    verifyOAuth: (request: FastifyRequest) => Promise<OAuthGrant | undefined>;
  },
) {
  const limiter = new RateLimiter();
  // Names the protected-resource metadata, where OAuth clients learn how to get a token.
  const challenge = `Bearer resource_metadata="${resourceMetadataUrl(adminUrl)}"`;
  const unauthorized = (reply: FastifyReply, message: string, presented: boolean) =>
    reply
      .code(401)
      .header('www-authenticate', presented ? `${challenge}, error="invalid_token"` : challenge)
      .send({ error: 'unauthorized', message });

  /** The token's user, site and scopes, whichever kind of token was presented. */
  const authenticate = async (request: FastifyRequest) => {
    const header = request.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (presented.startsWith(TOKEN_PREFIX)) {
      const token = await verifyMcpToken(db, presented);
      return token && { ...token, tokenId: token.id };
    }
    const grant = await verifyOAuth(request);
    return grant && { ...grant, tokenId: grant.grantId };
  };

  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    // Site origins never reach the MCP server (`request.site` is set only there).
    if (request.site) return reply.code(404).send({ error: 'unknown_host' });
    const token = await authenticate(request);
    if (!token) {
      const presented = Boolean(request.headers.authorization);
      return unauthorized(reply, 'A valid LithoCMS access token is required', presented);
    }

    const [user] = await db
      .select({ isInstanceOwner: schema.users.isInstanceOwner })
      .from(schema.users)
      .where(eq(schema.users.id, token.userId));
    const role = user && (await roleOn(db, token.userId, token.siteId, user.isInstanceOwner));
    if (!role)
      return unauthorized(reply, 'The token’s user no longer has access to this site', true);
    const allowed = scopesFor(role);
    const scopes = allowed.filter((s) => token.scopes.includes(s));

    const { origin: siteOrigin } = await withSite(db, token.siteId, (tx) =>
      publicSite(tx, token.siteId, adminUrl),
    );

    const server = createMcpServer(
      {
        db,
        siteId: token.siteId,
        actor: {
          userId: token.userId,
          role,
          channel: 'mcp',
          tokenId: token.tokenId,
          ipHash: ipHash(request, secret),
        },
        scopes,
        adminUrl,
        siteOrigin,
        store,
        limiter,
        themeDefaults: themes.defaults,
        themes: themeService,
        guides: { themeAuthoring: themes.authoringGuide },
        logError: (err) => request.log.error({ err }, 'MCP tool failed'),
        fetchUrl: (url, maxBytes) => safeFetch(url, { maxBytes, timeoutMs: 20_000 }),
      },
      VERSION,
    );
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  };

  // Base64 media uploads need room; everything else is small JSON-RPC.
  const opts = { bodyLimit: 30 * 1024 * 1024 };
  app.post('/mcp', opts, handle);
  // Stateless: no server-initiated stream and no session to end.
  app.get('/mcp', (_req, reply) => reply.code(405).header('allow', 'POST').send());
  app.delete('/mcp', (_req, reply) => reply.code(405).header('allow', 'POST').send());
}
