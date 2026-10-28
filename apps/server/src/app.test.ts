import { createDb, runMigrations, schema, type Db } from '@lithocms/core';
import { startTestDatabase, type TestDatabase } from '@lithocms/core/testing';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createSiteResolver, type SiteResolver } from './sites.js';

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let sites: SiteResolver;
let app: FastifyInstance;
let siteId: string;

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  ({ db, pool } = createDb(tdb.appUrl));
  const [site] = await db.insert(schema.sites).values({ name: 'Example' }).returning();
  siteId = site!.id;
  await db.insert(schema.siteDomains).values([
    { domain: 'example.com', siteId, isPrimary: true },
    { domain: 'www.example.com', siteId },
  ]);
  sites = await createSiteResolver(db);
  app = buildApp({ db, sites, adminDomain: 'admin.example.net', logLevel: 'silent' });
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await tdb.stop();
});

const get = (host: string, url = '/') => app.inject({ method: 'GET', url, headers: { host } });

describe('host routing', () => {
  it.each(['example.com', 'www.example.com', 'EXAMPLE.com:8080', 'example.com.'])(
    'resolves %s to its site',
    async (host) => {
      const res = await get(host);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ site: { id: siteId, name: 'Example' } });
    },
  );

  it('returns 404 for unknown hosts', async () => {
    const res = await get('evil.example');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'unknown_host' });
  });

  it('serves the admin origin without a site', async () => {
    const res = await get('admin.example.net');
    expect(res.json()).toEqual({ admin: true });
  });

  it.each([
    ['disabled', 404],
    ['maintenance', 503],
  ] as const)('does not serve %s sites', async (status, code) => {
    const [other] = await db.insert(schema.sites).values({ name: status, status }).returning();
    await db.insert(schema.siteDomains).values({ domain: `${status}.example`, siteId: other!.id });
    await sites.refresh();
    expect((await get(`${status}.example`)).statusCode).toBe(code);
  });

  it('picks up new domains on refresh', async () => {
    await db.insert(schema.siteDomains).values({ domain: 'new.example.com', siteId });
    expect((await get('new.example.com')).statusCode).toBe(404);
    await sites.refresh();
    expect((await get('new.example.com')).statusCode).toBe(200);
  });
});

describe('health', () => {
  it.each(['/healthz', '/readyz'])('%s answers on any host', async (url) => {
    const res = await get('10.0.0.5:3000', `${url}?probe=1`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('/readyz fails when the database is unreachable', async () => {
    const down = createDb(tdb.appUrl);
    await down.pool.end();
    const unready = buildApp({ db: down.db, sites, adminDomain: 'a', logLevel: 'silent' });
    const res = await unready.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    await unready.close();
  });
});
