import { createDb, runMigrations, schema, type Db } from '@lithocms/core';
import { startTestDatabase, type TestDatabase } from '@lithocms/core/testing';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createAuth, createPasswordUser, type Auth } from './auth.js';
import { createSiteResolver } from './sites.js';

const ADMIN = 'admin.example.net';
const adminUrl = new URL(`https://${ADMIN}`);
const credentials = { email: 'Editor@Example.com', password: 'correct horse battery' };

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let auth: Auth;
let app: FastifyInstance;
let siteId: string;

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  ({ db, pool } = createDb(tdb.appUrl));
  const [site] = await db.insert(schema.sites).values({ name: 'Example' }).returning();
  siteId = site!.id;
  await db.insert(schema.siteDomains).values({ domain: 'example.com', siteId, isPrimary: true });
  auth = createAuth({ db, adminUrl, secret: 'test-secret-test-secret-test-secret!' });
  const user = await createPasswordUser(auth, { ...credentials, name: 'Editor' });
  await db.insert(schema.memberships).values({ userId: user.id, siteId, role: 'editor' });
  app = buildApp({ db, sites: await createSiteResolver(db), adminUrl, auth, logLevel: 'silent' });
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await tdb.stop();
});

const signIn = (body: object, host = ADMIN) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { host, origin: `https://${host}`, 'x-forwarded-for': '198.51.100.7' },
    payload: body,
  });

describe('auth', () => {
  it('stores passwords as argon2id', async () => {
    const account = await db.query.accounts.findFirst();
    expect(account?.password).toMatch(/^\$argon2id\$/);
  });

  it('signs in with a host-only, HttpOnly, Secure, SameSite=Strict cookie', async () => {
    const res = await signIn({ email: 'editor@example.com', password: credentials.password });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('token');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/__Secure-better-auth\.session_token=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('returns the user and their sites from /api/me', async () => {
    const login = await signIn({ email: credentials.email, password: credentials.password });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { host: ADMIN, cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user: {
        email: 'editor@example.com',
        name: 'Editor',
        isInstanceOwner: false,
        twoFactorEnabled: false,
      },
      sites: [{ id: siteId, name: 'Example', role: 'editor' }],
    });
  });

  it('rejects wrong passwords and anonymous /api/me', async () => {
    expect(
      (await signIn({ email: credentials.email, password: 'wrong password!' })).statusCode,
    ).toBe(401);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { host: ADMIN } });
    expect(me.statusCode).toBe(401);
  });

  it('does not allow self sign-up', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { host: ADMIN, origin: `https://${ADMIN}` },
      payload: { email: 'new@example.com', password: 'another long password', name: 'New' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(
      await db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, 'new@example.com') }),
    ).toBeUndefined();
  });

  it('rejects requests from other origins', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { host: ADMIN, origin: 'https://example.com' },
      payload: { email: credentials.email, password: credentials.password },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden_origin' });
  });

  it('is not reachable on site origins', async () => {
    expect(
      (await signIn({ email: credentials.email, password: credentials.password }, 'example.com'))
        .statusCode,
    ).toBe(404);
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { host: 'example.com' },
    });
    expect(me.statusCode).toBe(404);
  });

  it('rate limits repeated sign-in attempts', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { host: ADMIN, origin: `https://${ADMIN}`, 'x-forwarded-for': '203.0.113.9' },
        payload: { email: credentials.email, password: 'wrong password!' },
      });
      codes.push(res.statusCode);
    }
    expect(codes).toContain(429);
  });
});
