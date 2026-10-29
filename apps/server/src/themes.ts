import { registerBundledTheme, type Db, type PublicTheme } from '@lithocms/core';
import {
  createThemeEngine,
  ThemeManifest,
  validateTheme,
  type ThemeBundle,
  type ThemeFiles,
} from '@lithocms/theme-engine';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

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
  get(storagePath: string): LoadedTheme | undefined;
}

const TEXT = /\.(liquid|json|css|js|svg)$/;

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
 */
export async function loadBundledThemes(
  dir: string,
  ownerDb: Db,
  defaults: string[],
  log: FastifyBaseLogger,
): Promise<ThemeSet> {
  const loaded = new Map<string, LoadedTheme>();
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
  }
  log.info({ themes: [...loaded.keys()] }, 'bundled themes loaded');
  return { defaults, get: (path) => loaded.get(path) };
}

async function readBundle(root: string): Promise<ThemeBundle> {
  const bundle: ThemeBundle = {};
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const full = join(entry.parentPath, entry.name);
    const path = relative(root, full).split(sep).join('/');
    const data = await readFile(full);
    bundle[path] = TEXT.test(path) ? data.toString('utf8') : new Uint8Array(data);
  }
  return bundle;
}
