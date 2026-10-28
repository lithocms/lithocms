import type { BlockContent, ListItem, PhrasingContent, Root, RootContent, TableRow } from 'mdast';
import { directiveToMarkdown } from 'mdast-util-directive';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import type { Block, Doc, Inline, Mark, Paragraph, TextNode } from './schema.js';

/** Serializes a document to the same Markdown dialect `markdownToDoc` reads. */
export function docToMarkdown(doc: Doc): string {
  const root: Root = { type: 'root', children: doc.content.map(block) };
  return toMarkdown(root, {
    extensions: [gfmToMarkdown(), directiveToMarkdown()],
    bullet: '-',
    emphasis: '_',
    rule: '-',
    fences: true,
  });
}

function block(node: Block): RootContent {
  switch (node.type) {
    case 'paragraph':
      return { type: 'paragraph', children: inline(node.content) };
    case 'heading':
      return { type: 'heading', depth: node.attrs.level, children: inline(node.content) };
    case 'blockquote':
      return { type: 'blockquote', children: node.content.map(block) as BlockContent[] };
    case 'bulletList':
    case 'orderedList':
      return {
        type: 'list',
        ordered: node.type === 'orderedList',
        start: node.type === 'orderedList' ? node.attrs.start : null,
        spread: false,
        children: node.content.map((item) => listItem(item.content, null)),
      };
    case 'taskList':
      return {
        type: 'list',
        ordered: false,
        spread: false,
        children: node.content.map((item) => listItem(item.content, item.attrs.checked)),
      };
    case 'codeBlock':
      return { type: 'code', lang: node.attrs.language, value: node.content?.[0].text ?? '' };
    case 'horizontalRule':
      return { type: 'thematicBreak' };
    case 'image':
      return {
        type: 'paragraph',
        children: [
          {
            type: 'image',
            url: `media:${node.attrs.mediaId}`,
            alt: node.attrs.alt,
            title: node.attrs.title,
          },
        ],
      };
    case 'table':
      return {
        type: 'table',
        align: node.content[0]?.content.map((cell) => cell.attrs.align) ?? [],
        children: node.content.map((row): TableRow => ({
          type: 'tableRow',
          children: row.content.map((cell) => ({
            type: 'tableCell',
            children: cellInline(cell.content),
          })),
        })),
      };
    case 'youtube':
    case 'vimeo':
      return leaf(node.type, { id: node.attrs.id });
    case 'gallery':
      return leaf('gallery', { ids: node.attrs.ids.join(',') });
    case 'button':
      return leaf('button', { href: node.attrs.href, style: node.attrs.style }, node.attrs.label);
    case 'form':
      return leaf('form', { key: node.attrs.key });
    case 'collection':
      return leaf('collection', {
        key: node.attrs.key,
        ...(node.attrs.limit == null ? {} : { limit: String(node.attrs.limit) }),
      });
    case 'callout':
      return {
        type: 'containerDirective',
        name: 'callout',
        attributes: { type: node.attrs.type },
        children: node.content.map(block) as BlockContent[],
      };
    case 'footnoteDefinition':
      return {
        type: 'footnoteDefinition',
        identifier: node.attrs.id,
        label: node.attrs.id,
        children: node.content.map(block) as BlockContent[],
      };
  }
}

function listItem(content: Block[], checked: boolean | null): ListItem {
  return {
    type: 'listItem',
    spread: false,
    checked,
    children: content.map(block) as BlockContent[],
  };
}

function leaf(name: string, attributes: Record<string, string>, label?: string): RootContent {
  return {
    type: 'leafDirective',
    name,
    attributes,
    children: label ? [{ type: 'text', value: label }] : [],
  };
}

/** GFM cells hold one line: multiple paragraphs are joined with line breaks. */
function cellInline(paragraphs: Paragraph[]): PhrasingContent[] {
  return paragraphs.flatMap((p, i): PhrasingContent[] => [
    ...(i ? [{ type: 'break' as const }] : []),
    ...inline(p.content),
  ]);
}

// Marks are applied outermost-first in this order, grouping neighbours that share a mark
// so `**a _b_**` does not come out as `**a** **_b_**`.
const WRAP_ORDER: Mark['type'][] = ['link', 'bold', 'italic', 'strike'];

function inline(nodes: Inline[] = []): PhrasingContent[] {
  return wrap(nodes, WRAP_ORDER);
}

function wrap(nodes: Inline[], order: Mark['type'][]): PhrasingContent[] {
  const [markType, ...rest] = order;
  if (!markType) return nodes.map(leafInline);

  const out: PhrasingContent[] = [];
  let i = 0;
  while (i < nodes.length) {
    const mark = markOf(nodes[i], markType);
    if (!mark) {
      let j = i;
      while (j < nodes.length && !markOf(nodes[j], markType)) j++;
      out.push(...wrap(nodes.slice(i, j), rest));
      i = j;
      continue;
    }
    let j = i;
    while (j < nodes.length && sameMark(markOf(nodes[j], markType), mark)) j++;
    const children = wrap(
      nodes.slice(i, j).map((n) => without(n, markType)),
      rest,
    );
    out.push(wrapIn(mark, children));
    i = j;
  }
  return out;
}

function markOf(node: Inline | undefined, type: Mark['type']): Mark | undefined {
  return node?.type === 'text' ? node.marks?.find((m) => m.type === type) : undefined;
}

function sameMark(a: Mark | undefined, b: Mark): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

function without(node: Inline, type: Mark['type']): Inline {
  if (node.type !== 'text') return node;
  return { ...node, marks: node.marks?.filter((m) => m.type !== type) };
}

function wrapIn(mark: Mark, children: PhrasingContent[]): PhrasingContent {
  switch (mark.type) {
    case 'link':
      return { type: 'link', url: mark.attrs.href, children };
    case 'bold':
      return { type: 'strong', children };
    case 'italic':
      return { type: 'emphasis', children };
    default:
      return { type: 'delete', children };
  }
}

function leafInline(node: Inline): PhrasingContent {
  switch (node.type) {
    case 'text':
      return isCode(node)
        ? { type: 'inlineCode', value: node.text }
        : { type: 'text', value: node.text };
    case 'hardBreak':
      return { type: 'break' };
    case 'footnoteReference':
      return { type: 'footnoteReference', identifier: node.attrs.id, label: node.attrs.id };
  }
}

function isCode(node: TextNode): boolean {
  return node.marks?.some((m) => m.type === 'code') ?? false;
}
