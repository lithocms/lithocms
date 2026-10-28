import { Drop } from 'liquidjs';

/**
 * HTML that core has already sanitized or generated (post content, slots, core-rendered
 * forms). Output as-is; every other value is escaped. Any filter applied to it turns it
 * back into a plain string, which is escaped again.
 */
export class SafeHtml extends Drop {
  constructor(readonly html: string) {
    super();
  }
  override valueOf(): string {
    return this.html;
  }
  override toString(): string {
    return this.html;
  }
}

export const safe = (html: string): SafeHtml => new SafeHtml(html);

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Text content of an HTML fragment, whitespace collapsed. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
