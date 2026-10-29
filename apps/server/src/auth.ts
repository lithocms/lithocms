import { cimd } from '@better-auth/cimd';
import { mcp } from '@better-auth/mcp';
import { passkey } from '@better-auth/passkey';
import { auditOAuthGrant, safeFetch, schema, withSite, type Db } from '@lithocms/core';
import { hash, verify } from '@node-rs/argon2';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { jwt, twoFactor } from 'better-auth/plugins';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { clientIp } from './client-ip.js';

export interface AuthOptions {
  db: Db;
  /** Admin origin, e.g. `https://admin.example.com`. Auth only ever runs there. */
  adminUrl: URL;
  secret: string;
}

// argon2id (the library default) with the OWASP baseline: 19 MiB, 2 iterations, 1 lane.
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

/** The MCP endpoint as an OAuth protected resource: the audience of every access token. */
export const mcpResource = (adminUrl: URL) => new URL('/mcp', adminUrl).href;

// better-auth endpoints for managing OAuth clients and consents from page scripts, and the
// session JWT; LithoCMS manages connected apps through its own API (oauth.ts).
const DISABLED_PATHS = [
  '/token',
  '/oauth2/create-client',
  '/oauth2/get-client',
  '/oauth2/get-clients',
  '/oauth2/update-client',
  '/oauth2/client/rotate-secret',
  '/oauth2/delete-client',
  '/oauth2/public-client',
  '/oauth2/public-client-prelogin',
  '/oauth2/get-consent',
  '/oauth2/get-consents',
  '/oauth2/update-consent',
  '/oauth2/delete-consent',
];

/** Client ID Metadata Documents are fetched like any other outbound URL: through safeFetch. */
async function fetchClientMetadata(input: string | URL | Request, init?: RequestInit) {
  const url = input instanceof Request ? input.url : input.toString();
  const res = await safeFetch(url, {
    headers: Object.fromEntries(new Headers(init?.headers)),
    maxRedirects: 0,
    maxBytes: 64 * 1024,
    timeoutMs: 5_000,
  });
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(key, v);
    }
  }
  return new Response(res.body.length ? new Uint8Array(res.body) : null, {
    status: res.status,
    headers,
  });
}

/** The user's role on the site picked for an OAuth grant, if they still belong to it. */
async function membership(db: Db, userId: string, siteId: unknown) {
  if (typeof siteId !== 'string') return undefined;
  const [row] = await db
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.siteId, siteId)));
  return row && { siteId, role: row.role };
}

export function createAuth({ db, adminUrl, secret }: AuthOptions) {
  return betterAuth({
    appName: 'LithoCMS',
    baseURL: adminUrl.origin,
    basePath: '/api/auth',
    secret,
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        twoFactor: schema.twoFactors,
        passkey: schema.passkeys,
        jwks: schema.jwks,
        oauthClient: schema.oauthClients,
        oauthResource: schema.oauthResources,
        oauthClientResource: schema.oauthClientResources,
        oauthRefreshToken: schema.oauthRefreshTokens,
        oauthAccessToken: schema.oauthAccessTokens,
        oauthConsent: schema.oauthConsents,
        oauthClientAssertion: schema.oauthClientAssertions,
      },
    }),
    session: {
      additionalFields: {
        oauthSiteId: { type: 'string', input: false, required: false },
      },
    },
    disabledPaths: DISABLED_PATHS,
    hooks: {
      // Consents are written by better-auth; every write is audited on the site it concerns.
      after: createAuthMiddleware(async (ctx) => {
        const body = ctx.body as { accept?: unknown } | undefined;
        if (ctx.path !== '/oauth2/consent' || body?.accept !== true) return;
        const session = await getSessionFromCtx(ctx);
        if (!session) return;
        const member = await membership(db, session.user.id, session.session.oauthSiteId);
        if (!member) return;
        await withSite(db, member.siteId, (tx) =>
          auditOAuthGrant(tx, member.siteId, {
            userId: session.user.id,
            role: member.role,
            channel: 'admin',
          }),
        );
      }),
    },
    user: {
      additionalFields: {
        isInstanceOwner: { type: 'boolean', input: false, defaultValue: false },
      },
    },
    // Accounts are created by an owner or admin (invitations), never by visitors.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      password: {
        hash: (password) => hash(password, ARGON2),
        verify: ({ hash: digest, password }) => verify(digest, password),
      },
    },
    rateLimit: { enabled: true, storage: 'memory' },
    advanced: {
      // Ids come from the database (uuidv7).
      database: { generateId: false },
      useSecureCookies: adminUrl.protocol === 'https:',
      // Host-only (no Domain attribute): site origins never receive the admin session.
      defaultCookieAttributes: { httpOnly: true, sameSite: 'strict' },
      // Set by `toHeaders` from the proxy-appended address; better-auth would trust the first
      // X-Forwarded-For entry, which the client controls.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    plugins: [
      twoFactor({ issuer: 'LithoCMS' }),
      passkey({ rpID: adminUrl.hostname, rpName: 'LithoCMS', origin: adminUrl.origin }),
      jwt({ disableSettingJwtHeader: true }),
      // OAuth 2.1 for MCP clients (Claude.ai, Claude Desktop): pages live in the admin SPA.
      // Each grant is for one site, picked after sign-in and stored as the consent's
      // reference id; access tokens carry it as `site_id`.
      mcp({
        resource: mcpResource(adminUrl),
        loginPage: '/login',
        consentPage: '/oauth/consent',
        scopes: [...schema.MCP_SCOPES, 'offline_access'],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        postLogin: {
          page: '/oauth/site',
          // Every authorization asks for the site; continuing needs a site the user is in.
          shouldRedirect: async ({ user, session, isContinuation }) =>
            !isContinuation || !(await membership(db, user.id, session.oauthSiteId)),
          consentReferenceId: async ({ user, session }) => {
            const member = await membership(db, user.id, session.oauthSiteId);
            if (!member) throw new APIError('FORBIDDEN', { message: 'Pick a site first' });
            return member.siteId;
          },
        },
        customAccessTokenClaims: ({ referenceId }) => ({ site_id: referenceId }),
      }),
      cimd({
        fetchClientMetadataResource: fetchClientMetadata,
        metadataProfile: 'mcp-2026-07-28',
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Creates a user who signs in with email and password. For the CLI, setup and invitations. */
export async function createPasswordUser(
  auth: Auth,
  input: { email: string; name: string; password: string; isInstanceOwner?: boolean },
): Promise<{ id: string }> {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser(
    {
      email: input.email.toLowerCase(),
      name: input.name,
      emailVerified: true,
      isInstanceOwner: input.isInstanceOwner ?? false,
    },
    { method: 'admin' },
  );
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: await ctx.password.hash(input.password),
  });
  return { id: user.id };
}

/** Drops every `token` field, at any depth (sign-in, get-session, list-sessions, ...). */
function withoutToken(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(withoutToken);
  if (typeof body !== 'object' || body === null) return body;
  return Object.fromEntries(
    Object.entries(body)
      .filter(([key]) => key !== 'token')
      .map(([key, value]) => [key, withoutToken(value)]),
  );
}

/** The admin session for this request, if any. */
export function getSession(auth: Auth, request: FastifyRequest) {
  return auth.api.getSession({ headers: toHeaders(request) });
}

/** The signed-in admin user for this request, if any. */
export async function getSessionUser(auth: Auth, request: FastifyRequest) {
  return (await getSession(auth, request))?.user ?? null;
}

const CLIENT_IP_HEADER = 'x-litho-client-ip';

function toHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key === CLIENT_IP_HEADER) continue;
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(key, v);
    }
  }
  headers.set(CLIENT_IP_HEADER, clientIp(request));
  return headers;
}

/** better-auth endpoints and the admin SPA's session bootstrap. Admin origin only. */
export function registerAuthRoutes(
  app: FastifyInstance,
  { auth, db, adminUrl }: { auth: Auth; db: Db; adminUrl: URL },
) {
  void app.register((scope, _opts, done) => {
    // OAuth clients post forms (token, revocation); better-auth parses them itself.
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 64 * 1024 },
      (_request, body, done) => done(null, body),
    );
    scope.route({
      method: ['GET', 'POST'],
      url: '/api/auth/*',
      async handler(request, reply) {
        const payload =
          typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {});
        const response = await auth.handler(
          new Request(new URL(request.url, auth.options.baseURL), {
            method: request.method,
            headers: toHeaders(request),
            body: request.method === 'POST' ? payload : undefined,
          }),
        );
        reply.status(response.status);
        for (const [key, value] of response.headers) {
          if (key !== 'set-cookie') reply.header(key, value);
        }
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header('set-cookie', cookies);
        const body = await response.text();
        // Redirects (OAuth authorize) may be labelled JSON with nothing in them.
        if (!body || !response.headers.get('content-type')?.includes('application/json'))
          return reply.send(body);
        // The session lives in the HttpOnly cookie only; never hand its token to page scripts.
        return reply.send(JSON.stringify(withoutToken(JSON.parse(body))));
      },
    });
    done();
  });

  app.get('/api/me', async (request, reply) => {
    const user = await getSessionUser(auth, request);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    const { id, name, email, isInstanceOwner, twoFactorEnabled } = user;
    const rows = await db
      .select({
        id: schema.sites.id,
        name: schema.sites.name,
        role: schema.memberships.role,
        domain: schema.siteDomains.domain,
      })
      .from(schema.memberships)
      .innerJoin(schema.sites, eq(schema.sites.id, schema.memberships.siteId))
      .leftJoin(
        schema.siteDomains,
        and(eq(schema.siteDomains.siteId, schema.sites.id), eq(schema.siteDomains.isPrimary, true)),
      )
      .where(eq(schema.memberships.userId, id))
      .orderBy(schema.sites.name);
    // Public origin of each site, on the admin origin's scheme and port (media previews, "view site").
    const port = adminUrl.port ? `:${adminUrl.port}` : '';
    const sites = rows.map(({ domain, ...site }) => ({
      ...site,
      url: domain ? `${adminUrl.protocol}//${domain}${port}` : null,
    }));
    return { user: { id, name, email, isInstanceOwner, twoFactorEnabled }, sites };
  });
}
