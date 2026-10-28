import { describe, expect, it } from 'vitest';
import { can } from './permissions.js';

describe('can', () => {
  it.each([
    ['author', 'post.write_own', true],
    ['author', 'post.publish', false],
    ['author', 'media.manage', false],
    ['editor', 'post.write_any', true],
    ['editor', 'theme.manage', false],
    ['admin', 'slot.manage', true],
    ['admin', 'domain.manage', false],
    ['owner', 'site.delete', true],
  ] as const)('%s → %s: %s', (role, capability, expected) => {
    expect(can(role, capability)).toBe(expected);
  });
});
