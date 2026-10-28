import type { Role } from './db/schema.js';

const ALL: Role[] = ['owner', 'admin', 'editor', 'author'];
const EDITOR: Role[] = ['owner', 'admin', 'editor'];
const ADMIN: Role[] = ['owner', 'admin'];
const OWNER: Role[] = ['owner'];

/** The role matrix from DATA_MODEL.md. */
const MATRIX = {
  'post.write_own': ALL,
  'post.write_any': EDITOR,
  'post.publish': EDITOR,
  'comment.moderate': EDITOR,
  'media.manage': EDITOR,
  'menu.manage': EDITOR,
  'collection.manage': EDITOR,
  'term.manage': EDITOR,
  'theme.manage': ADMIN,
  'slot.manage': ADMIN,
  'redirect.manage': ADMIN,
  'form.manage': ADMIN,
  'settings.manage': ADMIN,
  'user.manage': ADMIN,
  'site.delete': OWNER,
  'domain.manage': OWNER,
  'site.transfer': OWNER,
} satisfies Record<string, Role[]>;

export type Capability = keyof typeof MATRIX;

export function can(role: Role, capability: Capability): boolean {
  return MATRIX[capability].includes(role);
}
