import { cachedIds, findCached, storeCached, withSite, type Db } from '@lithocms/core';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Rendered pages on disk, one file per cache entry: `<dir>/<site id>/<entry id>.html`. Entries
// and their tags are rows (core `public/cache.ts`); a purge deletes rows, and `sweep` removes
// the files no row points at any more.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PageCache {
  get(siteId: string, path: string): Promise<string | undefined>;
  put(
    siteId: string,
    path: string,
    html: string,
    meta: { tags: string[]; version: number },
  ): Promise<void>;
  /** Deletes files of purged or expired entries. */
  sweep(): Promise<void>;
}

export function createPageCache(dir: string, db: Db): PageCache {
  const file = (siteId: string, id: string) => join(dir, siteId, `${id}.html`);
  return {
    async get(siteId, path) {
      const id = await withSite(db, siteId, (tx) => findCached(tx, siteId, path));
      // A row whose file is not written yet (or failed to write) is a miss.
      return id && readFile(file(siteId, id), 'utf8').catch(() => undefined);
    },
    async put(siteId, path, html, { tags, version }) {
      const id = await withSite(db, siteId, (tx) => storeCached(tx, siteId, path, version, tags));
      if (!id) return;
      await mkdir(join(dir, siteId), { recursive: true });
      // Readers never see a half-written file.
      const tmp = join(dir, siteId, `.${randomUUID()}.tmp`);
      await writeFile(tmp, html);
      await rename(tmp, file(siteId, id));
    },
    async sweep() {
      const siteDirs = await readdir(dir).catch(() => []);
      for (const siteId of siteDirs.filter((d) => UUID.test(d))) {
        const live = await withSite(db, siteId, (tx) => cachedIds(tx, siteId));
        for (const name of await readdir(join(dir, siteId))) {
          const path = join(dir, siteId, name);
          if (live.has(name.replace(/\.html$/, ''))) continue;
          // Leave files that a store may be about to point at.
          const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: Date.now() }));
          if (Date.now() - mtimeMs > 60_000) await rm(path, { force: true });
        }
      }
    },
  };
}
