import { passkey } from '@better-auth/passkey';
import { schema, type Db } from '@lithocms/core';
import { hash, verify } from '@node-rs/argon2';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';

export interface AuthOptions {
  db: Db;
  /** Admin origin, e.g. `https://admin.example.com`. Auth only ever runs there. */
  adminUrl: URL;
  secret: string;
}

// argon2id (the library default) with the OWASP baseline: 19 MiB, 2 iterations, 1 lane.
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

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
      },
    }),
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
      // Caddy replaces client-sent X-Forwarded-For with the real peer address.
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
    plugins: [
      twoFactor({ issuer: 'LithoCMS' }),
      passkey({ rpID: adminUrl.hostname, rpName: 'LithoCMS', origin: adminUrl.origin }),
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

/** The signed-in admin user for this request, if any. */
export async function getSessionUser(auth: Auth, request: FastifyRequest) {
  return (await auth.api.getSession({ headers: toHeaders(request.headers) }))?.user ?? null;
}

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(key, v);
    }
  }
  return headers;
}

/** better-auth endpoints and the admin SPA's session bootstrap. Admin origin only. */
export function registerAuthRoutes(app: FastifyInstance, { auth, db }: { auth: Auth; db: Db }) {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const response = await auth.handler(
        new Request(new URL(request.url, auth.options.baseURL), {
          method: request.method,
          headers: toHeaders(request.headers),
          body: request.method === 'POST' ? JSON.stringify(request.body ?? {}) : undefined,
        }),
      );
      reply.status(response.status);
      for (const [key, value] of response.headers) {
        if (key !== 'set-cookie') reply.header(key, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      const body = await response.text();
      if (!response.headers.get('content-type')?.includes('application/json'))
        return reply.send(body);
      // The session lives in the HttpOnly cookie only; never hand its token to page scripts.
      return reply.send(JSON.stringify(withoutToken(JSON.parse(body))));
    },
  });

  app.get('/api/me', async (request, reply) => {
    const user = await getSessionUser(auth, request);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    const { id, name, email, isInstanceOwner, twoFactorEnabled } = user;
    const sites = await db
      .select({ id: schema.sites.id, name: schema.sites.name, role: schema.memberships.role })
      .from(schema.memberships)
      .innerJoin(schema.sites, eq(schema.sites.id, schema.memberships.siteId))
      .where(eq(schema.memberships.userId, id))
      .orderBy(schema.sites.name);
    return { user: { id, name, email, isInstanceOwner, twoFactorEnabled }, sites };
  });
}
