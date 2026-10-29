// Checks a theme folder or zip against the theme contract, as an upload would:
//   pnpm theme:check themes/my-theme      (in the repo)
//   node dist/validate-theme.js /theme    (in the image)
// Exits 1 when the theme has errors.
import { validateTheme } from '@lithocms/theme-engine';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readThemeZip } from './theme-zip.js';
import { readBundle } from './themes.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: validate-theme <theme folder or .zip>');
  process.exit(2);
}
// `pnpm --filter … exec` runs in the package folder; resolve against where it was called.
const target = resolve(process.env.INIT_CWD ?? process.cwd(), arg);
const bundle = (await stat(target)).isDirectory()
  ? await readBundle(target)
  : await readThemeZip(await readFile(target));
const report = await validateTheme(bundle);
const line = (i: { path: string; line?: number; rule: string; message: string }) =>
  `${i.path || 'theme'}${i.line ? `:${i.line}` : ''}  [${i.rule}] ${i.message}`;
for (const e of report.errors) console.log(`error    ${line(e)}`);
for (const w of report.warnings) console.log(`warning  ${line(w)}`);
console.log(
  report.valid
    ? `OK: the theme is valid (${report.warnings.length} warnings).`
    : `${report.errors.length} errors: fix them before uploading.`,
);
process.exit(report.valid ? 0 : 1);
