import { describe, expect, it } from 'vitest';
import {
  defaultPermalinks,
  matchPattern,
  paginatedUrl,
  Permalinks,
  postUrl,
  splitPagination,
} from './permalinks.js';

const tr = defaultPermalinks('tr');
const post = {
  id: '0190d6c2-0000-7000-8000-000000000001',
  slug: 'merhaba',
  publishedAt: new Date('2026-01-31T22:30:00Z'),
  category: 'haber/dunya',
};

describe('permalinks', () => {
  it('uses localized WordPress defaults', () => {
    expect(tr).toMatchObject({ category: '/kategori/:path/', tag: '/etiket/:slug/' });
    expect(defaultPermalinks('en').category).toBe('/category/:path/');
  });

  it.each([
    ['/:slug/', '/merhaba/'],
    // Dates are in the site's timezone: 22:30 UTC on Jan 31 is Feb 1 in Istanbul.
    ['/:year/:month/:day/:slug/', '/2026/02/01/merhaba/'],
    ['/:category/:slug/', '/haber/dunya/merhaba/'],
    ['/archives/:id/', `/archives/${post.id}/`],
  ])('builds post URLs for %s', (pattern, url) => {
    expect(postUrl({ ...tr, post: pattern }, post, 'Europe/Istanbul')).toBe(url);
  });

  it('matches patterns, including non-ASCII slugs', () => {
    expect(matchPattern('/:year/:month/:slug/', '/2026/02/çay-saati/')).toEqual({
      year: '2026',
      month: '02',
      slug: 'çay-saati',
    });
    expect(matchPattern('/kategori/:path/', '/kategori/haber/dunya/')).toEqual({
      path: 'haber/dunya',
    });
    expect(matchPattern('/:slug/', '/a/b/')).toBeNull();
    expect(matchPattern('/:slug/', '/Upper/')).toBeNull();
  });

  it('splits and builds pagination', () => {
    expect(splitPagination(tr, '/kategori/haber/page/3/')).toEqual(['/kategori/haber/', 3]);
    expect(splitPagination(tr, '/page/2/')).toEqual(['/', 2]);
    expect(splitPagination(tr, '/hakkimizda/')).toEqual(['/hakkimizda/', 1]);
    expect(paginatedUrl(tr, '/kategori/haber/', 3)).toBe('/kategori/haber/page/3/');
    expect(paginatedUrl(tr, '/', 1)).toBe('/');
  });

  it.each([
    { post: '/no-token/' },
    { post: '/:slug/:evil/' },
    { category: '/:path/' },
    { page: '/x/' },
    { post: '/:slug' },
    { post: '/:category/:category/:slug/' },
  ])('rejects invalid patterns %o', (change) => {
    expect(Permalinks.safeParse({ ...tr, ...change }).success).toBe(false);
  });

  it('stays fast on long hostile paths', () => {
    const path = `/${'a/'.repeat(500)}!/`;
    const start = performance.now();
    expect(matchPattern('/:category/:slug/', path)).toBeNull();
    expect(matchPattern('/:path/', `/${'a'.repeat(5000)}/`)).toBeNull();
    expect(performance.now() - start).toBeLessThan(50);
  });
});
