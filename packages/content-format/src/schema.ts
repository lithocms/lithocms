// The content allowlist: every node, mark and attribute a post body may contain.
// Node names follow TipTap so the admin editor emits this shape directly.
import { ContentFormatError } from './errors.js';
import { z } from 'zod';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** http(s), mailto, tel, `post:<id>`, site-relative path or #anchor. */
export function isAllowedHref(href: string): boolean {
  if (/^post:/.test(href)) return UUID.test(href.slice(5));
  return /^(https?:\/\/|mailto:|tel:|#|\/(?!\/))/i.test(href);
}

const Href = z
  .string()
  .max(2048)
  .refine(isAllowedHref, 'Link must be http(s), mailto, tel, post:<id>, a site path or #anchor');
const Id = z.string().regex(UUID, 'Expected an id');
const Key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Expected a lowercase key');

// --- marks and inline nodes ---------------------------------------------------------------

export type Mark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'strike' }
  | { type: 'code' }
  | { type: 'link'; attrs: { href: string } };

const MarkSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('bold') }),
  z.strictObject({ type: z.literal('italic') }),
  z.strictObject({ type: z.literal('strike') }),
  z.strictObject({ type: z.literal('code') }),
  z.strictObject({ type: z.literal('link'), attrs: z.strictObject({ href: Href }) }),
]);

export interface TextNode {
  type: 'text';
  text: string;
  marks?: Mark[];
}

export type Inline =
  TextNode | { type: 'hardBreak' } | { type: 'footnoteReference'; attrs: { id: string } };

const FootnoteId = z.string().regex(/^[\w-]{1,64}$/, 'Expected a footnote id');

const InlineSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('text'),
    text: z.string().min(1),
    marks: z.array(MarkSchema).optional(),
  }),
  z.strictObject({ type: z.literal('hardBreak') }),
  z.strictObject({
    type: z.literal('footnoteReference'),
    attrs: z.strictObject({ id: FootnoteId }),
  }),
]);

// --- blocks ----------------------------------------------------------------------------------

type Align = 'left' | 'center' | 'right' | null;
export interface Paragraph {
  type: 'paragraph';
  content?: Inline[];
}
export interface ListItem {
  type: 'listItem';
  content: Block[];
}
export interface TaskItem {
  type: 'taskItem';
  attrs: { checked: boolean };
  content: Block[];
}
export interface TableCell {
  type: 'tableHeader' | 'tableCell';
  attrs: { align: Align };
  content: Paragraph[];
}
export interface TableRow {
  type: 'tableRow';
  content: TableCell[];
}

export type Block =
  | Paragraph
  | { type: 'heading'; attrs: { level: 1 | 2 | 3 | 4 | 5 | 6 }; content?: Inline[] }
  | { type: 'blockquote'; content: Block[] }
  | { type: 'bulletList'; content: ListItem[] }
  | { type: 'orderedList'; attrs: { start: number }; content: ListItem[] }
  | { type: 'taskList'; content: TaskItem[] }
  | {
      type: 'codeBlock';
      attrs: { language: string | null };
      content?: [{ type: 'text'; text: string }];
    }
  | { type: 'horizontalRule' }
  | { type: 'image'; attrs: { mediaId: string; alt: string; title: string | null } }
  | { type: 'table'; content: TableRow[] }
  | { type: 'youtube'; attrs: { id: string } }
  | { type: 'vimeo'; attrs: { id: string } }
  | { type: 'callout'; attrs: { type: 'info' | 'warning' | 'success' }; content: Block[] }
  | { type: 'gallery'; attrs: { ids: string[] } }
  | {
      type: 'button';
      attrs: { href: string; style: 'primary' | 'secondary'; label: string };
    }
  | { type: 'form'; attrs: { key: string } }
  | { type: 'collection'; attrs: { key: string; limit: number | null } }
  | { type: 'footnoteDefinition'; attrs: { id: string }; content: Block[] };
// TODO(phase-3): `legacyHtml` block for sanitized, flagged import leftovers.

export interface Doc {
  type: 'doc';
  content: Block[];
}

const ParagraphSchema = z.strictObject({
  type: z.literal('paragraph'),
  content: z.array(InlineSchema).optional(),
});
const blocks = (): z.ZodType<Block[]> => z.array(BlockSchema).min(1);
const items = <T extends z.ZodType>(item: T) => z.array(item).min(1);

const ListItemSchema = z.strictObject({
  type: z.literal('listItem'),
  get content() {
    return blocks();
  },
});
const TaskItemSchema = z.strictObject({
  type: z.literal('taskItem'),
  attrs: z.strictObject({ checked: z.boolean() }),
  get content() {
    return blocks();
  },
});
const CellSchema = z.strictObject({
  type: z.enum(['tableHeader', 'tableCell']),
  attrs: z.strictObject({ align: z.enum(['left', 'center', 'right']).nullable() }),
  content: items(ParagraphSchema),
});

const BlockSchema: z.ZodType<Block> = z.lazy(() =>
  z.discriminatedUnion('type', [
    ParagraphSchema,
    z.strictObject({
      type: z.literal('heading'),
      attrs: z.strictObject({ level: z.literal([1, 2, 3, 4, 5, 6]) }),
      content: z.array(InlineSchema).optional(),
    }),
    z.strictObject({ type: z.literal('blockquote'), content: blocks() }),
    z.strictObject({ type: z.literal('bulletList'), content: items(ListItemSchema) }),
    z.strictObject({
      type: z.literal('orderedList'),
      attrs: z.strictObject({ start: z.int().min(0).max(1_000_000) }),
      content: items(ListItemSchema),
    }),
    z.strictObject({ type: z.literal('taskList'), content: items(TaskItemSchema) }),
    z.strictObject({
      type: z.literal('codeBlock'),
      attrs: z.strictObject({
        language: z
          .string()
          .regex(/^[\w+#.-]{1,32}$/)
          .nullable(),
      }),
      content: z
        .tuple([z.strictObject({ type: z.literal('text'), text: z.string().min(1) })])
        .optional(),
    }),
    z.strictObject({ type: z.literal('horizontalRule') }),
    z.strictObject({
      type: z.literal('image'),
      attrs: z.strictObject({
        mediaId: Id,
        alt: z.string().max(500),
        title: z.string().max(500).nullable(),
      }),
    }),
    z.strictObject({
      type: z.literal('table'),
      content: items(z.strictObject({ type: z.literal('tableRow'), content: items(CellSchema) })),
    }),
    z.strictObject({
      type: z.literal('youtube'),
      attrs: z.strictObject({
        id: z.string().regex(/^[\w-]{6,20}$/, 'Expected a YouTube video id'),
      }),
    }),
    z.strictObject({
      type: z.literal('vimeo'),
      attrs: z.strictObject({ id: z.string().regex(/^\d{1,12}$/, 'Expected a Vimeo video id') }),
    }),
    z.strictObject({
      type: z.literal('callout'),
      attrs: z.strictObject({ type: z.enum(['info', 'warning', 'success']) }),
      content: blocks(),
    }),
    z.strictObject({
      type: z.literal('gallery'),
      attrs: z.strictObject({ ids: z.array(Id).min(1).max(100) }),
    }),
    z.strictObject({
      type: z.literal('button'),
      attrs: z.strictObject({
        href: Href,
        style: z.enum(['primary', 'secondary']),
        label: z.string().min(1).max(200),
      }),
    }),
    z.strictObject({ type: z.literal('form'), attrs: z.strictObject({ key: Key }) }),
    z.strictObject({
      type: z.literal('collection'),
      attrs: z.strictObject({ key: Key, limit: z.int().min(1).max(100).nullable() }),
    }),
    z.strictObject({
      type: z.literal('footnoteDefinition'),
      attrs: z.strictObject({ id: FootnoteId }),
      content: blocks(),
    }),
  ]),
);

const DocSchema = z.strictObject({ type: z.literal('doc'), content: z.array(BlockSchema) });

/** Validates untrusted ProseMirror JSON (admin editor, imports) against the allowlist. */
export function parseDoc(input: unknown): Doc {
  const result = DocSchema.safeParse(input);
  if (result.success) return result.data;
  throw new ContentFormatError(
    result.error.issues.map((i) => ({
      path: i.path.filter((p) => typeof p !== 'symbol'),
      message: i.message,
    })),
  );
}
