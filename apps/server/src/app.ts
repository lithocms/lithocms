import type { Db } from '@lithocms/core';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
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
  adminDomain: string;
  logLevel?: string;
}

// Answer on any host: container healthchecks and Caddy call them by IP or service name.
// TODO(phase-4): keep /internal/* and health routes off the public origins at the proxy.
const INTERNAL_ROUTES = new Set(['/healthz', '/readyz']);

export function buildApp({
  db,
  sites,
  adminDomain,
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
    if (host === adminDomain) {
      request.log = request.log.child({ origin: 'admin' });
      return;
    }
    const site = sites.resolve(host);
    if (!site) return reply.code(404).send({ error: 'unknown_host' });
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

  // TODO(phase-1): replace with theme rendering (site origins) and the admin SPA (admin origin).
  app.get('/', (request) =>
    request.site ? { site: { id: request.site.id, name: request.site.name } } : { admin: true },
  );

  return app;
}
