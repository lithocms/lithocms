import {
  safeFetch,
  schema,
  scopesFor,
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
import { publicSite, type ThemeService } from './theme-service.js';
import type { ThemeSet } from './themes.js';

const VERSION = '0.0.0';

/**
 * The MCP endpoint (MCP_SPEC.md): Streamable HTTP, stateless, on the admin origin only. Each
 * request carries a personal access token; its effective rights are the token's scopes cut
 * down to the user's current role on the token's site.
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
  }: {
    db: Db;
    secret: string;
    store: MediaStore;
    themes: ThemeSet;
    themeService: ThemeService;
    adminUrl: URL;
  },
) {
  const limiter = new RateLimiter();
  const unauthorized = (reply: FastifyReply, message: string) =>
    reply
      .code(401)
      .header('www-authenticate', `Bearer realm="lithocms", error="invalid_token"`)
      .send({ error: 'unauthorized', message });

  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    // Site origins never reach the MCP server (`request.site` is set only there).
    if (request.site) return reply.code(404).send({ error: 'unknown_host' });
    const header = request.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const token = presented ? await verifyMcpToken(db, presented) : undefined;
    if (!token) return unauthorized(reply, 'A valid LithoCMS access token is required');

    const [user] = await db
      .select({ isInstanceOwner: schema.users.isInstanceOwner })
      .from(schema.users)
      .where(eq(schema.users.id, token.userId));
    const role = user && (await roleOn(db, token.userId, token.siteId, user.isInstanceOwner));
    if (!role) return unauthorized(reply, 'The token’s user no longer has access to this site');
    const allowed = scopesFor(role);
    const scopes = token.scopes.filter((s) => allowed.includes(s));

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
          tokenId: token.id,
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
