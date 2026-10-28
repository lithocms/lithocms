const TURKISH: Record<string, string> = { ı: 'i', İ: 'i', ş: 's', Ş: 's', ğ: 'g', Ğ: 'g' };

/** URL slug from a title: lowercase ASCII words joined by `-`. */
export function slugify(text: string): string {
  return (
    text
      .replace(/[ıİşŞğĞ]/g, (c) => TURKISH[c] ?? c)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100)
      .replace(/-+$/, '') || 'untitled'
  );
}

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
