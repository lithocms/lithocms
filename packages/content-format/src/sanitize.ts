import sanitize from 'sanitize-html';

/** Hosts content may embed in iframes. Mirrors the default CSP `frame-src`. */
export const EMBED_HOSTS = ['www.youtube-nocookie.com', 'player.vimeo.com'];

const OPTIONS: sanitize.IOptions = {
  allowedTags: [
    ...['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code'],
    ...['strong', 'em', 's', 'a', 'sup', 'ul', 'ol', 'li', 'input', 'section', 'aside', 'div'],
    ...['figure', 'figcaption', 'img', 'iframe', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  ],
  allowedAttributes: {
    '*': ['class', 'id', 'data-litho-form', 'data-litho-collection', 'data-limit'],
    a: ['href', 'rel', 'role'],
    ol: ['start'],
    aside: ['role'],
    input: ['type', 'checked', 'disabled'],
    img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding'],
    iframe: ['src', 'title', 'loading', 'allow', 'allowfullscreen', 'referrerpolicy'],
    th: ['style'],
    td: ['style'],
  },
  allowedStyles: { '*': { 'text-align': [/^(left|center|right)$/] } },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  allowedIframeHostnames: EMBED_HOSTS,
  allowIframeRelativeUrls: false,
  disallowedTagsMode: 'discard',
};

/**
 * Allowlist HTML sanitizer. Last line of defence for rendered post content, and the
 * only path for imported HTML (`legacyHtml`, TODO(phase-3)).
 */
export function sanitizeHtml(html: string): string {
  return sanitize(html, OPTIONS);
}
