import type { Db } from '@lithocms/core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pino } from 'pino';
import { loadBundledThemes, type ThemeSet } from '../themes.js';

/** A minimal valid theme for server tests. */
export const TEST_THEME: Record<string, string> = {
  'theme.json': JSON.stringify({ name: 'Test', slug: 'test', version: '1.0.0' }),
  'layouts/base.liquid':
    '<!doctype html><html lang="{{ site.locale }}"><head>{% seo %}' +
    '<link rel="stylesheet" href="{{ \'style.css\' | asset_url }}">{% head_extras %}</head>' +
    '<body>{{ content_for_layout }}{% slot "footer" %}{% body_extras %}</body></html>',
  'templates/index.liquid':
    '<h1>{{ site.name }}</h1>{% for p in posts %}<a href="{{ p.url }}">{{ p.title }}</a>{% endfor %}',
  'templates/post.liquid': '<h1>{{ post.title }}</h1>{{ post.content }}',
  'templates/page.liquid': '<h1>{{ page.title }}</h1>{{ page.content }}{% form "contact" %}',
  'templates/category.liquid': '<h1>{{ term.name }}</h1>',
  'templates/search.liquid': '<h1>{{ search.terms }}</h1>',
  'templates/404.liquid': '<h1>Not found</h1>',
  'assets/style.css': 'body { margin: 0 }',
};

export const NO_THEMES: ThemeSet = {
  defaults: [],
  authoringGuide: '',
  get: () => Promise.resolve(undefined),
  files: () => Promise.resolve(undefined),
  save: () => Promise.reject(new Error('no theme store')),
  remove: () => Promise.resolve(),
};

/**
 * Writes `TEST_THEME` (plus `extra` themes) to a folder and loads it like a real install;
 * uploads go to a temporary store.
 */
export async function testThemes(
  ownerDb: Db,
  extra: Record<string, Record<string, string>> = {},
): Promise<ThemeSet> {
  const dir = await mkdtemp(join(tmpdir(), 'litho-themes-'));
  for (const [slug, files] of Object.entries({ test: TEST_THEME, ...extra })) {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, slug, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
  }
  const store = await mkdtemp(join(tmpdir(), 'litho-theme-store-'));
  const themes = await loadBundledThemes(dir, ownerDb, ['test'], pino({ level: 'silent' }), store);
  await rm(dir, { recursive: true, force: true });
  return themes;
}
