import type { Element, ElementContent, Properties } from 'hast';
import { toHtml } from 'hast-util-to-html';
import { sanitizeHtml } from './sanitize.js';
import type { Block, Doc, Inline, Mark } from './schema.js';

export interface RenderedImage {
  src: string;
  width?: number;
  height?: number;
  srcset?: string;
  sizes?: string;
}

/** Looks up what the document only references by id. Unknown ids are left out of the output. */
export interface RenderContext {
  media(id: string): RenderedImage | undefined;
  postUrl(id: string): string | undefined;
}

/**
 * Renders a validated document to HTML. Built as a hast tree, so text and attributes are
 * escaped by construction, then passed through the allowlist sanitizer as a second line.
 * Forms and collections become placeholders the page renderer fills in.
 */
export function renderHtml(doc: Doc, ctx: RenderContext): string {
  const notes = doc.content.filter((b) => b.type === 'footnoteDefinition');
  const body = doc.content
    .filter((b) => b.type !== 'footnoteDefinition')
    .flatMap((b) => block(b, ctx));
  if (notes.length) {
    body.push(
      el('section', { className: ['footnotes'] }, [
        el(
          'ol',
          {},
          notes.map((n) =>
            el('li', { id: `fn-${n.attrs.id}` }, [
              ...n.content.flatMap((b) => block(b, ctx)),
              el('a', { href: `#fnref-${n.attrs.id}`, className: ['footnote-back'] }, [text('↩')]),
            ]),
          ),
        ),
      ]),
    );
  }
  return sanitizeHtml(toHtml(body));
}

function el(tagName: string, properties: Properties, children: ElementContent[] = []): Element {
  return { type: 'element', tagName, properties, children };
}

function text(value: string): ElementContent {
  return { type: 'text', value };
}

function block(node: Block, ctx: RenderContext): Element[] {
  const blocks = (content: Block[]) => content.flatMap((b) => block(b, ctx));
  switch (node.type) {
    case 'paragraph':
      return [el('p', {}, inline(node.content, ctx))];
    case 'heading':
      return [el(`h${node.attrs.level}`, {}, inline(node.content, ctx))];
    case 'blockquote':
      return [el('blockquote', {}, blocks(node.content))];
    case 'bulletList':
      return [
        el(
          'ul',
          {},
          node.content.map((i) => el('li', {}, blocks(i.content))),
        ),
      ];
    case 'orderedList':
      return [
        el(
          'ol',
          node.attrs.start === 1 ? {} : { start: node.attrs.start },
          node.content.map((i) => el('li', {}, blocks(i.content))),
        ),
      ];
    case 'taskList':
      return [
        el(
          'ul',
          { className: ['task-list'] },
          node.content.map((i) =>
            el('li', { className: ['task-item'] }, [
              el('input', { type: 'checkbox', disabled: true, checked: i.attrs.checked }),
              ...blocks(i.content),
            ]),
          ),
        ),
      ];
    case 'codeBlock':
      return [
        el('pre', {}, [
          el(
            'code',
            node.attrs.language ? { className: [`language-${node.attrs.language}`] } : {},
            [text(node.content?.[0].text ?? '')],
          ),
        ]),
      ];
    case 'horizontalRule':
      return [el('hr', {})];
    case 'image': {
      const img = image(node.attrs.mediaId, node.attrs.alt, ctx);
      if (!img) return [];
      const caption = node.attrs.title ? [el('figcaption', {}, [text(node.attrs.title)])] : [];
      return [el('figure', {}, [img, ...caption])];
    }
    case 'table': {
      const [head, ...rows] = node.content;
      const row = (r: (typeof node.content)[number]) =>
        el(
          'tr',
          {},
          r.content.map((cell) =>
            el(
              cell.type === 'tableHeader' ? 'th' : 'td',
              cell.attrs.align ? { style: `text-align: ${cell.attrs.align}` } : {},
              cell.content.flatMap((p, i) => [
                ...(i ? [el('br', {})] : []),
                ...inline(p.content, ctx),
              ]),
            ),
          ),
        );
      return [
        el('table', {}, [
          ...(head ? [el('thead', {}, [row(head)])] : []),
          ...(rows.length ? [el('tbody', {}, rows.map(row))] : []),
        ]),
      ];
    }
    case 'youtube':
      return [
        embed(
          'youtube',
          `https://www.youtube-nocookie.com/embed/${node.attrs.id}`,
          'YouTube video',
        ),
      ];
    case 'vimeo':
      return [
        embed('vimeo', `https://player.vimeo.com/video/${node.attrs.id}?dnt=1`, 'Vimeo video'),
      ];
    case 'callout':
      return [
        el(
          'aside',
          { className: ['callout', `callout-${node.attrs.type}`], role: 'note' },
          blocks(node.content),
        ),
      ];
    case 'gallery':
      return [
        el(
          'div',
          { className: ['gallery'] },
          node.attrs.ids.flatMap((id) => {
            const img = image(id, '', ctx);
            return img ? [el('figure', {}, [img])] : [];
          }),
        ),
      ];
    case 'button': {
      const href = resolveHref(node.attrs.href, ctx);
      if (!href) return [];
      return [
        el('p', {}, [
          el('a', { href, className: ['button', `button-${node.attrs.style}`], role: 'button' }, [
            text(node.attrs.label),
          ]),
        ]),
      ];
    }
    case 'form':
      return [el('div', { dataLithoForm: node.attrs.key })];
    case 'collection':
      return [
        el('div', {
          dataLithoCollection: node.attrs.key,
          ...(node.attrs.limit ? { dataLimit: node.attrs.limit } : {}),
        }),
      ];
    case 'footnoteDefinition':
      return []; // collected at the end of the document
  }
}

function embed(kind: string, src: string, title: string): Element {
  return el('div', { className: ['embed', `embed-${kind}`] }, [
    el('iframe', {
      src,
      title,
      loading: 'lazy',
      allow: 'encrypted-media; picture-in-picture; fullscreen',
      allowFullScreen: true,
      referrerPolicy: 'strict-origin-when-cross-origin',
    }),
  ]);
}

function image(id: string, alt: string, ctx: RenderContext): Element | undefined {
  const media = ctx.media(id);
  if (!media) return undefined;
  return el('img', {
    src: media.src,
    alt,
    ...(media.srcset ? { srcSet: media.srcset } : {}),
    ...(media.sizes ? { sizes: media.sizes } : {}),
    ...(media.width ? { width: media.width } : {}),
    ...(media.height ? { height: media.height } : {}),
    loading: 'lazy',
    decoding: 'async',
  });
}

function resolveHref(href: string, ctx: RenderContext): string | undefined {
  return href.startsWith('post:') ? ctx.postUrl(href.slice(5)) : href;
}

// Same nesting order as the Markdown writer: link outermost, code innermost.
const ORDER: Mark['type'][] = ['link', 'bold', 'italic', 'strike', 'code'];

function inline(nodes: Inline[] = [], ctx: RenderContext): ElementContent[] {
  return nodes.map((node): ElementContent => {
    switch (node.type) {
      case 'hardBreak':
        return el('br', {});
      case 'footnoteReference':
        return el('sup', { id: `fnref-${node.attrs.id}` }, [
          el('a', { href: `#fn-${node.attrs.id}`, className: ['footnote-ref'] }, [
            text(node.attrs.id),
          ]),
        ]);
      case 'text': {
        const marks = [...(node.marks ?? [])].sort(
          (a, b) => ORDER.indexOf(b.type) - ORDER.indexOf(a.type),
        );
        return marks.reduce<ElementContent>(
          (child, mark) => wrap(mark, child, ctx),
          text(node.text),
        );
      }
    }
  });
}

function wrap(mark: Mark, child: ElementContent, ctx: RenderContext): ElementContent {
  switch (mark.type) {
    case 'bold':
      return el('strong', {}, [child]);
    case 'italic':
      return el('em', {}, [child]);
    case 'strike':
      return el('s', {}, [child]);
    case 'code':
      return el('code', {}, [child]);
    case 'link': {
      const href = resolveHref(mark.attrs.href, ctx);
      if (!href) return child; // link to a deleted post: keep the text
      const props: Properties = { href };
      if (/^https?:/.test(href)) props.rel = ['noopener', 'noreferrer'];
      return el('a', props, [child]);
    }
  }
}
