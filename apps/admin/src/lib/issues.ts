import type { Issue } from './api';

/** Validation messages for the field at `index` of a `fields` list (paths may be strings). */
export const fieldError = (issues: Issue[], index: number) =>
  issues
    .filter((i) => i.path[0] === 'fields' && String(i.path[1]) === String(index))
    .map((i) => i.message)
    .join(' ') || undefined;

/** Messages not about one field, joined. */
export const otherIssues = (issues: Issue[]) =>
  issues
    .filter((i) => i.path[0] !== 'fields' || i.path.length < 2)
    .map((i) => i.message)
    .join(' ');
