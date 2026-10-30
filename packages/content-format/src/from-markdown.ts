import { ContentFormatError, type Issue } from './errors.js';
import type {
  Definition,
  FootnoteDefinition,
  List,
  Nodes,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from 'mdast';
import type { ContainerDirective, LeafDirective } from 'mdast-util-directive';
import { directiveFromMarkdown } from 'mdast-util-directive';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { directive } from 'micromark-extension-directive';
import { gfm } from 'micromark-extension-gfm';
import { parseDoc, type Doc, type Mark } from './schema.js';

// Shapes are checked by `parseDoc` at the end, so the converter builds plain objects and
// only reports what the schema cannot see (raw HTML, external images, unknown directives).
type Json = Record<string, unknown>;

const MARK_ORDER = ['bold', 'italic', 'strike', 'code', 'link'] as const;

/**
 * Markdown dialect for MCP and imports: CommonMark + GFM (tables, task lists, footnotes,
 * strikethrough) + generic directives. Raw HTML and external images are rejected.
 */
export function markdownToDoc(markdown: string): Doc {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm(), directive()],
    mdastExtensions: [gfmFromMarkdown(), directiveFromMarkdown()],
  });
  return new Converter(markdown, tree).run();
}

class Converter {
  private issues: Issue[] = [];
  private definitions = new Map<string, Definition>();
  private footnotes: FootnoteDefinition[] = [];

  constructor(
    private source: string,
    private tree: Root,
  ) {}

  run(): Doc {
    for (const node of this.tree.children) {
      if (node.type === 'definition') this.definitions.set(node.identifier, node);
    }
    const content = this.blocks(this.tree.children);
    for (const note of this.footnotes) {
      content.push({
        type: 'footnoteDefinition',
        attrs: { id: note.identifier },
        content: this.blocks(note.children),
      });
    }
    if (this.issues.length) throw new ContentFormatError(this.issues);
    return parseDoc({ type: 'doc', content });
  }

  private fail(node: Nodes, message: string): void {
    const line = node.position?.start.line;
    this.issues.push({ path: [], message: line ? `Line ${line}: ${message}` : message });
  }

  private blocks(nodes: RootContent[]): Json[] {
    return nodes.flatMap((node) => this.block(node));
  }

  private block(node: RootContent): Json[] {
    switch (node.type) {
      case 'paragraph':
        return this.paragraph(node.children);
      case 'heading':
        return [
          { type: 'heading', attrs: { level: node.depth }, ...this.inlineContent(node.children) },
        ];
      case 'blockquote':
        return [{ type: 'blockquote', content: this.nonEmpty(this.blocks(node.children)) }];
      case 'list':
        return [this.list(node)];
      case 'code':
        return [
          {
            type: 'codeBlock',
            attrs: { language: node.lang ?? null },
            ...(node.value ? { content: [{ type: 'text', text: node.value }] } : {}),
          },
        ];
      case 'thematicBreak':
        return [{ type: 'horizontalRule' }];
      case 'table':
        return [this.table(node)];
      case 'footnoteDefinition':
        this.footnotes.push(node);
        return [];
      case 'definition':
        return [];
      case 'containerDirective':
      case 'leafDirective':
        return this.directive(node);
      case 'html':
        this.fail(node, 'Raw HTML is not allowed; use Markdown or a directive');
        return [];
      default:
        this.fail(node, `Unsupported block: ${node.type}`);
        return [];
    }
  }

  /** A paragraph of only images becomes image blocks; images mixed with text are an error. */
  private paragraph(children: PhrasingContent[]): Json[] {
    const isImage = (c: PhrasingContent) => c.type === 'image' || c.type === 'imageReference';
    const images = children.filter(isImage);
    const rest = children.filter((c) => !isImage(c));
    if (images.length && rest.every((c) => c.type === 'text' && !c.value.trim())) {
      return images.flatMap((img) => this.image(img));
    }
    return [{ type: 'paragraph', ...this.inlineContent(children) }];
  }

  private image(node: PhrasingContent): Json[] {
    let url: string | undefined;
    let title: string | null | undefined;
    if (node.type === 'image') ({ url, title } = node);
    else if (node.type === 'imageReference')
      ({ url, title } = this.definitions.get(node.identifier) ?? {});
    const alt = 'alt' in node ? (node.alt ?? '') : '';
    if (!url?.startsWith('media:')) {
      this.fail(
        node,
        'Images must reference the media library as media:<id> (upload external images first)',
      );
      return [];
    }
    return [{ type: 'image', attrs: { mediaId: url.slice(6), alt, title: title ?? null } }];
  }

  private list(node: List): Json {
    const isTask = node.children.some((item) => typeof item.checked === 'boolean');
    const content = node.children.map((item) => ({
      type: isTask ? 'taskItem' : 'listItem',
      ...(isTask ? { attrs: { checked: item.checked === true } } : {}),
      content: this.nonEmpty(this.blocks(item.children)),
    }));
    if (isTask) return { type: 'taskList', content };
    return node.ordered
      ? { type: 'orderedList', attrs: { start: node.start ?? 1 }, content }
      : { type: 'bulletList', content };
  }

  private table(node: Table): Json {
    return {
      type: 'table',
      content: node.children.map((row, r) => ({
        type: 'tableRow',
        content: row.children.map((cell, c) => ({
          type: r === 0 ? 'tableHeader' : 'tableCell',
          attrs: { align: node.align?.[c] ?? null },
          content: [{ type: 'paragraph', ...this.inlineContent(cell.children) }],
        })),
      })),
    };
  }

  private directive(node: ContainerDirective | LeafDirective): Json[] {
    const a = node.attributes ?? {};
    const leaf = node.type === 'leafDirective';
    if (leaf) {
      switch (node.name) {
        case 'youtube':
        case 'vimeo':
          return [{ type: node.name, attrs: { id: a.id } }];
        case 'gallery':
          return [
            { type: 'gallery', attrs: { ids: (a.ids ?? '').split(',').map((id) => id.trim()) } },
          ];
        case 'button':
          return [
            {
              type: 'button',
              attrs: { href: a.href, style: a.style ?? 'primary', label: plainText(node.children) },
            },
          ];
        case 'form':
          return [{ type: 'form', attrs: { key: a.key } }];
        case 'collection':
          return [
            {
              type: 'collection',
              attrs: { key: a.key, limit: a.limit == null ? null : Number(a.limit) },
            },
          ];
      }
    } else if (node.name === 'callout') {
      return [
        {
          type: 'callout',
          attrs: { type: a.type ?? 'info' },
          content: this.nonEmpty(this.blocks(node.children)),
        },
      ];
    }
    this.fail(node, `Unknown directive ${leaf ? '::' : ':::'}${node.name}`);
    return [];
  }

  private nonEmpty(blocks: Json[]): Json[] {
    return blocks.length ? blocks : [{ type: 'paragraph' }];
  }

  private inlineContent(children: PhrasingContent[]): { content?: Json[] } {
    const content = mergeText(this.inline(children, []));
    return content.length ? { content } : {};
  }

  private inline(nodes: PhrasingContent[], marks: Mark[]): Json[] {
    return nodes.flatMap((node): Json[] => {
      switch (node.type) {
        case 'text':
          return text(node.value, marks);
        case 'emphasis':
          return this.inline(node.children, [...marks, { type: 'italic' }]);
        case 'strong':
          return this.inline(node.children, [...marks, { type: 'bold' }]);
        case 'delete':
          return this.inline(node.children, [...marks, { type: 'strike' }]);
        case 'inlineCode':
          return text(node.value, [...marks, { type: 'code' }]);
        case 'link':
          return this.inline(node.children, [
            ...marks,
            { type: 'link', attrs: { href: node.url } },
          ]);
        case 'linkReference': {
          const def = this.definitions.get(node.identifier);
          if (!def) return text(this.sourceOf(node), marks);
          return this.inline(node.children, [...marks, { type: 'link', attrs: { href: def.url } }]);
        }
        case 'break':
          return [{ type: 'hardBreak' }];
        case 'footnoteReference':
          return [{ type: 'footnoteReference', attrs: { id: node.identifier } }];
        case 'textDirective':
          // `:name` inside prose ("ratio a:b") is not a directive we support: keep it as text.
          return text(this.sourceOf(node), marks);
        case 'html':
          this.fail(node, 'Raw HTML is not allowed; use Markdown or a directive');
          return [];
        case 'image':
        case 'imageReference':
          this.fail(node, 'Images must be on their own line');
          return [];
      }
    });
  }

  private sourceOf(node: Nodes): string {
    const { start, end } = node.position ?? {};
    return start?.offset != null && end?.offset != null
      ? this.source.slice(start.offset, end.offset)
      : '';
  }
}

function text(value: string, marks: Mark[]): Json[] {
  if (!value) return [];
  const sorted = [...marks].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
  return [{ type: 'text', text: value, ...(sorted.length ? { marks: sorted } : {}) }];
}

/** Joins neighbouring text nodes with identical marks, as ProseMirror does. */
function mergeText(nodes: Json[]): Json[] {
  const out: Json[] = [];
  for (const node of nodes) {
    const prev = out.at(-1);
    if (
      prev?.type === 'text' &&
      node.type === 'text' &&
      JSON.stringify(prev.marks) === JSON.stringify(node.marks)
    ) {
      out[out.length - 1] = { ...prev, text: `${prev.text as string}${node.text as string}` };
    } else {
      out.push(node);
    }
  }
  return out;
}

function plainText(nodes: PhrasingContent[]): string {
  return nodes
    .map((n) => ('value' in n ? n.value : 'children' in n ? plainText(n.children) : ''))
    .join('');
}
