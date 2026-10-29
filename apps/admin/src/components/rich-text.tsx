import { Image } from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { Node, type Editor } from '@tiptap/react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import {
  Bold,
  Code,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { MediaPicker } from '@/components/media-picker';
import { useI18n } from '@/lib/i18n';
import { fromDoc, toDoc, type PMNode } from '@/lib/doc';
import { useSite } from '@/lib/session';
import { cn } from '@/lib/utils';

// Same rule as the server's link allowlist: http(s), /path, #anchor, mailto:, tel:.
const ALLOWED_HREF = /^(?:https?:\/\/\S+|\/(?![/\\])\S*|#\S*|mailto:\S+|tel:[+\d\s()-]+)$/;

const preserved = (name: string, inline: boolean) =>
  Node.create({
    name,
    group: inline ? 'inline' : 'block',
    inline,
    atom: true,
    selectable: true,
    addAttributes: () => ({ json: { default: '{}' } }),
    parseHTML: () => [
      {
        tag: `${inline ? 'span' : 'div'}[data-preserved]`,
        getAttrs: (el) => ({ json: el.getAttribute('data-preserved') }),
      },
    ],
    renderHTML: ({ node }) => {
      const json = String(node.attrs.json as string);
      const type = (JSON.parse(json) as PMNode).type;
      return [
        inline ? 'span' : 'div',
        {
          'data-preserved': json,
          class: inline
            ? 'rounded bg-raised px-1 font-mono text-xs text-muted'
            : 'rounded-card border border-dashed border-control bg-raised px-3 py-2 font-mono text-xs text-muted',
          contenteditable: 'false',
        },
        type,
      ];
    },
  });

const MediaImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      mediaId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-media-id'),
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-media-id': attrs.mediaId }),
      },
    };
  },
});

function Tool({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'grid size-8 shrink-0 cursor-pointer place-items-center rounded-control text-muted hover:bg-active hover:text-ink [&_svg]:size-4',
        active && 'bg-active text-ink',
      )}
    >
      {children}
    </button>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const { t } = useI18n();
  const [picking, setPicking] = useState(false);
  const site = useSite();
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      p: e.isActive('paragraph'),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      link: e.isActive('link'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      code: e.isActive('codeBlock'),
      undo: e.can().undo(),
      redo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();
  const link = () => {
    if (s.link) return chain().unsetLink().run();
    const href = window.prompt(t('tool.linkPrompt'))?.trim();
    if (href && ALLOWED_HREF.test(href)) chain().extendMarkRange('link').setLink({ href }).run();
  };
  const sep = <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />;
  return (
    <div
      role="toolbar"
      aria-label={t('nav.content')}
      className="sticky top-12 z-10 flex items-center gap-0.5 overflow-x-auto border-b border-rule bg-sheet px-2 py-1 md:top-0"
    >
      <Tool label={t('tool.paragraph')} active={s.p} onClick={() => chain().setParagraph().run()}>
        <Pilcrow />
      </Tool>
      <Tool
        label={t('tool.h2')}
        active={s.h2}
        onClick={() => chain().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 />
      </Tool>
      <Tool
        label={t('tool.h3')}
        active={s.h3}
        onClick={() => chain().toggleHeading({ level: 3 }).run()}
      >
        <Heading3 />
      </Tool>
      {sep}
      <Tool label={t('tool.bold')} active={s.bold} onClick={() => chain().toggleBold().run()}>
        <Bold />
      </Tool>
      <Tool label={t('tool.italic')} active={s.italic} onClick={() => chain().toggleItalic().run()}>
        <Italic />
      </Tool>
      <Tool label={t('tool.strike')} active={s.strike} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough />
      </Tool>
      <Tool label={t('tool.link')} active={s.link} onClick={link}>
        <Link2 />
      </Tool>
      {sep}
      <Tool
        label={t('tool.bullet')}
        active={s.bullet}
        onClick={() => chain().toggleBulletList().run()}
      >
        <List />
      </Tool>
      <Tool
        label={t('tool.ordered')}
        active={s.ordered}
        onClick={() => chain().toggleOrderedList().run()}
      >
        <ListOrdered />
      </Tool>
      <Tool
        label={t('tool.quote')}
        active={s.quote}
        onClick={() => chain().toggleBlockquote().run()}
      >
        <Quote />
      </Tool>
      <Tool label={t('tool.code')} active={s.code} onClick={() => chain().toggleCodeBlock().run()}>
        <Code />
      </Tool>
      <Tool label={t('tool.rule')} onClick={() => chain().setHorizontalRule().run()}>
        <Minus />
      </Tool>
      <Tool label={t('tool.image')} onClick={() => setPicking(true)}>
        <ImagePlus />
      </Tool>
      {sep}
      <Tool label={t('tool.undo')} onClick={() => s.undo && chain().undo().run()}>
        <Undo2 />
      </Tool>
      <Tool label={t('tool.redo')} onClick={() => s.redo && chain().redo().run()}>
        <Redo2 />
      </Tool>
      <MediaPicker
        open={picking}
        onOpenChange={setPicking}
        onPick={(m) =>
          chain()
            .setImage({ src: site.media(m.path), alt: m.alt, mediaId: m.id } as Parameters<
              Editor['commands']['setImage']
            >[0])
            .run()
        }
      />
    </div>
  );
}

/**
 * The post body editor. `initial` is a server doc whose images already have URLs (`srcOf`);
 * every change is reported as a server doc.
 */
export function RichText({
  initial,
  srcOf,
  onChange,
  placeholder,
}: {
  initial: unknown;
  srcOf: (mediaId: string) => string;
  onChange: (doc: PMNode) => void;
  placeholder: string;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        underline: false,
        link: { openOnClick: false, autolink: true, isAllowedUri: (url) => ALLOWED_HREF.test(url) },
      }),
      MediaImage,
      Placeholder.configure({ placeholder }),
      preserved('preservedBlock', false),
      preserved('preservedInline', true),
    ],
    content: fromDoc(initial as PMNode, srcOf),
    editorProps: { attributes: { class: 'prose-editor', spellcheck: 'true' } },
    onUpdate: ({ editor: e }) => onChange(toDoc(e.getJSON() as PMNode)),
  });
  return (
    <div>
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} className="px-4 py-6 md:px-0" />
    </div>
  );
}
