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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createAuth, createPasswordUser } from './auth.js';
import { createSiteResolver } from './sites.js';
import { testThemes } from './testing/themes.js';

const ADMIN = 'admin.example.net';
const adminUrl = new URL(`https://${ADMIN}`);
const secret = 'test-secret-test-secret-test-secret!';
const password = 'correct horse battery';

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let app: FastifyInstance;
let siteA: string;
let siteB: string;
let mediaDir: string;
const cookies: Record<string, string> = {};
const tokens: Record<string, string> = {};

function rest(who: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: { host: ADMIN, origin: adminUrl.origin, cookie: cookies[who] },
    ...(payload ? { payload } : {}),
  });
}

let rpcId = 0;
function rpc(token: string | null, method: string, params: object = {}, host = ADMIN) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      host,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: { jsonrpc: '2.0', id: ++rpcId, method, params },
  });
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function callTool<T = Record<string, unknown>>(
  who: string,
  name: string,
  args: object = {},
): Promise<{ isError: boolean; data: T }> {
  const res = await rpc(tokens[who]!, 'tools/call', { name, arguments: args });
  expect(res.statusCode).toBe(200);
  const body = res.json<{ result?: ToolResult; error?: { message: string } }>();
  if (!body.result) throw new Error(`RPC error: ${body.error?.message}`);
  const text = body.result.content[0]?.text ?? '';
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = { message: text } as T;
  }
  return { isError: body.result.isError ?? false, data };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  ({ db, pool } = createDb(tdb.appUrl));
  [siteA, siteB] = (
    await db
      .insert(schema.sites)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning()
  ).map((s) => s.id) as [string, string];
  await db.insert(schema.siteDomains).values([
    { domain: 'a.example', siteId: siteA, isPrimary: true },
    { domain: 'b.example', siteId: siteB, isPrimary: true },
  ]);
  mediaDir = await mkdtemp(join(tmpdir(), 'litho-mcp-media-'));
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
  let ip = 0;
  for (const [name, role, siteId] of people) {
    const email = `${name}@example.com`;
    const user = await createPasswordUser(auth, { email, name, password });
    await db.insert(schema.memberships).values({ userId: user.id, siteId, role });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { host: ADMIN, origin: adminUrl.origin, 'x-forwarded-for': `192.0.2.${++ip}` },
      payload: { email, password },
    });
    cookies[name] = String(res.headers['set-cookie']).split(';')[0]!;
    const site = siteId === siteA ? `/api/sites/${siteA}` : `/api/sites/${siteB}`;
    const created = await rest(name, 'POST', `${site}/mcp-tokens`, {
      name: 'Claude Code',
      scopes: ['content'],
    });
    expect(created.statusCode).toBe(201);
    tokens[name] = created.json<{ token: string }>().token;
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await tdb.stop();
  await rm(mediaDir, { recursive: true, force: true });
});

describe('MCP access tokens', () => {
  const a = (path: string) => `/api/sites/${siteA}${path}`;

  it('are shown once, listed without the secret and limited by role', async () => {
    const listed = await rest('author', 'GET', a('/mcp-tokens'));
    expect(listed.json()).toMatchObject({
      url: 'https://admin.example.net/mcp',
      grantable: ['content'],
      tokens: [{ name: 'Claude Code', scopes: ['content'] }],
    });
    expect(listed.body).not.toContain('litho_pat_');
    expect(listed.body).not.toContain('tokenHash');

    const denied = await rest('author', 'POST', a('/mcp-tokens'), {
      name: 'x',
      scopes: ['design'],
    });
    expect(denied.statusCode).toBe(403);
    const invalid = await rest('author', 'POST', a('/mcp-tokens'), { name: '', scopes: [] });
    expect(invalid.statusCode).toBe(400);
  });

  it('stop working once revoked, and only their owner can revoke them', async () => {
    const created = await rest('admin', 'POST', a('/mcp-tokens'), {
      name: 'Temporary',
      scopes: ['content', 'design'],
      expiresInDays: 30,
    });
    const { token, record } = created.json<{ token: string; record: { id: string } }>();
    expect((await rpc(token, 'tools/list')).statusCode).toBe(200);

    expect((await rest('author', 'DELETE', a(`/mcp-tokens/${record.id}`))).statusCode).toBe(404);
    expect((await rest('admin', 'DELETE', a(`/mcp-tokens/${record.id}`))).statusCode).toBe(204);
    expect((await rpc(token, 'tools/list')).statusCode).toBe(401);
  });
});

describe('MCP endpoint', () => {
  it('requires a valid bearer token', async () => {
    const none = await rpc(null, 'tools/list');
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toContain('Bearer');
    expect((await rpc('litho_pat_nope', 'tools/list')).statusCode).toBe(401);
  });

  it('exists only on the admin origin', async () => {
    const res = await rpc(tokens.admin!, 'tools/list', {}, 'a.example');
    expect(res.statusCode).toBe(404);
  });

  it('lists the content tools and the guides', async () => {
    const list = await rpc(tokens.author!, 'tools/list');
    const names = list
      .json<{ result: { tools: { name: string }[] } }>()
      .result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['site_info', 'post_create', 'post_publish']));

    const guide = await rpc(tokens.author!, 'resources/read', { uri: 'guide://content-format' });
    expect(
      guide.json<{ result: { contents: { text: string }[] } }>().result.contents[0]!.text,
    ).toContain('media:<id>');
  });

  it('describes the site', async () => {
    const { isError, data } = await callTool('author', 'site_info');
    expect(isError).toBe(false);
    expect(data).toMatchObject({ name: 'A', url: 'https://a.example', scopes: ['content'] });
  });
});

describe('MCP content tools', () => {
  it('create drafts from Markdown, audited as MCP with the token id', async () => {
    const { isError, data } = await callTool<{ id: string; status: string; edit_url: string }>(
      'author',
      'post_create',
      { type: 'post', title: 'From Claude', markdown: '## Hello\n\nSome **bold** text.' },
    );
    expect(isError).toBe(false);
    expect(data).toMatchObject({
      status: 'draft',
      edit_url: `https://admin.example.net/sites/${siteA}/posts/${data.id}`,
    });

    const got = await callTool<{ markdown: string }>('author', 'post_get', { id: data.id });
    expect(got.data.markdown).toContain('**bold**');

    const [token] = await db
      .select({ id: schema.mcpTokens.id })
      .from(schema.mcpTokens)
      .innerJoin(schema.users, eq(schema.users.id, schema.mcpTokens.userId))
      .where(
        and(eq(schema.mcpTokens.name, 'Claude Code'), eq(schema.users.email, 'author@example.com')),
      );
    const [entry, revision] = await withSite(db, siteA, async (tx) => [
      (await tx.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, data.id)))[0],
      (await tx.select().from(schema.revisions).where(eq(schema.revisions.postId, data.id)))[0],
    ]);
    expect(entry).toMatchObject({ action: 'post.create', channel: 'mcp', tokenId: token!.id });
    expect(revision).toMatchObject({ source: 'mcp' });
  });

  it('write nothing on a dry run', async () => {
    const { isError, data } = await callTool<{ dry_run: boolean; result: { id: string } }>(
      'author',
      'post_create',
      { type: 'page', title: 'Dry', markdown: 'Nothing.', dry_run: true },
    );
    expect(isError).toBe(false);
    expect(data.dry_run).toBe(true);
    const found = await callTool('author', 'post_get', { id: data.result.id });
    expect(found).toMatchObject({ isError: true, data: { code: 'not_found' } });
  });

  it('report Markdown problems with their path', async () => {
    const { isError, data } = await callTool('author', 'post_create', {
      type: 'post',
      title: 'Bad',
      markdown: '<script>alert(1)</script>',
    });
    expect(isError).toBe(true);
    const { code, issues } = data as {
      code: string;
      issues: { path: string[]; message: string }[];
    };
    expect(code).toBe('validation_failed');
    expect(issues[0]?.path).toEqual(['markdown']);
    expect(issues[0]?.message).toContain('Raw HTML');
  });

  it('reject invalid arguments before running', async () => {
    const { isError } = await callTool('author', 'post_get', { id: 'not-a-uuid' });
    expect(isError).toBe(true);
  });

  it('keep publishing to roles that may publish', async () => {
    const draft = await callTool<{ id: string }>('author', 'post_create', {
      type: 'post',
      title: 'Wants out',
    });
    const denied = await callTool('author', 'post_publish', { id: draft.data.id });
    expect(denied).toMatchObject({ isError: true, data: { code: 'forbidden' } });

    const published = await callTool<{ status: string; url: string }>('admin', 'post_publish', {
      id: draft.data.id,
    });
    expect(published.data.status).toBe('published');
    expect(published.data.url).toMatch(/^https:\/\/a\.example\//);
  });

  it('never reach another site', async () => {
    const mine = await callTool<{ id: string }>('author', 'post_create', {
      type: 'post',
      title: 'Site A only',
    });
    const read = await callTool('outsider', 'post_get', { id: mine.data.id });
    expect(read).toMatchObject({ isError: true, data: { code: 'not_found' } });
    const write = await callTool('outsider', 'post_update', { id: mine.data.id, title: 'Mine' });
    expect(write).toMatchObject({ isError: true, data: { code: 'not_found' } });
    const search = await callTool<{ items: unknown[] }>('outsider', 'posts_search', {});
    expect(search.data.items).toEqual([]);
  });

  it('upload images from base64 and use them in Markdown', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#c00' },
    })
      .png()
      .toBuffer();
    const up = await callTool<{ id: string; url: string }>('author', 'media_upload', {
      base64: png.toString('base64'),
      filename: 'red.png',
      alt: 'A red square',
    });
    expect(up.isError).toBe(false);
    expect(up.data.url).toMatch(/^https:\/\/a\.example\/media\//);

    const post = await callTool('author', 'post_create', {
      type: 'post',
      title: 'With image',
      markdown: `![A red square](media:${up.data.id})`,
    });
    expect(post.isError).toBe(false);

    const blocked = await callTool('author', 'media_upload', {
      source_url: 'http://127.0.0.1/secret.png',
      alt: 'x',
    });
    expect(blocked).toMatchObject({ isError: true, data: { code: 'validation_failed' } });
  });

  it('create terms and set menus', async () => {
    const args = { taxonomy: 'tag', name: 'Claude' };
    const denied = await callTool('author', 'term_create', args);
    expect(denied).toMatchObject({ isError: true, data: { code: 'forbidden' } });
    const term = await callTool<{ id: string }>('admin', 'term_create', args);
    expect(term.isError).toBe(false);
    const menu = await callTool('admin', 'menu_update', {
      location: 'primary',
      items: [{ label: 'Home', kind: 'url', url: '/' }],
    });
    expect(menu.isError).toBe(false);
    const read = await callTool<{ items: { label: string }[] }>('author', 'menu_get', {
      location: 'primary',
    });
    expect(read.data.items[0]).toMatchObject({ label: 'Home' });
  });

  it('cut token scopes down to the current role', async () => {
    const created = await rest('outsider', 'POST', `/api/sites/${siteB}/mcp-tokens`, {
      name: 'Designer',
      scopes: ['content', 'design'],
    });
    const { token } = created.json<{ token: string }>();
    const [user] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, 'outsider@example.com'));
    const membership = eq(schema.memberships.userId, user!.id);
    await db.update(schema.memberships).set({ role: 'editor' }).where(membership);
    const info = await rpc(token, 'tools/call', { name: 'site_info', arguments: {} });
    const result = info.json<{ result: ToolResult }>().result;
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ scopes: ['content'] });

    await db.delete(schema.memberships).where(membership);
    expect((await rpc(token, 'tools/list')).statusCode).toBe(401);
  });
});
