// Converts between TipTap's JSON and the server's content allowlist (@lithocms/content-format).
// The editor handles the common blocks; anything else (tables, embeds, callouts, footnotes…)
// rides through untouched inside a `preserved` node, so editing never loses content.

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

const EDITABLE_BLOCKS = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'horizontalRule',
  'image',
]);
const EDITABLE_INLINE = new Set(['text', 'hardBreak']);
const MARKS = new Set(['bold', 'italic', 'strike', 'code', 'link']);

/** Server doc → editor doc. `src` resolves an image's media id to a URL for display. */
export function fromDoc(doc: PMNode | null | undefined, src: (mediaId: string) => string): PMNode {
  const walk = (node: PMNode, inline: boolean): PMNode => {
    if (inline ? !EDITABLE_INLINE.has(node.type) : !EDITABLE_BLOCKS.has(node.type)) {
      return {
        type: inline ? 'preservedInline' : 'preservedBlock',
        attrs: { json: JSON.stringify(node) },
      };
    }
    if (node.type === 'image') {
      const mediaId = str(node.attrs?.mediaId);
      return { type: 'image', attrs: { ...node.attrs, src: src(mediaId) } };
    }
    if (!node.content) return node;
    const inlineChildren = ['paragraph', 'heading', 'codeBlock'].includes(node.type);
    return { ...node, content: node.content.map((c) => walk(c, inlineChildren)) };
  };
  const content = (doc?.content ?? []).map((n) => walk(n, false));
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** Editor doc → server doc: only the attributes the allowlist knows. */
export function toDoc(doc: PMNode): PMNode {
  const node = (n: PMNode): PMNode | PMNode[] | null => {
    const kids = () => (n.content ?? []).flatMap((c) => node(c) ?? []);
    switch (n.type) {
      case 'preservedBlock':
      case 'preservedInline':
        return JSON.parse(str(n.attrs?.json)) as PMNode;
      case 'text': {
        const marks = (n.marks ?? [])
          .filter((m) => MARKS.has(m.type))
          .map((m) =>
            m.type === 'link'
              ? { type: 'link', attrs: { href: str(m.attrs?.href) } }
              : { type: m.type },
          );
        return { type: 'text', text: n.text ?? '', ...(marks.length ? { marks } : {}) };
      }
      case 'hardBreak':
      case 'horizontalRule':
        return { type: n.type };
      case 'paragraph': {
        const content = kids();
        return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
      }
      case 'heading': {
        const content = kids();
        return {
          type: 'heading',
          attrs: { level: Number(n.attrs?.level ?? 2) },
          ...(content.length ? { content } : {}),
        };
      }
      case 'blockquote':
      case 'bulletList':
      case 'listItem': {
        const content = kids();
        return content.length ? { type: n.type, content } : null;
      }
      case 'orderedList': {
        const content = kids();
        return content.length
          ? { type: 'orderedList', attrs: { start: Number(n.attrs?.start ?? 1) }, content }
          : null;
      }
      case 'codeBlock': {
        const text = (n.content ?? []).map((c) => c.text ?? '').join('');
        const language =
          typeof n.attrs?.language === 'string' && n.attrs.language ? n.attrs.language : null;
        return {
          type: 'codeBlock',
          attrs: { language },
          ...(text ? { content: [{ type: 'text', text }] } : {}),
        };
      }
      case 'image':
        // Pasted pictures from elsewhere have no media id; upload them instead.
        if (typeof n.attrs?.mediaId !== 'string' || !n.attrs.mediaId) return null;
        return {
          type: 'image',
          attrs: {
            mediaId: String(n.attrs?.mediaId ?? ''),
            alt: typeof n.attrs?.alt === 'string' ? n.attrs.alt : '',
            title: typeof n.attrs?.title === 'string' && n.attrs.title ? n.attrs.title : null,
          },
        };
      default:
        return null;
    }
  };
  const content = (doc.content ?? []).flatMap((n) => node(n) ?? []);
  // A lone empty paragraph is an empty document.
  const empty = content.length === 1 && content[0]!.type === 'paragraph' && !content[0]!.content;
  return { type: 'doc', content: empty ? [] : content };
}

/** Media ids a server doc shows, so their URLs can be loaded before editing. */
export function mediaIds(doc: PMNode | null | undefined): string[] {
  const ids: string[] = [];
  const walk = (n: PMNode) => {
    if (n.type === 'image' && typeof n.attrs?.mediaId === 'string') ids.push(n.attrs.mediaId);
    n.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return [...new Set(ids)];
}
