import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Where media files live. Disk for now; an S3-compatible store can implement the same shape. */
export interface MediaStore {
  put(key: string, data: Buffer): Promise<void>;
  /** A stream of the file, or null if there is none. */
  open(key: string): Promise<{ stream: ReadStream; size: number } | null>;
}

/** Keys are relative paths like `<siteId>/2026/10/<uuid>.webp`; nothing escapes `root`. */
export function createDiskStore(root: string): MediaStore {
  const base = resolve(root);
  const pathOf = (key: string) => {
    const full = resolve(base, key);
    if (!full.startsWith(base + sep)) throw new Error(`Invalid media key: ${key}`);
    return full;
  };
  return {
    async put(key, data) {
      const full = pathOf(key);
      await mkdir(dirname(full), { recursive: true });
      // Write then rename, so readers never see a half-written file.
      const tmp = join(dirname(full), `.${randomUUID()}.tmp`);
      await writeFile(tmp, data);
      await rename(tmp, full);
    },
    async open(key) {
      const full = pathOf(key);
      const info = await stat(full).catch(() => null);
      if (!info?.isFile()) return null;
      return { stream: createReadStream(full), size: info.size };
    },
  };
}
