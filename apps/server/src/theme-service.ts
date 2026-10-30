import {
  NotFound,
  recordUploadedTheme,
  ValidationFailed,
  schema,
  withSite,
  type Actor,
  type Db,
  type ThemeVersion,
  type Tx,
} from '@lithocms/core';
import {
  ThemeManifest,
  validateTheme,
  type ThemeBundle,
  type ValidationReport,
} from '@lithocms/theme-engine';
import { desc, eq } from 'drizzle-orm';
import { hostList } from './sites.js';
import { previewToken } from './theme-preview.js';
import type { ThemeSet } from './themes.js';

/** A theme that does not validate and was not kept as a draft. */
export class ThemeInvalid extends Error {
  override name = 'ThemeInvalid';
  constructor(readonly report: ValidationReport) {
    super('The theme has errors');
  }
}

/** Where a site is served and which hosts its CSP allows. */
export async function publicSite(tx: Tx, siteId: string, adminUrl: URL) {
  const [row] = await tx
    .select({ settings: schema.sites.settings, domain: schema.siteDomains.domain })
    .from(schema.sites)
    .leftJoin(schema.siteDomains, eq(schema.siteDomains.siteId, schema.sites.id))
    .where(eq(schema.sites.id, siteId))
    .orderBy(desc(schema.siteDomains.isPrimary), schema.siteDomains.domain)
    .limit(1);
  const port = adminUrl.port ? `:${adminUrl.port}` : '';
  return {
    origin: row?.domain ? `${adminUrl.protocol}//${row.domain}${port}` : null,
    cspAllowlist: hostList(row?.settings.csp_allowlist),
  };
}

export interface SavedTheme {
  version: ThemeVersion;
  report: ValidationReport;
  replaced: boolean;
}

/** Validating, storing and previewing a site's own theme versions (REST upload and MCP). */
export function createThemeService({
  db,
  themes,
  secret,
  adminUrl,
}: {
  db: Db;
  themes: ThemeSet;
  secret: string;
  adminUrl: URL;
}) {
  const validate = async (siteId: string, bundle: ThemeBundle) => {
    const { cspAllowlist } = await withSite(db, siteId, (tx) => publicSite(tx, siteId, adminUrl));
    return validateTheme(bundle, { cspAllowlist });
  };

  return {
    files: (storagePath: string) => themes.files(storagePath),
    validate,

    /**
     * Validates and stores a version, identified by slug and version in its theme.json. An
     * invalid theme throws `ThemeInvalid`, unless `draft` names what to keep it as.
     */
    async save(
      siteId: string,
      actor: Actor,
      bundle: ThemeBundle,
      draft?: { slug: string; name: string; version: string },
    ): Promise<SavedTheme> {
      const report = await validate(siteId, bundle);
      if (!report.valid && !draft) throw new ThemeInvalid(report);
      let manifest: Record<string, unknown> = {};
      try {
        manifest = JSON.parse(String(bundle['theme.json'])) as Record<string, unknown>;
      } catch {
        // reported by the validator
      }
      const parsed = ThemeManifest.safeParse(manifest);
      const id = parsed.success ? parsed.data : draft!;
      const storagePath = await themes.save(siteId, bundle);
      const recorded = await withSite(db, siteId, (tx) =>
        recordUploadedTheme(tx, siteId, actor, {
          slug: id.slug,
          name: id.name,
          version: id.version,
          manifest: parsed.success ? parsed.data : manifest,
          report,
          storagePath,
          valid: report.valid,
          origin: actor.channel === 'mcp' ? 'mcp' : 'upload',
        }),
      ).catch(async (e: unknown) => {
        await themes.remove(storagePath);
        throw e;
      });
      if (recorded.replacedPath) await themes.remove(recorded.replacedPath);
      return { version: recorded.version, report, replaced: recorded.replacedPath !== null };
    },

    /** A link that shows the site with this version for an hour; `path` is where it opens. */
    async previewUrl(tx: Tx, siteId: string, version: ThemeVersion, path = '/') {
      if (version.status !== 'valid' && version.status !== 'active') {
        throw new ValidationFailed([
          { path: ['id'], message: 'Only a valid theme can be previewed; fix its errors first' },
        ]);
      }
      const { origin } = await publicSite(tx, siteId, adminUrl);
      if (!origin) throw new NotFound('This site has no domain yet');
      const token = encodeURIComponent(previewToken(secret, siteId, version.id));
      const to = path === '/' ? '' : `&path=${encodeURIComponent(path)}`;
      return `${origin}/_preview?token=${token}${to}`;
    },
  };
}

export type ThemeService = ReturnType<typeof createThemeService>;
