import { ContentFormatError } from './errors.js';
import { describe, expect, it } from 'vitest';
import { markdownToDoc } from './from-markdown.js';
import { parseDoc, type Doc } from './schema.js';
import { docToMarkdown } from './to-markdown.js';

const MEDIA = '0190d6c2-0000-7000-8000-000000000001';
const MEDIA2 = '0190d6c2-0000-7000-8000-000000000002';
const POST = '0190d6c2-0000-7000-8000-0000000000aa';

const SAMPLE = `# Title

Some **bold _and italic_** text, \`code\`, ~~gone~~, a [post link](post:${POST}) and
an [external](https://example.com "t").\\
After a hard break.[^note]

![A photo](media:${MEDIA} "Caption")

> Quoted
>
> - nested

1. one
2. two

- [x] done
- [ ] todo

\`\`\`ts
const a = 1;
\`\`\`

---

| Name | Score |
| :--- | ----: |
| Ada  | 10    |

::youtube{id="dQw4w9WgXcQ"}

::vimeo{id="76979871"}

::gallery{ids="${MEDIA},${MEDIA2}"}

::button[Sign up]{href="/register" style="secondary"}

::form{key="contact"}

::collection{key="faq" limit="10"}

:::callout{type="warning"}
Mind the **gap**.
:::

Ratio a:b at 10:30.

[^note]: The footnote.
`;

const reject = (md: string) => {
  try {
    markdownToDoc(md);
  } catch (err) {
    expect(err).toBeInstanceOf(ContentFormatError);
    return (err as ContentFormatError).message;
  }
  throw new Error('expected ContentFormatError');
};

describe('markdownToDoc', () => {
  const doc = markdownToDoc(SAMPLE);
  const types = doc.content.map((b) => b.type);

  it('maps every supported construct to the allowlisted nodes', () => {
    expect(types).toEqual([
      'heading',
      'paragraph',
      'image',
      'blockquote',
      'orderedList',
      'taskList',
      'codeBlock',
      'horizontalRule',
      'table',
      'youtube',
      'vimeo',
      'gallery',
      'button',
      'form',
      'collection',
      'callout',
      'paragraph',
      'footnoteDefinition',
    ]);
  });

  it('flattens marks onto text nodes in a stable order', () => {
    expect(doc.content[1]).toMatchObject({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Some ' },
        { type: 'text', text: 'bold ', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'and italic', marks: [{ type: 'bold' }, { type: 'italic' }] },
        { type: 'text', text: ' text, ' },
        { type: 'text', text: 'code', marks: [{ type: 'code' }] },
        { type: 'text', text: ', ' },
        { type: 'text', text: 'gone', marks: [{ type: 'strike' }] },
        { type: 'text', text: ', a ' },
        {
          type: 'text',
          text: 'post link',
          marks: [{ type: 'link', attrs: { href: `post:${POST}` } }],
        },
        { type: 'text', text: ' and\nan ' },
        {
          type: 'text',
          text: 'external',
          marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
        },
        { type: 'text', text: '.' },
        { type: 'hardBreak' },
        { type: 'text', text: 'After a hard break.' },
        { type: 'footnoteReference', attrs: { id: 'note' } },
      ],
    });
  });

  it('reads attributes from images and directives', () => {
    expect(doc.content[2]).toEqual({
      type: 'image',
      attrs: { mediaId: MEDIA, alt: 'A photo', title: 'Caption' },
    });
    expect(doc.content.slice(9, 15).map((b) => ('attrs' in b ? b.attrs : null))).toEqual([
      { id: 'dQw4w9WgXcQ' },
      { id: '76979871' },
      { ids: [MEDIA, MEDIA2] },
      { href: '/register', style: 'secondary', label: 'Sign up' },
      { key: 'contact' },
      { key: 'faq', limit: 10 },
    ]);
    expect(doc.content[8]).toMatchObject({
      content: [
        { content: [{ attrs: { align: 'left' } }, { attrs: { align: 'right' } }] },
        { content: [{ type: 'tableCell' }, { type: 'tableCell' }] },
      ],
    });
  });

  it('keeps colons in prose as text', () => {
    expect(doc.content[16]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Ratio a:b at 10:30.' }],
    });
  });

  it('round-trips through Markdown without loss', () => {
    const markdown = docToMarkdown(doc);
    expect(markdownToDoc(markdown)).toEqual(doc);
    expect(docToMarkdown(markdownToDoc(markdown))).toBe(markdown);
  });

  it.each([
    ['a raw HTML block', '<div>hi</div>', 'Raw HTML'],
    ['inline HTML', 'Hello <b>x</b>', 'Raw HTML'],
    ['a script tag', '<script>alert(1)</script>', 'Raw HTML'],
    ['an external image', '![x](https://evil.example/x.png)', 'media:<id>'],
    ['an image inside text', `Look ![x](media:${MEDIA}) here`, 'own line'],
    ['a javascript: link', '[x](javascript:alert(1))', 'Link must be'],
    ['a protocol-relative link', '[x](//evil.example)', 'Link must be'],
    ['an unknown directive', '::iframe{src="https://x"}', 'Unknown directive ::iframe'],
    ['a bad YouTube id', '::youtube{id="<x>"}', 'YouTube'],
    ['a bad callout type', ':::callout{type="danger"}\nx\n:::', 'content.0.attrs.type'],
    ['a malformed post link', '[x](post:123)', 'Link must be'],
  ])('rejects %s', (_name, md, message) => {
    expect(reject(md)).toContain(message);
  });

  it('reports the line of a problem', () => {
    expect(reject('ok\n\n<iframe src="x"></iframe>')).toMatch(/^Line 3: /);
  });
});

describe('parseDoc', () => {
  it('accepts what the editor emits', () => {
    const doc: Doc = { type: 'doc', content: [{ type: 'paragraph' }] };
    expect(parseDoc(doc)).toEqual(doc);
  });

  it.each([
    ['an unknown node', { type: 'doc', content: [{ type: 'iframe', attrs: { src: 'x' } }] }],
    [
      'an unknown attribute',
      { type: 'doc', content: [{ type: 'paragraph', attrs: { style: 'x' } }] },
    ],
    [
      'an unknown mark',
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'span' }] }] },
        ],
      },
    ],
    [
      'empty text',
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] },
    ],
  ])('rejects %s', (_name, input) => {
    expect(() => parseDoc(input)).toThrow(ContentFormatError);
  });
});
