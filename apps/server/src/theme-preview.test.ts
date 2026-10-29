import { describe, expect, it } from 'vitest';
import {
  PREVIEW_TTL_SECONDS,
  previewToken,
  readPreviewToken,
  withPreviewBar,
} from './theme-preview.js';

const secret = 'test-secret-test-secret-test-secret!';
const site = '0190a6c8-0000-7000-8000-000000000001';
const version = '0190a6c8-0000-7000-8000-000000000002';

describe('theme preview tokens', () => {
  it('are bound to the site, the version and an hour', () => {
    const now = Date.now();
    const token = previewToken(secret, site, version, now);
    expect(readPreviewToken(secret, site, token, now)).toEqual({
      versionId: version,
      seconds: PREVIEW_TTL_SECONDS,
    });
    expect(readPreviewToken(secret, version, token, now)).toBeUndefined();
    expect(readPreviewToken('another-secret-another-secret-12', site, token, now)).toBeUndefined();
    expect(readPreviewToken(secret, site, token, now + PREVIEW_TTL_SECONDS * 1000)).toBeUndefined();
    const [, exp, mac] = token.split('.');
    expect(readPreviewToken(secret, site, `${site}.${exp}.${mac}`, now)).toBeUndefined();
    expect(readPreviewToken(secret, site, 'garbage', now)).toBeUndefined();
  });

  it('marks previewed pages without letting the theme name inject markup', () => {
    const html = withPreviewBar('<body><p>x</p></body>', 'tr', '<script>x</script> 1.0.0');
    expect(html).toContain('Tema önizlemesi: scriptx/script 1.0.0');
    expect(html.indexOf('role="status"')).toBeLessThan(html.indexOf('</body>'));
  });
});
