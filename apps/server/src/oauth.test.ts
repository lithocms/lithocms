import {
  createDb,
  createDiskStore,
  runMigrations,
  schema,
  withSite,
  type Db,
  type Role,
} from '@lithocms/core';
import { startTestDatabase, type TestDatabase } from '@lithocms/core/testing';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createAuth, createPasswordUser } from './auth.js';
import { createSiteResolver } from './sites.js';
import { testThemes } from './testing/themes.js';

const ADMIN = 'admin.example.net';
const adminUrl = new URL(`https://${ADMIN}`);
const RESOURCE = `${adminUrl.origin}/mcp`;
const REDIRECT = 'https://client.example/callback';
const secret = 'test-secret-test-secret-test-secret!';
const password = 'correct horse battery';

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let app: FastifyInstance;
let mediaDir: string;
let siteA: string;
let siteB: string;
let clientId: string;
const cookies: Record<string, string> = {};
let ip = 0;

const admin = (method: 'GET' | 'POST' | 'DELETE', url: string, who?: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: {
      host: ADMIN,
      origin: adminUrl.origin,
      'x-forwarded-for': `192.0.2.${++ip}`,
      ...(who ? { cookie: cookies[who] } : {}),
    },
    ...(payload ? { payload } : {}),
  });

/** The signed query of a redirect to one of the flow's pages, as the SPA would send it back. */
const signedQuery = (location: string, page: string) => {
  const url = new URL(location, adminUrl);
  expect(url.pathname).toBe(page);
  return url.search.slice(1);
};
const redirectUrl = (res: { json: () => unknown }) => (res.json() as { url: string }).url;

function rpc(token: string, method: string, params: object = {}) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      host: ADMIN,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });
}

const tokenRequest = (form: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/oauth2/token',
    headers: { host: ADMIN, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(form).toString(),
  });

/** Runs the authorization flow for `who` up to the consent screen; returns its signed query. */
async function toConsent(
  who: string,
  siteId: string,
  scope: string,
  verifier: string,
): Promise<{ picked: { statusCode: number }; consentQuery: string }> {
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope,
    state: 'st4te',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
  });
  const authorize = `/api/auth/oauth2/authorize?${query.toString()}`;
  // Cross-site navigations arrive without the SameSite=Strict session: sign-in comes first.
  const anonymous = await admin('GET', authorize);
  expect(anonymous.statusCode).toBe(302);
  const loginQuery = signedQuery(anonymous.headers.location!, '/login');
  const signIn = await admin('POST', '/api/auth/sign-in/email', undefined, {
    email: `${who}@example.com`,
    password,
    oauth_query: loginQuery,
  });
  expect(signIn.statusCode).toBe(200);
  cookies[who] = String(signIn.headers['set-cookie']).split(';')[0]!;
  const siteQuery = signedQuery(redirectUrl(signIn), '/oauth/site');

  const picked = await admin('POST', '/api/oauth/site', who, { siteId });
  if (picked.statusCode !== 204) return { picked, consentQuery: '' };
  const resumed = await admin('POST', '/api/auth/oauth2/continue', who, {
    postLogin: true,
    oauth_query: siteQuery,
  });
  expect(resumed.statusCode).toBe(200);
  return { picked, consentQuery: signedQuery(redirectUrl(resumed), '/oauth/consent') };
}

/** Exchanges the code a consent redirect carries for tokens. */
async function exchange(location: string, verifier: string) {
  const back = new URL(location);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe('st4te');
  const res = await tokenRequest({
    grant_type: 'authorization_code',
    code: back.searchParams.get('code')!,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ access_token: string; refresh_token?: string; scope: string }>();
}

const toolNames = async (token: string) => {
  const res = await rpc(token, 'tools/list');
  expect(res.statusCode).toBe(200);
  return res.json<{ result: { tools: { name: string }[] } }>().result.tools.map((t) => t.name);
};

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  ({ db, pool } = createDb(tdb.appUrl));
  [siteA, siteB] = (
    await db
      .insert(schema.sites)
      .values([{ name: 'Site A' }, { name: 'Site B' }])
      .returning()
  ).map((s) => s.id) as [string, string];
  mediaDir = await mkdtemp(join(tmpdir(), 'litho-oauth-media-'));
  const owner = createDb(tdb.ownerUrl);
  const themes = await testThemes(owner.db);
  await owner.pool.end();
  const auth = createAuth({ db, adminUrl, secret });
  app = buildApp({
    db,
    sites: await createSiteResolver(db),
    adminUrl,
    auth,
    secret,
    store: createDiskStore(mediaDir),
    themes,
    logLevel: 'silent',
  });
  const people: [string, Role, string][] = [
    ['admin', 'admin', siteA],
    ['author', 'author', siteA],
    ['outsider', 'admin', siteB],
  ];
  for (const [name, role, siteId] of people) {
    const user = await createPasswordUser(auth, { email: `${name}@example.com`, name, password });
    await db.insert(schema.memberships).values({ userId: user.id, siteId, role });
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await tdb.stop();
  await rm(mediaDir, { recursive: true, force: true });
});

describe('OAuth for MCP clients', () => {
  it('is discoverable from an unauthenticated MCP request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { host: ADMIN, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    const metadataUrl = `${adminUrl.origin}/.well-known/oauth-protected-resource/mcp`;
    expect(res.headers['www-authenticate']).toBe(`Bearer resource_metadata="${metadataUrl}"`);

    const resource = await admin('GET', '/.well-known/oauth-protected-resource/mcp');
    expect(resource.json()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [`${adminUrl.origin}/api/auth`],
      scopes_supported: ['content', 'design', 'admin'],
    });
    const server = await admin('GET', '/.well-known/oauth-authorization-server/api/auth');
    expect(server.json()).toMatchObject({
      issuer: `${adminUrl.origin}/api/auth`,
      registration_endpoint: `${adminUrl.origin}/api/auth/oauth2/register`,
      code_challenge_methods_supported: ['S256'],
    });
    // Site origins do not speak for the admin origin.
    const onSite = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource/mcp',
      headers: { host: 'unknown.example' },
    });
    expect(onSite.statusCode).toBe(404);
  });

  it('registers public clients dynamically, without a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/oauth2/register',
      headers: { host: ADMIN, 'content-type': 'application/json' },
      payload: {
        client_name: 'Test Client',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    clientId = res.json<{ client_id: string }>().client_id;
    expect(clientId).toBeTruthy();
  });

  it('grants one site with the scopes the user approves', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const { consentQuery } = await toConsent(
      'admin',
      siteA,
      'content design offline_access',
      verifier,
    );

    const details = await admin('GET', `/api/oauth/consent?client_id=${clientId}`, 'admin');
    expect(details.json()).toMatchObject({
      client: { id: clientId, name: 'Test Client' },
      site: { id: siteA, name: 'Site A' },
      grantable: ['content', 'design', 'admin'],
    });

    // The user unticks design.
    const consent = await admin('POST', '/api/auth/oauth2/consent', 'admin', {
      accept: true,
      scope: 'content offline_access',
      oauth_query: consentQuery,
    });
    expect(consent.statusCode).toBe(200);
    const tokens = await exchange(redirectUrl(consent), verifier);
    expect(tokens.scope.split(' ').sort()).toEqual(['content', 'offline_access']);
    expect(tokens.refresh_token).toBeTruthy();

    const tools = await toolNames(tokens.access_token);
    expect(tools).toContain('post_create');
    expect(tools).not.toContain('theme_activate');
    const info = await rpc(tokens.access_token, 'tools/call', { name: 'site_info', arguments: {} });
    expect(info.body).toContain('Site A');

    // Writes are audited with the grant as the token.
    const created = await rpc(tokens.access_token, 'tools/call', {
      name: 'post_create',
      arguments: { type: 'post', title: 'Via OAuth', markdown: 'Hello' },
    });
    expect(created.json<{ result: { isError?: boolean } }>().result.isError).toBeFalsy();
    const [grant] = await db
      .select({ id: schema.oauthConsents.id })
      .from(schema.oauthConsents)
      .where(eq(schema.oauthConsents.clientId, clientId));
    const audit = await withSite(db, siteA, (tx) =>
      tx
        .select({ action: schema.auditLog.action, tokenId: schema.auditLog.tokenId })
        .from(schema.auditLog),
    );
    expect(audit).toEqual(
      expect.arrayContaining([
        { action: 'oauth_app.grant', tokenId: null },
        { action: 'post.create', tokenId: grant!.id },
      ]),
    );

    // Refreshing keeps the site and the approved scopes.
    const refreshed = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token!,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(refreshed.statusCode).toBe(200);
    expect(await toolNames(refreshed.json<{ access_token: string }>().access_token)).toContain(
      'post_create',
    );

    // Disconnecting the app stops its tokens at once.
    const listed = await admin('GET', `/api/sites/${siteA}/mcp-tokens`, 'admin');
    const apps = listed.json<{ apps: { id: string; name: string; scopes: string[] }[] }>().apps;
    expect(apps).toMatchObject([{ name: 'Test Client', scopes: ['content', 'offline_access'] }]);
    const removed = await admin('DELETE', `/api/sites/${siteA}/oauth-apps/${apps[0]!.id}`, 'admin');
    expect(removed.statusCode).toBe(204);
    expect((await rpc(tokens.access_token, 'tools/list')).statusCode).toBe(401);
    const reuse = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token!,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(reuse.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('never lets a user pick a site they are not a member of', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const { picked } = await toConsent('outsider', siteA, 'content', verifier);
    expect(picked.statusCode).toBe(403);
    // Skipping the picker does not get past it either.
    const details = await admin('GET', `/api/oauth/consent?client_id=${clientId}`, 'outsider');
    expect(details.statusCode).toBe(409);
  });

  it('cuts granted scopes down to the user’s role, now and later', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const { consentQuery } = await toConsent('author', siteA, 'content design', verifier);
    const details = await admin('GET', `/api/oauth/consent?client_id=${clientId}`, 'author');
    expect(details.json()).toMatchObject({ grantable: ['content'] });
    const consent = await admin('POST', '/api/auth/oauth2/consent', 'author', {
      accept: true,
      oauth_query: consentQuery,
    });
    const tokens = await exchange(redirectUrl(consent), verifier);
    const tools = await toolNames(tokens.access_token);
    expect(tools).toContain('post_create');
    expect(tools).not.toContain('theme_activate');

    // Leaving the site ends access even though the token is still valid.
    const [author] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, 'author@example.com'));
    await db
      .delete(schema.memberships)
      .where(and(eq(schema.memberships.userId, author!.id), eq(schema.memberships.siteId, siteA)));
    expect((await rpc(tokens.access_token, 'tools/list')).statusCode).toBe(401);
  });

  it('rejects denied requests and forged tokens', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const { consentQuery } = await toConsent('admin', siteA, 'content', verifier);
    const denied = await admin('POST', '/api/auth/oauth2/consent', 'admin', {
      accept: false,
      oauth_query: consentQuery,
    });
    expect(new URL(redirectUrl(denied)).searchParams.get('error')).toBe('access_denied');

    const tampered = await admin('POST', '/api/auth/oauth2/consent', 'admin', {
      accept: true,
      oauth_query: consentQuery.replace('scope=content', 'scope=admin'),
    });
    expect(tampered.statusCode).toBe(400);

    const [header, payload] = ['{"alg":"none"}', '{"sub":"x","site_id":"y"}'].map((p) =>
      Buffer.from(p).toString('base64url'),
    );
    expect((await rpc(`${header}.${payload}.`, 'tools/list')).statusCode).toBe(401);
  });
});
