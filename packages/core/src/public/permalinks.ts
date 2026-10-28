import { z } from 'zod';

// URL patterns per site, WordPress-compatible so imported sites keep their URLs.
// Tokens: post → :year :month :day :slug :category :id; page → :path; category → :path;
// tag → :slug; pagination → :n; archive → :year :month.

const Pattern = (tokens: string[]) =>
  z
    .string()
    .max(200)
    .regex(/^\/(?:[a-z0-9_-]+\/|:[a-z]+\/)*$/, 'Use /segments/ and :tokens/ ending with a slash')
    .refine(
      (p) => [...p.matchAll(/:([a-z]+)/g)].every((m) => tokens.includes(m[1]!)),
      `Allowed tokens: ${tokens.map((t) => `:${t}`).join(', ')}`,
    );

export const Permalinks = z.strictObject({
  post: Pattern(['year', 'month', 'day', 'slug', 'category', 'id']).refine(
    (p) => p.includes(':slug') || p.includes(':id'),
    'A post URL needs :slug or :id',
  ),
  page: Pattern(['path']).refine((p) => p.includes(':path'), 'A page URL needs :path'),
  category: Pattern(['path']).refine(
    (p) => /^\/[a-z0-9_-]+\/:path\/$/.test(p),
    'Use /prefix/:path/',
  ),
  tag: Pattern(['slug']).refine((p) => /^\/[a-z0-9_-]+\/:slug\/$/.test(p), 'Use /prefix/:slug/'),
  pagination: Pattern(['n']).refine((p) => /^\/[a-z0-9_-]+\/:n\/$/.test(p), 'Use /prefix/:n/'),
  archive: Pattern(['year', 'month']),
});
export type Permalinks = z.infer<typeof Permalinks>;

/** WordPress defaults (pretty permalinks, "post name"), with localized prefixes. */
export function defaultPermalinks(locale: string): Permalinks {
  const tr = locale.startsWith('tr');
  return {
    post: '/:slug/',
    page: '/:path/',
    category: tr ? '/kategori/:path/' : '/category/:path/',
    tag: tr ? '/etiket/:slug/' : '/tag/:slug/',
    pagination: '/page/:n/',
    archive: '/:year/:month/',
  };
}

export interface PostUrlParts {
  id: string;
  slug: string;
  publishedAt: Date | null;
  /** Primary category path, e.g. `news/world`. */
  category: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

function fill(pattern: string, values: Record<string, string>): string {
  return pattern.replace(/:([a-z]+)/g, (_, token: string) => values[token] ?? '');
}

export function postUrl(p: Permalinks, post: PostUrlParts, timezone: string): string {
  const date = dateParts(post.publishedAt ?? new Date(), timezone);
  return fill(p.post, {
    ...date,
    slug: post.slug,
    id: post.id,
    category: post.category ?? 'uncategorized',
  });
}

export const pageUrl = (p: Permalinks, path: string) => fill(p.page, { path });
export const categoryUrl = (p: Permalinks, path: string) => fill(p.category, { path });
export const tagUrl = (p: Permalinks, slug: string) => fill(p.tag, { slug });
export const archiveUrl = (p: Permalinks, year: number, month: number) =>
  fill(p.archive, { year: String(year), month: pad(month) });

/** `/news/` + page 3 → `/news/page/3/`; page 1 is the base URL itself. */
export function paginatedUrl(p: Permalinks, base: string, n: number): string {
  return n <= 1 ? base : `${base.replace(/\/$/, '')}${fill(p.pagination, { n: String(n) })}`;
}

function dateParts(date: Date, timezone: string): Record<'year' | 'month' | 'day', string> {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return { year: parts.year!, month: parts.month!, day: parts.day! };
}

// --- matching -------------------------------------------------------------------------------

const SEGMENT: Record<string, string> = {
  year: '(\\d{4})',
  month: '(\\d{2})',
  day: '(\\d{2})',
  n: '(\\d+)',
  id: '([0-9a-f-]{36})',
  // Decoded paths: imported WordPress slugs may contain non-ASCII letters.
  slug: '([\\p{Ll}\\p{Lo}\\p{N}_-]+)',
  path: '([\\p{Ll}\\p{Lo}\\p{N}_-]+(?:/[\\p{Ll}\\p{Lo}\\p{N}_-]+)*)',
  category: '([\\p{Ll}\\p{Lo}\\p{N}_-]+(?:/[\\p{Ll}\\p{Lo}\\p{N}_-]+)*)',
};

/** Matches `path` against a pattern and returns its token values. */
export function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const tokens: string[] = [];
  const source = pattern
    .split(/(:[a-z]+)/)
    .map((part) => {
      if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      tokens.push(part.slice(1));
      return SEGMENT[part.slice(1)] ?? '([^/]+)';
    })
    .join('');
  const match = new RegExp(`^${source}$`, 'u').exec(path);
  if (!match) return null;
  return Object.fromEntries(tokens.map((t, i) => [t, match[i + 1]!]));
}

/** Splits a trailing pagination segment off: `/news/page/2/` → `['/news/', 2]`. */
export function splitPagination(p: Permalinks, path: string): [string, number] {
  const suffix = p.pagination.replace(':n', '(\\d+)').replace(/\//g, '\\/');
  const match = new RegExp(`^(.*?)${suffix}$`).exec(path);
  if (!match) return [path, 1];
  return [match[1] ? `${match[1]}/` : '/', Number(match[2])];
}

export { dateParts as permalinkDateParts };
