import {
  loadPublicSite,
  NotFound,
  renderPublic,
  robotsTxt,
  rssFeed,
  sitemapIndex,
  sitemapPart,
  siteThemeVersion,
  submitForm,
  ValidationFailed,
  withSite,
  type Db,
  type Tx,
} from '@lithocms/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ipHash } from './client-ip.js';
import type { Jobs } from './jobs.js';
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
  {
    db,
    themes,
    adminUrl,
    secret,
    jobs,
  }: {
    db: Db;
    themes: ThemeSet;
    adminUrl: URL;
    secret: string;
    jobs?: Pick<Jobs, 'notifyForm'>;
  },
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
    const params = new URLSearchParams(query);
    // `?s=` is search on the home URL only, as in WordPress.
    const search = path === '/' ? params.get('s') : null;
    const formKey = params.get(FORM_PARAM);
    const formStatus = params.get(FORM_STATUS_PARAM);
    const res = await withSite(db, site.id, (tx) =>
      renderPublic(tx, site.id, theme, {
        path,
        search: search ?? undefined,
        origin: originOf(site),
        secret,
        formStatus:
          formKey && (formStatus === 'sent' || formStatus === 'error')
            ? { key: formKey, status: formStatus }
            : undefined,
      }),
    );
    // Paths become absolute on the site's own origin.
    if ('location' in res) {
      const location = res.location.startsWith('/')
        ? `${originOf(site)}${encodeURI(res.location).replace(/%25([0-9A-F]{2})/gi, '%$1')}`
        : res.location;
      return reply.redirect(location, res.status);
    }
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

  // robots.txt, sitemaps and the feed
  const xmlRoute = (
    url: string,
    type: string,
    make: (
      tx: Tx,
      site: ResolvedSite,
      params: Record<string, string>,
    ) => Promise<string | undefined>,
  ) =>
    app.get(url, async (request, reply) => {
      const site = request.site;
      if (!site) return reply.code(404).send({ error: 'not_found' });
      const body = await withSite(db, site.id, (tx) =>
        make(tx, site, request.params as Record<string, string>),
      );
      if (body === undefined) return reply.code(404).send({ error: 'not_found' });
      return reply
        .type(type)
        .header('cache-control', 'public, max-age=300')
        .header('x-content-type-options', 'nosniff')
        .send(body);
    });
  xmlRoute('/robots.txt', 'text/plain; charset=utf-8', async (tx, site) => {
    const { settings } = await loadPublicSite(tx, site.id);
    return robotsTxt(settings, originOf(site));
  });
  xmlRoute('/sitemap.xml', 'application/xml; charset=utf-8', (tx, site) =>
    sitemapIndex(tx, site.id, originOf(site)),
  );
  xmlRoute('/sitemap-:kind-:n.xml', 'application/xml; charset=utf-8', async (tx, site, p) => {
    const kind = SITEMAP_KINDS.find((k) => k === p.kind);
    const n = Number(p.n);
    if (!kind || !Number.isInteger(n) || n < 1 || n > 10_000) return undefined;
    return sitemapPart(tx, site.id, originOf(site), kind, n);
  });
  for (const url of ['/feed', '/feed/']) {
    xmlRoute(url, 'application/rss+xml; charset=utf-8', (tx, site) =>
      rssFeed(tx, site.id, originOf(site)),
    );
  }
  // Where WordPress and its SEO plugins put them; imported sites are submitted with these.
  for (const url of ['/wp-sitemap.xml', '/sitemap_index.xml']) {
    app.get(url, (request, reply) =>
      request.site
        ? reply.redirect(`${originOf(request.site)}/sitemap.xml`, 301)
        : reply.code(404).send({ error: 'not_found' }),
    );
  }

  // Core-rendered forms post here (no JavaScript needed), then go back to the page they were
  // on with the result. Bot-like posts look like success to the sender.
  void app.register((scope, _opts, done) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 64 * 1024 },
      (_req, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      },
    );
    scope.post('/_forms/:key', async (request, reply) => {
      const site = request.site;
      if (!site) return reply.code(404).send({ error: 'not_found' });
      const { key } = request.params as { key: string };
      const body = (request.body ?? {}) as Record<string, string>;
      let status: 'sent' | 'error' = 'sent';
      try {
        await withSite(db, site.id, async (tx) => {
          const id = await submitForm(tx, site.id, key, body, {
            secret,
            ipHash: ipHash(request, secret),
          });
          if (id) await jobs?.notifyForm(tx, site.id, id);
        });
      } catch (err) {
        if (err instanceof NotFound) return reply.code(404).send({ error: 'not_found' });
        if (!(err instanceof ValidationFailed)) throw err;
        status = 'error';
      }
      const back = new URL(returnPath(request, site), originOf(site));
      back.searchParams.set(FORM_PARAM, key);
      back.searchParams.set(FORM_STATUS_PARAM, status);
      back.hash = `form-${key}`;
      return reply.redirect(back.toString(), 303);
    });
    done();
  });
}

const SITEMAP_KINDS = ['posts', 'pages', 'categories', 'tags'] as const;
const FORM_PARAM = 'litho_form';
const FORM_STATUS_PARAM = 'litho_status';

/** The page the form was on, from Referer, only if it is this site; else the home page. */
function returnPath(request: FastifyRequest, site: ResolvedSite): string {
  try {
    const referer = new URL(request.headers.referer ?? '');
    if (normalizeHost(referer.hostname) !== site.primaryDomain) return '/';
    // Drop an earlier form result from the query.
    referer.searchParams.delete(FORM_PARAM);
    referer.searchParams.delete(FORM_STATUS_PARAM);
    return referer.pathname.startsWith('//') ? '/' : referer.pathname + referer.search;
  } catch {
    return '/';
  }
}
