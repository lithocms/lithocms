import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { sites, themes, themeVersions } from '../db/schema.js';

export type ThemeVersion = typeof themeVersions.$inferSelect;

const RENDERABLE: ThemeVersion['status'][] = ['valid', 'active'];

export interface BundledTheme {
  slug: string;
  name: string;
  version: string;
  manifest: Record<string, unknown>;
  valid: boolean;
  report: unknown;
}

/**
 * Records a theme shipped with the image. Bundled rows have no site, so this must run with
 * the owner role (startup), never with the runtime role.
 */
export async function registerBundledTheme(
  ownerDb: Db,
  theme: BundledTheme,
): Promise<ThemeVersion> {
  return ownerDb.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(themes)
      .where(and(isNull(themes.siteId), eq(themes.slug, theme.slug)));
    const themeRow =
      existing ??
      (
        await tx
          .insert(themes)
          .values({ slug: theme.slug, name: theme.name, origin: 'bundled' })
          .returning()
      )[0]!;
    const values = {
      status: theme.valid ? ('valid' as const) : ('invalid' as const),
      manifest: theme.manifest,
      storagePath: `bundled/${theme.slug}`,
      validationReport: theme.report,
    };
    const [version] = await tx
      .insert(themeVersions)
      .values({ themeId: themeRow.id, version: theme.version, createdVia: 'system', ...values })
      .onConflictDoUpdate({ target: [themeVersions.themeId, themeVersions.version], set: values })
      .returning();
    return version!;
  });
}

/**
 * The theme version a site renders with: its active version, else the newest valid bundled
 * version of the first available slug in `defaults`.
 */
export async function siteThemeVersion(
  tx: Tx,
  siteId: string,
  defaults: string[],
): Promise<ThemeVersion | undefined> {
  const [active] = await tx
    .select({ version: themeVersions })
    .from(sites)
    .innerJoin(themeVersions, eq(themeVersions.id, sites.activeThemeVersionId))
    .where(
      and(
        eq(sites.id, siteId),
        // Never a version that belongs to another site, or one that failed validation.
        or(isNull(themeVersions.siteId), eq(themeVersions.siteId, siteId)),
        inArray(themeVersions.status, RENDERABLE),
      ),
    );
  if (active) return active.version;
  if (!defaults.length) return undefined;
  const candidates = await tx
    .select({ version: themeVersions, slug: themes.slug })
    .from(themeVersions)
    .innerJoin(themes, eq(themes.id, themeVersions.themeId))
    .where(
      and(isNull(themes.siteId), inArray(themes.slug, defaults), eq(themeVersions.status, 'valid')),
    )
    .orderBy(desc(themeVersions.createdAt));
  for (const slug of defaults) {
    const match = candidates.find((c) => c.slug === slug);
    if (match) return match.version;
  }
  return undefined;
}
