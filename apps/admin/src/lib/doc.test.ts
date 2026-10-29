import { parseDoc } from '@lithocms/content-format';
import { describe, expect, it } from 'vitest';
import { fromDoc, mediaIds, toDoc, type PMNode } from './doc';

const MEDIA = '01a18686-b50b-7102-8fc8-31a486da95d3';

const server: PMNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Başlık' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Bir ' },
        {
          type: 'text',
          text: 'bağlantı',
          marks: [{ type: 'bold' }, { type: 'link', attrs: { href: '/iletisim/' } }],
        },
        { type: 'footnoteReference', attrs: { id: '1' } },
      ],
    },
    { type: 'image', attrs: { mediaId: MEDIA, alt: 'Vapur', title: null } },
    { type: 'youtube', attrs: { id: 'dQw4w9WgXcQ' } },
    {
      type: 'callout',
      attrs: { type: 'info' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Not' }] }],
    },
    { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'x = 1' }] },
  ],
};

describe('editor doc conversion', () => {
  it('round-trips a server doc, keeping blocks the editor does not edit', () => {
    const editor = fromDoc(server, (id) => `https://site.example/media/${id}.jpg`);
    expect(editor.content?.[2]?.attrs?.src).toBe(`https://site.example/media/${MEDIA}.jpg`);
    expect(editor.content?.[3]?.type).toBe('preservedBlock');
    expect(editor.content?.[1]?.content?.[2]?.type).toBe('preservedInline');
    expect(toDoc(editor)).toEqual(server);
  });

  it('drops what the allowlist rejects: editor-only attributes, marks and stray images', () => {
    const doc = toDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'a',
              marks: [
                { type: 'underline' },
                {
                  type: 'link',
                  attrs: { href: 'https://x.test', target: '_blank', rel: 'noopener' },
                },
              ],
            },
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 1, type: null },
          content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
        },
        {
          type: 'image',
          attrs: { src: 'https://elsewhere.test/a.png', alt: '', title: null, mediaId: null },
        },
        { type: 'codeBlock', attrs: { language: '' } },
      ],
    });
    expect(() => parseDoc(doc)).not.toThrow();
    expect(doc.content?.[0]?.content?.[0]?.marks).toEqual([
      { type: 'link', attrs: { href: 'https://x.test' } },
    ]);
    expect(doc.content?.map((n) => n.type)).toEqual(['paragraph', 'orderedList', 'codeBlock']);
  });

  it('treats a lone empty paragraph as an empty doc, and lists media ids', () => {
    expect(toDoc(fromDoc(null, () => ''))).toEqual({ type: 'doc', content: [] });
    expect(mediaIds(server)).toEqual([MEDIA]);
  });
});
