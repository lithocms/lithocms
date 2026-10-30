import { TEXT_FILE, type ThemeBundle } from '@lithocms/theme-engine';
import { buffer as readAll } from 'node:stream/consumers';
import yauzl from 'yauzl';
import yazl from 'yazl';

// Checked before anything is decompressed; the validator applies the real limits afterwards.
// yauzl rejects absolute and `..` paths and entries that inflate past their declared size.
const MAX_ENTRIES = 400;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 10 * 1024 * 1024;

export class ThemeZipError extends Error {
  override name = 'ThemeZipError';
}

/** Files of a zipped theme: dotfiles and `__MACOSX/` are dropped, one wrapping folder is removed. */
export async function readThemeZip(data: Buffer): Promise<ThemeBundle> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.fromBufferPromise(data, { lazyEntries: true, strictFileNames: true });
  } catch {
    throw new ThemeZipError('Not a zip file');
  }
  if (zip.entryCount > MAX_ENTRIES) throw new ThemeZipError('The zip has too many files');
  const files: Record<string, Buffer> = {};
  let total = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      if (name.endsWith('/')) continue;
      if (name.split('/').some((part) => part.startsWith('.') || part === '__MACOSX')) continue;
      total += entry.uncompressedSize;
      if (entry.uncompressedSize > MAX_FILE) throw new ThemeZipError(`${name} is larger than 2 MB`);
      if (total > MAX_TOTAL) throw new ThemeZipError('The theme is larger than 10 MB');
      files[name] = await readAll(await zip.openReadStreamPromise(entry));
    }
  } catch (e) {
    throw e instanceof ThemeZipError ? e : new ThemeZipError(`Broken zip: ${(e as Error).message}`);
  } finally {
    zip.close();
  }
  const paths = Object.keys(files);
  const root = paths.includes('theme.json') ? '' : (paths[0]?.split('/')[0] ?? '') + '/';
  const bundle: ThemeBundle = {};
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith(root)) throw new ThemeZipError('theme.json must be at the top of the zip');
    const relative = path.slice(root.length);
    bundle[relative] = TEXT_FILE.test(relative)
      ? content.toString('utf8')
      : new Uint8Array(content);
  }
  return bundle;
}

/** A zip of the theme's files, inside a folder named after the theme. */
export async function writeThemeZip(bundle: ThemeBundle, folder: string): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [path, content] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
    zip.addBuffer(Buffer.from(content), `${folder}/${path}`);
  }
  zip.end();
  return readAll(zip.outputStream);
}
