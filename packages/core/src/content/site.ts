import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../db/client.js';
import { media, sites } from '../db/schema.js';
import { mediaUrl } from '../media/media.js';
import { Forbidden, NotFound } from '../errors.js';
import { can } from '../permissions.js';
import { audit, type Actor } from './audit.js';

// The general settings of a site (admin "Settings" page). Name, locale and timezone are columns;
// the rest lives in `sites.settings`, next to keys other features own (left untouched here).

const TimeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown time zone');

const HttpsUrl = z.url({ protocol: /^https?$/ }).max(500);

export const SiteSettingsInput = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    tagline: z.string().trim().max(300),
    locale: z.enum(['tr', 'en']),
    timezone: TimeZone,
    logo: z.uuid().nullable(),
    /** The browser tab icon (favicon), a square image. */
    icon: z.uuid().nullable(),
    social: z
      .record(z.string().regex(/^[a-z0-9_-]{1,30}$/), HttpsUrl)
      .refine((v) => Object.keys(v).length <= 20, 'At most 20 social links'),
    postsPerPage: z.int().min(1).max(100),
    searchEngines: z.boolean(),
  })
  .partial();
export type SiteSettingsInput = z.output<typeof SiteSettingsInput>;

export interface SiteSettings {
  name: string;
  tagline: string;
  locale: string;
  timezone: string;
  logo: string | null;
  icon: string | null;
  social: Record<string, string>;
  postsPerPage: number | null;
  searchEngines: boolean;
}

export async function getSiteSettings(tx: Tx, siteId: string): Promise<SiteSettings> {
  const [site] = await tx.select().from(sites).where(eq(sites.id, siteId));
  if (!site) throw new NotFound('Site not found');
  const s = site.settings;
  return {
    name: site.name,
    tagline: typeof s.tagline === 'string' ? s.tagline : '',
    locale: site.locale,
    timezone: site.timezone,
    logo: typeof s.logo === 'string' ? s.logo : null,
    icon: typeof s.icon === 'string' ? s.icon : null,
    social:
      typeof s.social === 'object' && s.social !== null ? (s.social as Record<string, string>) : {},
    postsPerPage: typeof s.posts_per_page === 'number' ? s.posts_per_page : null,
    searchEngines: s.search_engines !== false,
  };
}

export async function updateSiteSettings(
  tx: Tx,
  siteId: string,
  actor: Actor,
  input: SiteSettingsInput,
): Promise<SiteSettings> {
  if (!can(actor.role, 'settings.manage')) throw new Forbidden('Only admins can change settings');
  const [site] = await tx.select().from(sites).where(eq(sites.id, siteId)).for('update');
  if (!site) throw new NotFound('Site not found');
  const settings = { ...site.settings };
  const set = (key: string, value: unknown) => {
    if (value !== undefined) settings[key] = value;
  };
  set('tagline', input.tagline);
  set('logo', input.logo);
  set('icon', input.icon);
  set('social', input.social);
  set('posts_per_page', input.postsPerPage);
  set('search_engines', input.searchEngines);
  await tx
    .update(sites)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      settings,
      updatedAt: new Date(),
    })
    .where(eq(sites.id, siteId));
  await audit(tx, siteId, actor, {
    action: 'site.settings.update',
    entityType: 'site',
    entityId: siteId,
    diff: { changed: Object.keys(input).sort() },
  });
  return getSiteSettings(tx, siteId);
}

/** Where the site's icon is served, if one is set and still exists. */
export async function siteIconUrl(tx: Tx, siteId: string): Promise<string | null> {
  const { icon } = await getSiteSettings(tx, siteId);
  if (!icon) return null;
  const [row] = await tx
    .select({ path: media.path })
    .from(media)
    .where(and(eq(media.siteId, siteId), eq(media.id, icon)));
  return row ? mediaUrl(row.path) : null;
}
