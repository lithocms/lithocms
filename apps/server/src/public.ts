import { renderPublic, siteThemeVersion, withSite, type Db } from '@lithocms/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { normalizeHost, type ResolvedSite } from './sites.js';
import type { LoadedTheme, ThemeSet } from './themes.js';

const ASSET_TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ico: 'image/x-icon',
};

// Themes may load from hosts in the site's allowlist; inline scripts never run.
function contentSecurityPolicy(allow: string[]): string {
  const hosts = allow.map((h) => `https://${h}`).join(' ');
  const src = (base: string) => `${base}${hosts ? ` ${hosts}` : ''}`;
  return [
    "default-src 'self'",
    src("script-src 'self'"),
    src("style-src 'self' 'unsafe-inline'"),
    src("img-src 'self' data:"),
    src("font-src 'self'"),
    src("connect-src 'self'"),
    hosts ? `frame-src ${hosts}` : "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/** Theme-rendered pages and theme assets, on site origins only. */
export function registerPublic(
  app: FastifyInstance,
  { db, themes, adminUrl }: { db: Db; themes: ThemeSet; adminUrl: URL },
) {
  const originOf = (site: ResolvedSite) =>
    `${adminUrl.protocol}//${site.primaryDomain}${adminUrl.port ? `:${adminUrl.port}` : ''}`;

  const themeFor = (siteId: string): Promise<LoadedTheme | undefined> =>
    withSite(db, siteId, async (tx) => {
      const version = await siteThemeVersion(tx, siteId, themes.defaults);
      return version && themes.get(version.storagePath);
    });

  app.get('/assets/:hash/*', async (request, reply) => {
    const { hash, '*': path } = request.params as { hash: string; '*': string };
    const theme = request.site && (await themeFor(request.site.id));
    const asset = theme?.assets.get(path);
    const type = ASSET_TYPES[path.split('.').pop() ?? ''];
    if (!asset || asset.hash !== hash || !type) return reply.code(404).send({ error: 'not_found' });
    return reply
      .type(type)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .send(asset.data);
  });

  const page = async (request: FastifyRequest, reply: FastifyReply) => {
    const site = request.site;
    if (!site) return reply.code(404).send({ error: 'not_found' });
    const [path = '/', query = ''] = request.url.split('?', 2);
    if (normalizeHost(request.hostname) !== site.primaryDomain) {
      return reply.redirect(`${originOf(site)}${request.url}`, 301);
    }
    const theme = await themeFor(site.id);
    if (!theme) {
      request.log.error('no renderable theme for site');
      return reply.code(503).type('text/plain').send('This site has no theme yet.');
    }
    // `?s=` is search on the home URL only, as in WordPress.
    const search = path === '/' ? new URLSearchParams(query).get('s') : null;
    const res = await withSite(db, site.id, (tx) =>
      renderPublic(tx, site.id, theme, {
        path,
        search: search ?? undefined,
        origin: originOf(site),
      }),
    );
    if (res.status === 301) return reply.redirect(res.location, 301);
    return reply
      .code(res.status)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'public, max-age=0, must-revalidate')
      .header('content-security-policy', contentSecurityPolicy(site.cspAllowlist))
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'strict-origin-when-cross-origin')
      .send(res.html);
  };

  app.get('/', page);
  app.get('/*', page);
}
