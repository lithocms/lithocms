import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { buffer } from 'node:stream/consumers';
import { readThemeZip, ThemeZipError, writeThemeZip } from './theme-zip.js';

const zipOf = async (files: Record<string, string | Buffer>) => {
  const zip = new yazl.ZipFile();
  for (const [path, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), path);
  zip.end();
  return buffer(zip.outputStream);
};

describe('theme zips', () => {
  it('round-trips a theme inside a folder', async () => {
    const bundle = { 'theme.json': '{}', 'assets/logo.png': new Uint8Array([1, 2, 3]) };
    const read = await readThemeZip(await writeThemeZip(bundle, 'mine'));
    expect(read['theme.json']).toBe('{}');
    expect(Buffer.from(read['assets/logo.png']!)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('drops dotfiles and macOS metadata, keeps files at the root as they are', async () => {
    const read = await readThemeZip(
      await zipOf({
        'theme.json': '{}',
        '.DS_Store': 'x',
        '__MACOSX/theme.json': 'x',
        'assets/.hidden/a.css': 'x',
        'assets/a.css': 'a{}',
      }),
    );
    expect(Object.keys(read).sort()).toEqual(['assets/a.css', 'theme.json']);
  });

  it('rejects what is not a single theme', async () => {
    await expect(readThemeZip(Buffer.from('nope'))).rejects.toBeInstanceOf(ThemeZipError);
    await expect(
      readThemeZip(await zipOf({ 'a/theme.json': '{}', 'b/x.css': '' })),
    ).rejects.toThrow('theme.json must be at the top');
    await expect(
      readThemeZip(await zipOf({ 'theme.json': '{}', 'assets/big.png': Buffer.alloc(3 << 20) })),
    ).rejects.toThrow('larger than 2 MB');
  });
});
