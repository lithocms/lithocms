# Building a LithoCMS theme

This folder is a complete, working theme. Copy it, change it, upload it. This guide is everything a
person or an AI assistant (Claude, for example) needs to build a theme that passes validation the
first time.

A theme is **data, not code**: Liquid templates, CSS, optional static JavaScript, images and fonts,
plus a `theme.json` manifest. There is no build step and no server-side code. Templates run in a
sandbox: they cannot read files outside the theme, reach the network, the database or the server.

## The workflow

1. **Get a starting point.** In admin, go to **Theme → Themes**, find _Starter_ (or any theme) and
   click **Download**. You get `starter-<version>.zip`. Unzip it.
2. **Change it.** Edit the files yourself, or hand the folder to Claude with a brief (see
   [Working with Claude](#working-with-claude)).
3. **Give it its own identity.** In `theme.json`, set a new `slug` (lowercase letters, digits,
   hyphens), a `name`, and `version` `1.0.0`.
4. **Check it** (optional, the upload runs the same checks). With the LithoCMS image (published
   from the first release on):
   `docker run --rm -v "$PWD:/theme:ro" ghcr.io/lithocms/lithocms node dist/validate-theme.js /theme`
   or, in a LithoCMS checkout, `pnpm theme:check path/to/theme`.
5. **Zip and upload.** Zip the folder (the zip may contain the folder itself or its files) and
   upload it in **Theme → Themes → Upload theme**. Errors come back with the file and line.
6. **Preview, then make it live.** **Preview** opens your site with the new theme for an hour, only
   for you. **Make live** switches the site; **Back to the previous theme** undoes it.
7. **Change it again.** Raise `version` (`1.0.1`, `1.1.0` …) and upload. A version that is not live
   can be re-uploaded with the same number while you iterate.

Each theme keeps its own customizer values, so switching back and forth loses nothing.

## Working with Claude

**Connected to the site (no files to move).** In admin, open **Claude connections**, create a
connection with the _Design_ scope and run the command it shows to add the site to Claude Code.
Then describe the site you want. Claude reads this guide (`guide://theme-authoring`), starts a
copy of this theme with `theme_create_draft`, edits it with `theme_update_files` (every save is
validated and the errors come back with file and line), sets values with `theme_settings_update`,
and gives you a `theme_preview` link. Nothing changes for visitors until you say so and it calls
`theme_activate`; `theme_rollback` undoes it. A live version is never edited in place: Claude raises
`version` in `theme.json` to save the next one.

**With a folder.** Give Claude this folder and a brief like:

> This is a LithoCMS theme. Read README.md first and follow its rules. Turn it into a theme for
> _[who the site is for and what it must get visitors to do]_. Look and feel: _[words, references,
> colours, fonts]_. Keep every required template. Set slug `my-theme`, version `1.0.0`. Use only
> the Liquid objects, tags and filters listed in README.md, no inline scripts, self-hosted fonts.
> When done, run the validator and fix every error.

Then upload the zip and preview it. If something looks wrong, tell Claude what you saw, have it
raise the version, and upload again.

## Files

```
theme.json                 required: the manifest
layouts/base.liquid        required: wraps every page
templates/index.liquid     required: home page and post listing (/page/2/ …)
templates/post.liquid      required: one post
templates/page.liquid      required: one page
templates/category.liquid  required: category archive (also used for tags without tag.liquid)
templates/search.liquid    required: search results (/?s=…)
templates/404.liquid       required: not found
templates/tag.liquid       optional
templates/archive.liquid   optional: date archives (falls back to index)
templates/page.<name>.liquid   optional: other page templates, declared in theme.json
sections/<name>.liquid     optional: editable sections with a {% schema %}
snippets/<name>.liquid     optional: partials for {% render %}
assets/…                   css js json svg png jpg jpeg webp avif gif woff woff2 ico
locales/tr.json, en.json   optional: strings for the `t` filter
README.md, LICENSE         optional: notes, never served
```

Nothing else is allowed (no `.php`, `.html`, `package.json`, build files). Limits: 300 files,
10 MB in total, 2 MB per file, 200 KB per Liquid file.

`layouts/base.liquid` must contain `{{ content_for_layout }}`, `{% head_extras %}` (in `<head>`)
and `{% body_extras %}` (before `</body>`). It should contain `{% seo %}`.

## theme.json

```json
{
  "name": "My Theme",
  "slug": "my-theme",
  "version": "1.0.0",
  "author": "Me",
  "license": "MIT",
  "description": "One sentence.",
  "tokens": {
    "colors": { "bg": "#ffffff", "fg": "#111111", "accent": "#c2410c", "muted": "#6b7280" },
    "fonts": { "body": "system-ui, sans-serif", "heading": "Georgia, serif" },
    "radius": "6px",
    "spacing": "1rem",
    "content_width": "68ch"
  },
  "dark_tokens": { "colors": { "bg": "#0b0b0c", "fg": "#ededed" } },
  "settings": [
    {
      "id": "accent",
      "type": "color",
      "default": "#c2410c",
      "label": { "tr": "Vurgu rengi", "en": "Accent color" }
    }
  ],
  "menus": [{ "location": "primary", "label": { "tr": "Ana menü", "en": "Main menu" } }],
  "slots": [{ "key": "head", "label": { "tr": "Head kodu", "en": "Head code" } }],
  "collections": ["faq"],
  "supports": { "search": true, "dark_mode": true },
  "page_templates": [
    {
      "key": "page.landing",
      "label": { "tr": "Bölümlü sayfa", "en": "Page with sections" },
      "sections": true
    }
  ]
}
```

- **tokens** become CSS custom properties in `{{ theme.css_variables }}`: `--color-<name>`,
  `--font-<name>`, `--radius`, `--spacing`, `--content-width`. `dark_tokens` apply under
  `prefers-color-scheme: dark`. Put `<style>{{ theme.css_variables }}</style>` in `<head>` and use
  the variables in your CSS.
- **settings** build the customizer in admin. Types: `text`, `textarea`, `richtext`, `boolean`,
  `number`, `select` (with `options: [{ "value": "…", "label": … }]`), `color`, `image`, `url`,
  `font`. Read them as `theme.settings.<id>`. A `color` setting with the same id as a colour token
  overrides it (`accent` → `--color-accent`). `id`s are snake_case.
- **labels** are a string or `{ "tr": "…", "en": "…" }`. Give both.
- **menus** declares menu locations; editors fill them in admin. **slots** declares places for
  admin-managed HTML (analytics, ads). **collections** lists the collection keys the theme reads.
- **page_templates** lists the `templates/page.<name>.liquid` files editors can pick for a page.
  With `"sections": true` the page is built from sections in admin and the template renders them
  with `{% sections %}`.

## Sections

`sections/<name>.liquid` ends with a JSON `{% schema %}`. Use a section on a fixed spot of any
template with `{% section 'name' %}` (its content is edited under **Theme**), or let editors stack
sections on pages whose template has `"sections": true`.

```liquid
<section class="hero">
  <h1>{{ section.settings.heading | default: site.name }}</h1>
  {% for block in section.blocks %}
    <a class="button" href="{{ block.settings.url }}">{{ block.settings.label }}</a>
  {% endfor %}
</section>
{% schema %}
{
  "name": { "tr": "Giriş", "en": "Hero" },
  "settings": [{ "id": "heading", "type": "text", "label": { "tr": "Başlık", "en": "Heading" } }],
  "blocks": [
    {
      "type": "button",
      "name": { "tr": "Buton", "en": "Button" },
      "settings": [
        { "id": "label", "type": "text", "label": { "tr": "Yazı", "en": "Label" } },
        { "id": "url", "type": "url", "label": { "tr": "Bağlantı", "en": "Link" } }
      ]
    }
  ],
  "max_blocks": 3
}
{% endschema %}
```

`image` settings arrive as image objects (use `image_tag` / `image_url`), `richtext` as safe HTML.
Settings with a `default` render it until an editor saves a value.

## Liquid objects

| Object        | Fields                                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site`        | `name`, `tagline`, `url`, `locale`, `logo` (image), `social`, `language_direction`                                                                                                     |
| `theme`       | `settings`, `tokens`, `css_variables`                                                                                                                                                  |
| `request`     | `path`, `page_type` (`index`, `post`, `page`, `category`, `tag`, `archive`, `search`, `404`), `query`                                                                                  |
| `post`        | `id`, `title`, `url`, `excerpt`, `content` (safe HTML), `published_at`, `updated_at`, `author.name`, `featured_image`, `categories`, `primary_category`, `tags`, `reading_time`, `seo` |
| `page`        | as `post`, plus `parent`, `children`, `sections`                                                                                                                                       |
| `posts`       | the current listing; wrap it in `{% paginate %}`                                                                                                                                       |
| `term`        | `name`, `url`, `description`, `parent`, `children`, `ancestors`, `meta`, `post_count`                                                                                                  |
| `categories`  | `categories.top`, `categories.all`                                                                                                                                                     |
| `menus`       | `menus.<location>.items[]`: `label`, `url`, `active`, `children`                                                                                                                       |
| `collections` | `collections.<key>.entries[]`: each entry's fields by name                                                                                                                             |
| `paginate`    | `current_page`, `pages`, `previous.url`, `next.url`, `parts`                                                                                                                           |
| `search`      | `terms`, `results`, `results_count`                                                                                                                                                    |
| `archive`     | `year`, `month`                                                                                                                                                                        |

## Tags

| Tag                                            | Use                                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `{% render 'snippet', name: value %}`          | A snippet from `snippets/`, with only the variables you pass                        |
| `{% section 'name' %}`                         | A section with its stored settings                                                  |
| `{% sections %}`                               | The current page's sections                                                         |
| `{% paginate posts by 10 %}…{% endpaginate %}` | Pagination (`posts` or `search.results`)                                            |
| `{% seo %}`                                    | Title, description, canonical, Open Graph, JSON-LD                                  |
| `{% form 'key' %}`                             | A contact form from admin (rendered by LithoCMS, spam-protected; style it with CSS) |
| `{% slot 'key' %}`                             | Admin-managed HTML for a slot declared in theme.json                                |
| `{% head_extras %}`, `{% body_extras %}`       | Required in `base.liquid`                                                           |

Standard Liquid works too (`if`, `for`, `assign`, `capture`, `case`, `unless`, `comment` …).
`include`, `layout`, `block` and the `raw` filter are not available.

## Filters

| Filter         | Example                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `asset_url`    | `{{ 'theme.css' \| asset_url }}` → fingerprinted URL, cached for a year                                                          |
| `image_url`    | `{{ post.featured_image \| image_url: width: 800 }}`                                                                             |
| `image_tag`    | `{{ img \| image_tag: widths: "400,800,1200", sizes: "(min-width: 800px) 50vw, 100vw", loading: "lazy", alt: "…", class: "…" }}` |
| `t`            | `{{ 'read_more' \| t }}` from `locales/<site locale>.json`                                                                       |
| `date`         | `{{ post.published_at \| date: "long" }}` (`short`, `medium`, `long`, `full`, or a strftime format)                              |
| `reading_time` | `{{ post.content \| reading_time }}` minutes                                                                                     |
| `excerpt`      | `{{ post.content \| excerpt: 30 }}` words, HTML removed                                                                          |
| `json`         | Safe JSON inside `<script type="application/json">` or `application/ld+json`                                                     |

Output is escaped automatically. `post.content`, `post.excerpt`, rich text and slot HTML are
already sanitized and printed as HTML.

## Rules the validator enforces

Errors (the theme is not uploaded until they are fixed):

1. `theme.json` matches the schema; `slug` and `version` are valid.
2. Every required file exists; `base.liquid` has the three required tags.
3. Every `.liquid` file parses and uses only the tags and filters above.
4. Every section `{% schema %}` is valid JSON of the right shape.
5. No inline `<script>` code. Put JavaScript in `assets/*.js` and load it with
   `<script src="{{ 'theme.js' | asset_url }}" defer></script>`. JSON scripts are fine.
6. No inline event handlers (`onclick=` …) and no `javascript:` links.
7. External scripts, stylesheets, iframes, `@import` and `url()` only from hosts the site allows.
   Self-host everything you can.
8. Only the file types listed above.
9. The size limits above.
10. Every template renders against sample data within the time and memory limits.

Warnings (shown, not blocking): images without `alt` outside `image_tag`, a missing `{% seo %}`,
low contrast between `fg` and `bg`, fonts loaded from other hosts, more than 100 KB of CSS or
50 KB of JavaScript.

## Good practice

- Keep JavaScript optional: the site must work without it. Default themes ship none.
- Self-host fonts in `assets/` (WOFF2) and keep their licence in `LICENSE` or a note.
- Use `image_tag` with `widths` and `sizes` for every content image; it serves the right size.
- One `<h1>` per page, a skip link, visible focus styles, 44 px touch targets, real `<button>`s and
  `<a>`s, `lang` and `dir` on `<html>`.
- Test with the site's real content: long titles, posts without images, empty menus, a search with
  no results, the 404 page, a phone-sized window, dark mode if you support it.
