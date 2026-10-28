import type { Db } from '@lithocms/core';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { registerApi } from './api.js';
import { registerAuthRoutes, type Auth } from './auth.js';
import { normalizeHost, type ResolvedSite, type SiteResolver } from './sites.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set on site origins; null on the admin origin and internal routes. */
    site: ResolvedSite | null;
  }
}

export interface AppOptions {
  db: Db;
  sites: SiteResolver;
  /** Admin origin; the admin SPA, admin API and auth live only here. */
  adminUrl: URL;
  auth: Auth;
  /** Same secret as auth; also keys the audit log's IP hashes. */
  secret: string;
  logLevel?: string;
}

// Answer on any host: container healthchecks and Caddy call them by IP or service name.
// TODO(phase-4): keep /internal/* and health routes off the public origins at the proxy.
const INTERNAL_ROUTES = new Set(['/healthz', '/readyz']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function buildApp({
  db,
  sites,
  adminUrl,
  auth,
  secret,
  logLevel = 'info',
}: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: logLevel },
    genReqId: () => randomUUID(),
  });

  app.decorateRequest('site', null);

  app.addHook('onRequest', async (request, reply) => {
    if (INTERNAL_ROUTES.has(request.routeOptions.url ?? '')) return;
    const host = normalizeHost(request.hostname);
    if (host === adminUrl.hostname) {
      request.log = request.log.child({ origin: 'admin' });
      // CSRF: admin API writes only from the admin SPA itself (on top of SameSite=Strict).
      const write = !SAFE_METHODS.has(request.method) && request.url.startsWith('/api/');
      if (write && request.headers.origin !== adminUrl.origin) {
        return reply.code(403).send({ error: 'forbidden_origin' });
      }
      return;
    }
    const site = sites.resolve(host);
    // A disabled site is indistinguishable from an unknown host; /api/* exists only on the
    // admin origin.
    if (!site || site.status === 'disabled' || request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'unknown_host' });
    }
    // TODO(phase-1): theme-rendered maintenance page; let logged-in admins preview.
    if (site.status === 'maintenance') {
      return reply.code(503).header('retry-after', '3600').send({ error: 'maintenance' });
    }
    request.site = site;
    request.log = request.log.child({ siteId: site.id });
  });

  app.get('/healthz', () => ({ status: 'ok' }));

  // Migrations run before the server listens, so a reachable DB means ready.
  // TODO(phase-1): include the job queue.
  app.get('/readyz', async (_request, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: 'ok' };
    } catch (err) {
      app.log.warn({ err }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  registerAuthRoutes(app, { auth, db });
  registerApi(app, { db, auth, secret });

  // TODO(phase-1): replace with theme rendering (site origins) and the admin SPA (admin origin).
  app.get('/', (request) =>
    request.site ? { site: { id: request.site.id, name: request.site.name } } : { admin: true },
  );

  return app;
}
