import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { audit, type Actor } from '../content/audit.js';
import type { Tx } from '../db/client.js';
import { sites, themes, themeVersions } from '../db/schema.js';
import { Conflict, Forbidden, NotFound } from '../errors.js';
import { can } from '../permissions.js';
import type { ThemeVersion } from './registry.js';

// A site's theme library: the bundled themes plus the ones uploaded for it, which version is
// active, and the switch between them. The files live outside the database (`storagePath`);
// the server reads and writes them, this module only keeps the records.

export interface LibraryVersion {
  id: string;
  version: string;
  status: ThemeVersion['status'];
  createdAt: Date;
}

export interface LibraryTheme {
  id: string;
  slug: string;
  name: string;
  origin: (typeof themes.$inferSelect)['origin'];
  versions: LibraryVersion[];
}

export interface ThemeLibrary {
  themes: LibraryTheme[];
  /** Null = the instance default (see `siteThemeVersion`). */
  activeVersionId: string | null;
  /** What `theme_rollback` returns to; null = the instance default. */
  previousVersionId: string | null;
}

function assertThemeManager(actor: Actor) {
  if (!can(actor.role, 'theme.manage')) throw new Forbidden('Only admins can manage themes');
}

const visible = (siteId: string) => or(isNull(themes.siteId), eq(themes.siteId, siteId));

export async function listThemeLibrary(tx: Tx, siteId: string): Promise<ThemeLibrary> {
  const rows = await tx
    .select({ theme: themes, version: themeVersions })
    .from(themes)
    .innerJoin(themeVersions, eq(themeVersions.themeId, themes.id))
    .where(visible(siteId))
    .orderBy(asc(themes.name), desc(themeVersions.createdAt));
  const byId = new Map<string, LibraryTheme>();
  for (const { theme, version } of rows) {
    const entry = byId.get(theme.id) ?? {
      id: theme.id,
      slug: theme.slug,
      name: theme.name,
      origin: theme.origin,
      versions: [],
    };
    entry.versions.push({
      id: version.id,
      version: version.version,
      status: version.status,
      createdAt: version.createdAt,
    });
    byId.set(theme.id, entry);
  }
  const [site] = await tx
    .select({ active: sites.activeThemeVersionId, previous: sites.previousThemeVersionId })
    .from(sites)
    .where(eq(sites.id, siteId));
  if (!site) throw new NotFound('Site not found');
  return {
    themes: [...byId.values()],
    activeVersionId: site.active,
    previousVersionId: site.previous,
  };
}

/** A version the site may use (bundled or its own), with its theme's slug. */
export async function getThemeVersion(
  tx: Tx,
  siteId: string,
  versionId: string,
): Promise<ThemeVersion & { slug: string }> {
  const [row] = await tx
    .select({ version: themeVersions, slug: themes.slug })
    .from(themeVersions)
    .innerJoin(themes, eq(themes.id, themeVersions.themeId))
    .where(and(eq(themeVersions.id, versionId), visible(siteId)));
  if (!row) throw new NotFound('Theme version not found');
  return { ...row.version, slug: row.slug };
}

export interface UploadedTheme {
  slug: string;
  name: string;
  version: string;
  manifest: Record<string, unknown>;
  report: unknown;
  storagePath: string;
  /** False keeps a draft that does not validate yet (MCP); it cannot be previewed or activated. */
  valid?: boolean;
  origin?: 'upload' | 'mcp';
}

/**
 * Records a site theme version. Saving a version that already exists replaces its files,
 * unless the site is using it. Returns the version and the storage path it replaced, if any.
 */
export async function recordUploadedTheme(
  tx: Tx,
  siteId: string,
  actor: Actor,
  upload: UploadedTheme,
): Promise<{ version: ThemeVersion; replacedPath: string | null }> {
  assertThemeManager(actor);
  const [existing] = await tx
    .select()
    .from(themes)
    .where(and(eq(themes.siteId, siteId), eq(themes.slug, upload.slug)));
  const theme =
    existing ??
    (
      await tx
        .insert(themes)
        .values({ siteId, slug: upload.slug, name: upload.name, origin: upload.origin ?? 'upload' })
        .returning()
    )[0]!;
  if (existing && existing.name !== upload.name) {
    await tx.update(themes).set({ name: upload.name }).where(eq(themes.id, theme.id));
  }
  const [previous] = await tx
    .select()
    .from(themeVersions)
    .where(and(eq(themeVersions.themeId, theme.id), eq(themeVersions.version, upload.version)));
  if (previous) {
    const [site] = await tx
      .select({ active: sites.activeThemeVersionId })
      .from(sites)
      .where(eq(sites.id, siteId));
    if (site?.active === previous.id) {
      throw new Conflict(
        `Version ${upload.version} is live; raise "version" in theme.json to upload a change`,
      );
    }
  }
  const values = {
    status: upload.valid === false ? ('invalid' as const) : ('valid' as const),
    manifest: upload.manifest,
    storagePath: upload.storagePath,
    validationReport: upload.report,
    createdBy: actor.userId,
    createdVia: actor.channel,
  };
  const [version] = previous
    ? await tx
        .update(themeVersions)
        .set(values)
        .where(eq(themeVersions.id, previous.id))
        .returning()
    : await tx
        .insert(themeVersions)
        .values({ siteId, themeId: theme.id, version: upload.version, ...values })
        .returning();
  await audit(tx, siteId, actor, {
    action: previous ? 'theme.replace' : 'theme.upload',
    entityType: 'theme_version',
    entityId: version!.id,
    diff: { slug: upload.slug, version: upload.version },
  });
  return { version: version!, replacedPath: previous?.storagePath ?? null };
}

async function switchTo(tx: Tx, siteId: string, actor: Actor, versionId: string | null) {
  const [site] = await tx
    .select({ active: sites.activeThemeVersionId })
    .from(sites)
    .where(eq(sites.id, siteId))
    .for('update');
  if (!site) throw new NotFound('Site not found');
  await tx
    .update(sites)
    .set({ activeThemeVersionId: versionId, previousThemeVersionId: site.active })
    .where(eq(sites.id, siteId));
  // The whole site renders differently: `theme` entities purge every cached page.
  await audit(tx, siteId, actor, {
    action: 'theme.activate',
    entityType: 'theme',
    entityId: versionId ?? siteId,
    diff: { from: site.active, to: versionId },
  });
}

export async function activateTheme(
  tx: Tx,
  siteId: string,
  actor: Actor,
  versionId: string,
): Promise<ThemeLibrary> {
  assertThemeManager(actor);
  const version = await getThemeVersion(tx, siteId, versionId);
  if (version.status !== 'valid' && version.status !== 'active') {
    throw new Conflict('Only a valid theme can be activated');
  }
  await switchTo(tx, siteId, actor, versionId);
  return listThemeLibrary(tx, siteId);
}

/** Reactivates the version that was live before the last activation (and swaps them). */
export async function rollbackTheme(tx: Tx, siteId: string, actor: Actor): Promise<ThemeLibrary> {
  assertThemeManager(actor);
  const library = await listThemeLibrary(tx, siteId);
  if (library.previousVersionId === library.activeVersionId) {
    throw new Conflict('There is no previous theme to return to');
  }
  if (library.previousVersionId) {
    const previous = await getThemeVersion(tx, siteId, library.previousVersionId);
    if (previous.status !== 'valid' && previous.status !== 'active') {
      throw new Conflict('The previous theme can no longer be used');
    }
  }
  await switchTo(tx, siteId, actor, library.previousVersionId);
  return listThemeLibrary(tx, siteId);
}

/**
 * Deletes an uploaded theme with all its versions; never a bundled one or the one in use.
 * Returns the storage paths whose files the caller removes after commit.
 */
export async function deleteTheme(
  tx: Tx,
  siteId: string,
  actor: Actor,
  themeId: string,
): Promise<string[]> {
  assertThemeManager(actor);
  const [theme] = await tx
    .select()
    .from(themes)
    .where(and(eq(themes.id, themeId), eq(themes.siteId, siteId)));
  if (!theme) throw new NotFound('Theme not found');
  const versions = await tx
    .select({ id: themeVersions.id, storagePath: themeVersions.storagePath })
    .from(themeVersions)
    .where(eq(themeVersions.themeId, themeId));
  const [inUse] = await tx
    .select({ id: sites.id })
    .from(sites)
    .where(
      and(
        eq(sites.id, siteId),
        inArray(
          sites.activeThemeVersionId,
          versions.map((v) => v.id),
        ),
      ),
    );
  if (inUse) throw new Conflict('Activate another theme before deleting this one');
  await tx.delete(themes).where(eq(themes.id, themeId));
  await audit(tx, siteId, actor, {
    action: 'theme.delete',
    entityType: 'theme_package',
    entityId: themeId,
    diff: { slug: theme.slug },
  });
  return versions.map((v) => v.storagePath);
}
