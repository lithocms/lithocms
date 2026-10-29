import {
  activateTheme,
  Conflict,
  getThemeVersion,
  listThemeLibrary,
  loadThemeSettings,
  NotFound,
  rollbackTheme,
  siteThemeVersion,
  slugify,
  updateThemeSettings,
  ValidationFailed,
  type ThemeVersion,
  type Tx,
} from '@lithocms/core';
import {
  TEXT_FILE,
  type Setting,
  type ThemeBundle,
  type ValidationReport,
} from '@lithocms/theme-engine';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { read, spend, write, type McpContext } from './context.js';
import { tool } from './result.js';

// Tools for the `design` scope (MCP_SPEC.md). A site's own theme versions can be edited until
// they are live; each save is validated, and only a valid version can be previewed or activated.
// Changing `slug` or `version` in theme.json saves the files as that theme/version instead.

const Id = z.uuid();
const DryRun = z.boolean().optional().describe('Validate and report without saving anything');
/** Theme-relative paths only: no dotfiles, no `..`, no absolute paths. */
const Path = z
  .string()
  .max(200)
  .regex(/^(?!.*\.\.)[a-zA-Z0-9_][\w./-]*$/, 'Use a path like templates/index.liquid');
const File = z.object({ path: Path, content: z.string().max(2_000_000) });
const MAX_FILES = 300;
const MAX_TOTAL = 10 * 1024 * 1024;

const size = (c: string | Uint8Array) =>
  typeof c === 'string' ? Buffer.byteLength(c) : c.byteLength;

function report(r: ValidationReport) {
  return { valid: r.valid, errors: r.errors, warnings: r.warnings };
}

export function registerDesignTools(server: McpServer, ctx: McpContext): void {
  const versionOf = (tx: Tx, id: string) => getThemeVersion(tx, ctx.siteId, id);
  const filesOf = async (v: ThemeVersion) => {
    const files = await ctx.themes.files(v.storagePath);
    if (!files) throw new NotFound('The theme files are missing');
    return { ...files };
  };
  /** A version Claude may change: the site's own, not bundled. */
  const editable = async (id: string) => {
    const v = await read(ctx, (tx) => versionOf(tx, id));
    if (!v.siteId) {
      throw new Conflict(
        'Bundled themes cannot be changed. Copy it with theme_create_draft(base_theme_version_id).',
      );
    }
    return v;
  };
  const checkSize = (bundle: ThemeBundle) => {
    const values = Object.values(bundle);
    if (values.length > MAX_FILES || values.reduce((n, c) => n + size(c), 0) > MAX_TOTAL) {
      throw new ValidationFailed([
        { path: ['files'], message: `A theme has at most ${MAX_FILES} files and 10 MB` },
      ]);
    }
  };
  const save = async (
    bundle: ThemeBundle,
    draft: { slug: string; name: string; version: string },
    dryRun = false,
  ) => {
    checkSize(bundle);
    if (dryRun) return { dry_run: true, ...report(await ctx.themes.validate(ctx.siteId, bundle)) };
    spend(ctx);
    const saved = await ctx.themes.save(ctx.siteId, ctx.actor, bundle, draft);
    return {
      theme_version_id: saved.version.id,
      version: saved.version.version,
      status: saved.version.status,
      ...report(saved.report),
      next: saved.report.valid
        ? 'Valid. Call theme_preview to look at it, then theme_activate to make it live.'
        : 'Not valid yet. Fix the errors with theme_update_files.',
    };
  };
  const identity = (v: ThemeVersion) => {
    const m = v.manifest as { slug?: string; name?: string };
    return { slug: m.slug ?? 'theme', name: m.name ?? 'Theme', version: v.version };
  };
  const listing = (bundle: ThemeBundle) =>
    Object.entries(bundle)
      .map(([path, c]) => ({ path, bytes: size(c), text: typeof c === 'string' }))
      .sort((a, b) => a.path.localeCompare(b.path));

  server.registerTool(
    'theme_list',
    {
      description:
        'Themes available to this site (bundled and its own), their versions and status, and which one is live.',
      annotations: { readOnlyHint: true },
    },
    tool(() =>
      read(ctx, async (tx) => {
        const lib = await listThemeLibrary(tx, ctx.siteId);
        const live = await siteThemeVersion(tx, ctx.siteId, ctx.themeDefaults);
        return {
          live_theme_version_id: live?.id ?? null,
          previous_theme_version_id: lib.previousVersionId,
          themes: lib.themes.map((t) => ({
            slug: t.slug,
            name: t.name,
            origin: t.origin,
            versions: t.versions.map((v) => ({
              theme_version_id: v.id,
              version: v.version,
              status: v.status,
            })),
          })),
        };
      }),
    ),
  );

  server.registerTool(
    'theme_get_files',
    {
      description:
        'Without `paths`: the files of a theme version. With `paths`: their contents (text files only, up to 30).',
      inputSchema: z.object({
        theme_version_id: Id,
        paths: z.array(Path).max(30).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    tool(async (a) => {
      const files = await filesOf(await read(ctx, (tx) => versionOf(tx, a.theme_version_id)));
      if (!a.paths) return { files: listing(files) };
      return {
        files: a.paths.map((path) => {
          const content = Object.hasOwn(files, path) ? files[path] : undefined;
          if (content === undefined) return { path, error: 'not_found' };
          if (typeof content !== 'string') return { path, error: 'binary', bytes: size(content) };
          return { path, content };
        }),
      };
    }),
  );

  server.registerTool(
    'theme_create_draft',
    {
      description:
        'Start a new theme for this site: a copy of `base_theme_version_id`, or of the starter theme. Read guide://theme-authoring first. `files` are written over the copy.',
      inputSchema: z.object({
        name: z.string().trim().min(1).max(100),
        slug: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
          .optional()
          .describe('Derived from the name if left out'),
        base_theme_version_id: Id.optional(),
        files: z.array(File).max(100).optional(),
        dry_run: DryRun,
      }),
    },
    tool(async (a) => {
      const slug = a.slug ?? (slugify(a.name).slice(0, 64) || 'theme');
      const base = await read(ctx, async (tx) => {
        const lib = await listThemeLibrary(tx, ctx.siteId);
        if (lib.themes.some((t) => t.slug === slug && t.origin !== 'bundled')) {
          throw new Conflict(
            `This site already has a theme "${slug}"; change it with theme_update_files`,
          );
        }
        if (a.base_theme_version_id) return versionOf(tx, a.base_theme_version_id);
        const starter = lib.themes.find((t) => t.slug === 'starter' && t.origin === 'bundled');
        const id = starter?.versions[0]?.id;
        if (!id) throw new NotFound('No base theme: pass base_theme_version_id');
        return versionOf(tx, id);
      });
      const bundle = await filesOf(base);
      let manifest: Record<string, unknown> = {};
      try {
        manifest = JSON.parse(String(bundle['theme.json'])) as Record<string, unknown>;
      } catch {
        // the copy's theme.json is rewritten below either way
      }
      bundle['theme.json'] =
        JSON.stringify({ ...manifest, name: a.name, slug, version: '0.1.0' }, null, 2) + '\n';
      for (const f of a.files ?? []) bundle[f.path] = f.content;
      return save(bundle, { slug, name: a.name, version: '0.1.0' }, a.dry_run);
    }),
  );

  server.registerTool(
    'theme_update_files',
    {
      description:
        'Write or delete files of one of the site\'s own theme versions; the result is validated. A live version cannot change: raise "version" in theme.json to save a new one.',
      inputSchema: z.object({
        theme_version_id: Id,
        files: z.array(File).max(100).optional(),
        delete_paths: z.array(Path).max(100).optional(),
        dry_run: DryRun,
      }),
    },
    tool(async (a) => {
      const v = await editable(a.theme_version_id);
      const bundle = await filesOf(v);
      for (const f of a.files ?? []) {
        if (!TEXT_FILE.test(f.path)) {
          throw new ValidationFailed([
            { path: ['files'], message: `${f.path} is binary; use theme_upload_asset` },
          ]);
        }
        bundle[f.path] = f.content;
      }
      for (const path of a.delete_paths ?? []) delete bundle[path];
      return save(bundle, identity(v), a.dry_run);
    }),
  );

  server.registerTool(
    'theme_upload_asset',
    {
      description:
        "Add a binary asset (font, image, icon) under assets/ of one of the site's own theme versions, from base64 or a public URL.",
      inputSchema: z.object({
        theme_version_id: Id,
        path: Path.describe('e.g. assets/fonts/inter.woff2'),
        base64: z.string().max(2_800_000).optional(),
        source_url: z.url({ protocol: /^https?$/ }).optional(),
      }),
    },
    tool(async (a) => {
      if (!a.path.startsWith('assets/')) {
        throw new ValidationFailed([{ path: ['path'], message: 'Assets live under assets/' }]);
      }
      if (!a.base64 === !a.source_url) {
        throw new ValidationFailed([{ path: ['base64'], message: 'Give base64 or source_url' }]);
      }
      const v = await editable(a.theme_version_id);
      let data: Buffer;
      if (a.source_url) {
        const res = await ctx.fetchUrl(a.source_url, 2 * 1024 * 1024).catch((e: Error) => {
          throw new ValidationFailed([
            { path: ['source_url'], message: `Could not fetch it: ${e.message}` },
          ]);
        });
        if (res.status !== 200) {
          throw new ValidationFailed([
            { path: ['source_url'], message: `The URL answered ${res.status}` },
          ]);
        }
        data = res.body;
      } else data = Buffer.from(a.base64!, 'base64');
      const bundle = await filesOf(v);
      bundle[a.path] = TEXT_FILE.test(a.path) ? data.toString('utf8') : new Uint8Array(data);
      return save(bundle, identity(v));
    }),
  );

  server.registerTool(
    'theme_validate',
    {
      description:
        'Check a theme version against the theme rules: errors block activation, warnings do not.',
      inputSchema: z.object({ theme_version_id: Id }),
      annotations: { readOnlyHint: true },
    },
    tool(async (a) => {
      const v = await read(ctx, (tx) => versionOf(tx, a.theme_version_id));
      return report(await ctx.themes.validate(ctx.siteId, await filesOf(v)));
    }),
  );

  server.registerTool(
    'theme_preview',
    {
      description:
        'A link (valid for one hour) that shows the site with a valid theme version; only whoever opens it sees the preview. Give it to the owner.',
      inputSchema: z.object({
        theme_version_id: Id,
        path: z
          .string()
          .regex(/^\/(?!\/)[^\s]*$/)
          .max(500)
          .optional()
          .describe('Where it opens, e.g. / or a post path'),
      }),
      annotations: { readOnlyHint: true },
    },
    tool((a) =>
      read(ctx, async (tx) => ({
        url: await ctx.themes.previewUrl(
          tx,
          ctx.siteId,
          await versionOf(tx, a.theme_version_id),
          a.path,
        ),
      })),
    ),
  );

  server.registerTool(
    'theme_activate',
    {
      description: 'Make a valid theme version live for every visitor. theme_rollback undoes it.',
      inputSchema: z.object({ theme_version_id: Id, dry_run: z.boolean().optional() }),
    },
    tool((a) =>
      write(
        ctx,
        async (tx) => {
          const lib = await activateTheme(tx, ctx.siteId, ctx.actor, a.theme_version_id);
          return {
            active_theme_version_id: lib.activeVersionId,
            previous_theme_version_id: lib.previousVersionId,
          };
        },
        { dryRun: a.dry_run },
      ),
    ),
  );

  server.registerTool(
    'theme_rollback',
    {
      description: 'Make the theme that was live before the last activation live again.',
      inputSchema: z.object({ dry_run: z.boolean().optional() }),
    },
    tool((a) =>
      write(
        ctx,
        async (tx) => {
          const lib = await rollbackTheme(tx, ctx.siteId, ctx.actor);
          return {
            active_theme_version_id: lib.activeVersionId,
            previous_theme_version_id: lib.previousVersionId,
          };
        },
        { dryRun: a.dry_run },
      ),
    ),
  );

  /** The version settings apply to: the given one, else the live one. */
  const settingsTarget = async (tx: Tx, id: string | undefined) => {
    const v = id
      ? await versionOf(tx, id)
      : await siteThemeVersion(tx, ctx.siteId, ctx.themeDefaults);
    if (!v) throw new NotFound('This site has no theme');
    const settings = (v.manifest as { settings?: Setting[] }).settings ?? [];
    return { v, settings };
  };

  server.registerTool(
    'theme_settings_get',
    {
      description:
        "A theme's settings (colours, fonts, options its theme.json declares) and their values on this site. Defaults to the live theme.",
      inputSchema: z.object({ theme_version_id: Id.optional() }),
      annotations: { readOnlyHint: true },
    },
    tool((a) =>
      read(ctx, async (tx) => {
        const { v, settings } = await settingsTarget(tx, a.theme_version_id);
        const stored = await loadThemeSettings(tx, ctx.siteId, v.themeId);
        return { theme_version_id: v.id, settings, values: stored.values };
      }),
    ),
  );

  server.registerTool(
    'theme_settings_update',
    {
      description:
        "Change a theme's setting values on this site (only those given); checked against its settings. Defaults to the live theme.",
      inputSchema: z.object({
        values: z.record(z.string(), z.unknown()),
        theme_version_id: Id.optional(),
        dry_run: z.boolean().optional(),
      }),
    },
    tool((a) =>
      write(
        ctx,
        async (tx) => {
          const { v, settings } = await settingsTarget(tx, a.theme_version_id);
          const stored = await loadThemeSettings(tx, ctx.siteId, v.themeId);
          const values = await updateThemeSettings(tx, ctx.siteId, ctx.actor, v.themeId, settings, {
            ...stored.values,
            ...a.values,
          });
          return { theme_version_id: v.id, values };
        },
        { dryRun: a.dry_run },
      ),
    ),
  );
}
