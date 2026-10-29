import { registerBundledTheme, type Db, type PublicTheme } from '@lithocms/core';
import {
  createThemeEngine,
  ThemeManifest,
  validateTheme,
  type ThemeBundle,
  type ThemeFiles,
} from '@lithocms/theme-engine';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { TEXT_FILE } from './theme-zip.js';

export interface ThemeAsset {
  data: Buffer;
  /** Content fingerprint used in the URL. */
  hash: string;
}

export interface LoadedTheme extends Omit<PublicTheme, 'themeId'> {
  /** Files under `assets/`, keyed by their path inside it. */
  assets: Map<string, ThemeAsset>;
}

/** Theme versions this process can render, by `theme_versions.storage_path`. */
export interface ThemeSet {
  /** Bundled slugs to fall back to, in order, when a site has no active theme. */
  defaults: string[];
  /** The starter theme's README: the theme authoring guide served to MCP clients. */
  authoringGuide: string;
  get(storagePath: string): Promise<LoadedTheme | undefined>;
  /** The files of a version (bundled or uploaded). */
  files(storagePath: string): Promise<ThemeBundle | undefined>;
  /** Stores a validated uploaded bundle for a site; returns its storage path. */
  save(siteId: string, bundle: ThemeBundle): Promise<string>;
  /** Removes an uploaded version's files (after its row is gone or replaced). */
  remove(storagePath: string): Promise<void>;
}

// Uploaded versions loaded from disk stay in memory; this many at most.
const LOADED_UPLOADS = 50;

/** Builds a renderable theme from its files (the bundle must already be valid). */
export function loadTheme(bundle: ThemeBundle): LoadedTheme {
  const text: ThemeFiles = {};
  const assets = new Map<string, ThemeAsset>();
  for (const [path, content] of Object.entries(bundle)) {
    if (typeof content === 'string') text[path] = content;
    if (path.startsWith('assets/')) {
      const data = Buffer.from(content);
      const hash = createHash('sha256').update(data).digest('hex').slice(0, 12);
      assets.set(path.slice('assets/'.length), { data, hash });
    }
  }
  return {
    engine: createThemeEngine(text),
    manifest: ThemeManifest.parse(JSON.parse(text['theme.json'] ?? '{}')),
    assets,
    assetUrl: (path) => `/assets/${assets.get(path)?.hash ?? 'missing'}/${path}`,
  };
}

/**
 * Reads, validates and registers the themes shipped in `dir` (one folder per theme). Invalid
 * themes are recorded as such and skipped. Uses the owner role: bundled rows have no site.
 * Themes uploaded for a site are read from `storeDir` when first used.
 */
export async function loadBundledThemes(
  dir: string,
  ownerDb: Db,
  defaults: string[],
  log: FastifyBaseLogger,
  storeDir: string,
): Promise<ThemeSet> {
  const loaded = new Map<string, LoadedTheme>();
  const bundles = new Map<string, ThemeBundle>();
  let authoringGuide = 'The theme authoring guide ships with the starter theme, which is missing.';
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const bundle = await readBundle(join(dir, entry.name));
    const report = await validateTheme(bundle);
    const manifest = ThemeManifest.safeParse(JSON.parse(String(bundle['theme.json'] ?? '{}')));
    if (!manifest.success || manifest.data.slug !== entry.name) {
      log.error({ theme: entry.name }, 'bundled theme has no valid theme.json for its folder');
      continue;
    }
    const version = await registerBundledTheme(ownerDb, {
      slug: manifest.data.slug,
      name: manifest.data.name,
      version: manifest.data.version,
      manifest: manifest.data,
      valid: report.valid,
      report,
    });
    if (!report.valid) {
      log.error({ theme: entry.name, errors: report.errors }, 'bundled theme is invalid');
      continue;
    }
    loaded.set(version.storagePath, loadTheme(bundle));
    bundles.set(version.storagePath, bundle);
    if (entry.name === 'starter' && typeof bundle['README.md'] === 'string') {
      authoringGuide = bundle['README.md'];
    }
  }
  log.info({ themes: [...loaded.keys()] }, 'bundled themes loaded');
  return { defaults, authoringGuide, ...uploadedThemes(storeDir, loaded, bundles) };
}

/** Uploaded versions live under `storeDir` as `sites/<siteId>/<random>/`. */
function uploadedThemes(
  storeDir: string,
  bundled: Map<string, LoadedTheme>,
  bundledFiles: Map<string, ThemeBundle>,
): Omit<ThemeSet, 'defaults' | 'authoringGuide'> {
  const root = resolve(storeDir);
  const uploads = new Map<string, LoadedTheme>();
  const dirOf = (storagePath: string) => {
    const dir = resolve(root, storagePath);
    if (!storagePath.startsWith('sites/') || !dir.startsWith(root + sep)) return undefined;
    return dir;
  };
  const files = async (storagePath: string) => {
    const bundle = bundledFiles.get(storagePath);
    if (bundle) return bundle;
    const dir = dirOf(storagePath);
    return dir ? readBundle(dir).catch(() => undefined) : undefined;
  };
  return {
    files,
    get: async (storagePath) => {
      const theme = bundled.get(storagePath) ?? uploads.get(storagePath);
      if (theme) return theme;
      const bundle = await files(storagePath);
      if (!bundle) return undefined;
      const loaded = loadTheme(bundle);
      if (uploads.size >= LOADED_UPLOADS) uploads.delete(uploads.keys().next().value!);
      uploads.set(storagePath, loaded);
      return loaded;
    },
    save: async (siteId, bundle) => {
      const storagePath = `sites/${siteId}/${randomUUID()}`;
      const dir = dirOf(storagePath)!;
      for (const [path, content] of Object.entries(bundle)) {
        const target = resolve(dir, path);
        if (!target.startsWith(dir + sep)) throw new Error(`Unsafe theme path: ${path}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      return storagePath;
    },
    remove: async (storagePath) => {
      uploads.delete(storagePath);
      const dir = dirOf(storagePath);
      if (dir) await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function readBundle(root: string): Promise<ThemeBundle> {
  const bundle: ThemeBundle = {};
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const full = join(entry.parentPath, entry.name);
    const path = relative(root, full).split(sep).join('/');
    const data = await readFile(full);
    bundle[path] = TEXT_FILE.test(path) ? data.toString('utf8') : new Uint8Array(data);
  }
  return bundle;
}
