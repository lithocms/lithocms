/** `guide://content-format`: the Markdown dialect post bodies are written in. */
export const CONTENT_FORMAT = `# LithoCMS content format

Post and page bodies are Markdown: CommonMark + GitHub tables, task lists, footnotes and
~~strikethrough~~, plus the directives below. Raw HTML is rejected, never sanitised.

## Text
- Headings start at \`##\`: the theme prints the title as the page's only \`#\` heading.
- **bold**, _italic_, \`code\`, ~~strike~~, \`> quotes\`, lists, \`- [x] tasks\`, fenced code with a language.
- Links: \`https://…\`, \`mailto:\`, \`tel:\`, a site path (\`/contact/\`), \`#anchor\`, or another post
  as \`[text](post:<id>)\` — it follows the post if its URL changes.
- Footnotes: \`text[^1]\` and \`[^1]: The note.\` at the end.

## Images
Images come from the media library only. Upload first (\`media_upload\` with \`source_url\` or
\`base64\` and a real \`alt\`), then put the image on its own line:

    ![What the image shows](media:<id> "Optional caption")

Several on consecutive lines become separate images; for a grid use \`::gallery\`.

## Directives (each on its own line)
    ::youtube{id="dQw4w9WgXcQ"}
    ::vimeo{id="76979871"}
    ::gallery{ids="<media id>,<media id>"}
    ::button[Sign up]{href="/register" style="primary"}     style: primary | secondary
    ::form{key="contact"}                                   a form defined in admin
    ::collection{key="faq" limit="10"}                       entries of a collection
    :::callout{type="info"}                                  type: info | warning | success
    Text **with** Markdown.
    :::

## Pages built from sections
Page templates with \`sections\` (see \`site_info.theme.page_templates\`) take \`sections\` instead
of, or next to, the body: \`[{ "type": "hero", "settings": { … }, "blocks": [ … ] }]\`, with the
settings the theme's section schema declares.

## Working rules
- Everything is created as a draft; \`post_publish\` is a separate, deliberate step.
- Use \`dry_run: true\` to see what a write would do first.
- Errors come back with a \`code\` (not_found, forbidden, conflict, validation_failed,
  rate_limited) and, for validation, the exact paths to fix.
`;
