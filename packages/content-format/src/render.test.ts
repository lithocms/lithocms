import { describe, expect, it } from 'vitest';
import { markdownToDoc } from './from-markdown.js';
import { renderHtml, type RenderContext } from './render.js';
import { sanitizeHtml } from './sanitize.js';
import type { Doc } from './schema.js';

const MEDIA = '0190d6c2-0000-7000-8000-000000000001';
const MISSING = '0190d6c2-0000-7000-8000-000000000009';
const POST = '0190d6c2-0000-7000-8000-0000000000aa';
const GONE = '0190d6c2-0000-7000-8000-0000000000bb';

const ctx: RenderContext = {
  media: (id) =>
    id === MEDIA
      ? {
          src: '/media/a-800.webp',
          srcset: '/media/a-400.webp 400w, /media/a-800.webp 800w',
          width: 800,
          height: 600,
        }
      : undefined,
  postUrl: (id) => (id === POST ? '/hello-world/' : undefined),
};

const render = (md: string) => renderHtml(markdownToDoc(md), ctx);

describe('renderHtml', () => {
  it('renders text with marks and resolves internal links', () => {
    expect(render(`**Bold _both_** \`x<y\` [in](post:${POST}) [out](https://e.com)`)).toBe(
      '<p><strong>Bold </strong><strong><em>both</em></strong> <code>x&lt;y</code> ' +
        '<a href="/hello-world/">in</a> <a href="https://e.com" rel="noopener noreferrer">out</a></p>',
    );
  });

  it('keeps the text of links to deleted posts', () => {
    expect(render(`[old](post:${GONE})`)).toBe('<p>old</p>');
  });

  it('renders library images with variants and drops missing ones', () => {
    expect(render(`![A "quote"](media:${MEDIA} "Cap")\n\n![x](media:${MISSING})`)).toBe(
      '<figure><img src="/media/a-800.webp" alt="A &quot;quote&quot;" ' +
        'srcset="/media/a-400.webp 400w, /media/a-800.webp 800w" width="800" height="600" ' +
        'loading="lazy" decoding="async" /><figcaption>Cap</figcaption></figure>',
    );
  });

  it('renders embeds from fixed hosts only', () => {
    expect(render('::youtube{id="dQw4w9WgXcQ"}')).toContain(
      'src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"',
    );
    expect(render('::vimeo{id="76979871"}')).toContain(
      'src="https://player.vimeo.com/video/76979871?dnt=1"',
    );
  });

  it('renders blocks, tables, task lists and footnotes', () => {
    const html = render(
      [
        '3. three',
        '- [x] done',
        '| a | b |\n| - | -: |\n| 1 | 2 |',
        ':::callout{type="info"}\nNote\n:::',
        '::button[Go]{href="/go"}',
        'See[^1].',
        '[^1]: Source.',
      ].join('\n\n'),
    );
    expect(html).toContain('<ol start="3"><li><p>three</p></li></ol>');
    expect(html).toContain(
      '<li class="task-item"><input type="checkbox" disabled checked /><p>done</p></li>',
    );
    expect(html).toContain('<thead><tr><th>a</th><th style="text-align:right">b</th></tr></thead>');
    expect(html).toContain('<aside class="callout callout-info" role="note"><p>Note</p></aside>');
    expect(html).toContain('<a href="/go" class="button button-primary" role="button">Go</a>');
    expect(html).toContain('<sup id="fnref-1"><a href="#fn-1" class="footnote-ref">1</a></sup>');
    expect(html).toContain('<section class="footnotes"><ol><li id="fn-1"><p>Source.</p>');
  });

  it('leaves placeholders for forms and collections', () => {
    expect(render('::form{key="contact"}\n\n::collection{key="faq" limit="5"}')).toBe(
      '<div data-litho-form="contact"></div><div data-litho-collection="faq" data-limit="5"></div>',
    );
  });

  it('escapes text that looks like HTML', () => {
    expect(render('Hi &lt;script&gt;alert(1)&lt;/script&gt; and \\<img onerror=x>')).toBe(
      '<p>Hi &lt;script&gt;alert(1)&lt;/script&gt; and &lt;img onerror=x&gt;</p>',
    );
  });

  it('strips dangerous output even if a document skipped validation', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        },
        { type: 'button', attrs: { href: 'javascript:alert(1)', style: 'primary', label: 'b' } },
      ],
    } as Doc;
    const html = renderHtml(doc, ctx);
    expect(html).not.toContain('javascript');
  });
});

describe('sanitizeHtml', () => {
  it.each([
    ['<script>alert(1)</script><p>ok</p>', '<p>ok</p>'],
    ['<img src="/a.png" onerror="alert(1)">', '<img src="/a.png" />'],
    ['<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="//evil.example">x</a>', '<a>x</a>'],
    ['<iframe src="https://evil.example/x"></iframe>', '<iframe></iframe>'],
    ['<td style="color: red; text-align: center">x</td>', '<td style="text-align:center">x</td>'],
    ['<svg><use href="#x"/></svg><style>*{}</style>', ''],
  ])('sanitizes %s', (input, output) => {
    expect(sanitizeHtml(input)).toBe(output);
  });
});
