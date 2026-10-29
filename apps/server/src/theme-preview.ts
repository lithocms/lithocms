import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

// Previewing a theme version before activating it. The admin API signs a link for one site and
// version; the site origin turns it into a cookie so the whole site can be browsed with that
// theme for an hour. The cookie only selects a theme; it carries no admin credentials.

export const PREVIEW_COOKIE = 'litho_theme_preview';
export const PREVIEW_TTL_SECONDS = 3600;

const sign = (secret: string, siteId: string, versionId: string, expires: number) =>
  createHmac('sha256', secret)
    .update(`theme-preview:${siteId}:${versionId}:${expires}`)
    .digest('base64url');

export function previewToken(secret: string, siteId: string, versionId: string, now = Date.now()) {
  const expires = Math.floor(now / 1000) + PREVIEW_TTL_SECONDS;
  return `${versionId}.${expires}.${sign(secret, siteId, versionId, expires)}`;
}

/** The version a token previews on this site, and how long it stays valid; else undefined. */
export function readPreviewToken(
  secret: string,
  siteId: string,
  token: string,
  now = Date.now(),
): { versionId: string; seconds: number } | undefined {
  const [versionId = '', exp = '', mac = ''] = token.split('.');
  const expires = Number(exp);
  const seconds = expires - Math.floor(now / 1000);
  if (!/^[0-9a-f-]{36}$/.test(versionId) || !Number.isInteger(expires) || seconds <= 0) return;
  const expected = Buffer.from(sign(secret, siteId, versionId, expires));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return;
  return { versionId, seconds };
}

/** The preview cookie of a request, if it is valid for the site. */
export function previewOf(request: FastifyRequest, secret: string, siteId: string) {
  const cookie = request.headers.cookie
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${PREVIEW_COOKIE}=`));
  return cookie
    ? readPreviewToken(secret, siteId, cookie.slice(PREVIEW_COOKIE.length + 1))
    : undefined;
}

const BANNER: Record<string, { label: string; exit: string }> = {
  tr: { label: 'Tema önizlemesi', exit: 'Önizlemeden çık' },
  en: { label: 'Theme preview', exit: 'Leave preview' },
};

/** A fixed bar at the bottom of previewed pages, so a preview is never mistaken for the live site. */
export function withPreviewBar(html: string, locale: string, themeName: string): string {
  const t = BANNER[locale] ?? BANNER.en!;
  const name = themeName.replace(/[<>&"']/g, '');
  const bar =
    `<div role="status" style="position:fixed;inset:auto 0 0 0;z-index:2147483647;display:flex;gap:16px;` +
    `justify-content:center;align-items:center;padding:10px 16px;background:#111;color:#fff;` +
    `font:14px/1.4 system-ui,sans-serif">${t.label}: ${name}` +
    `<a href="/_preview?exit=1" style="color:#fff;text-decoration:underline">${t.exit}</a></div>`;
  const at = html.lastIndexOf('</body>');
  return at === -1 ? html + bar : html.slice(0, at) + bar + html.slice(at);
}
