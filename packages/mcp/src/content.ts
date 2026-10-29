import { docToMarkdown, type Doc } from '@lithocms/content-format';
import {
  createPost,
  createTerm,
  getMenu,
  getPost,
  listCollections,
  listEntries,
  listMedia,
  listMenus,
  listPosts,
  listRevisions,
  listTerms,
  loadPublicSite,
  MarkdownInput,
  MAX_UPLOAD_BYTES,
  MenuUpdateInput,
  postUrls,
  PostUpdateInput,
  publishPost,
  restoreRevision,
  schema,
  siteThemeVersion,
  trashPost,
  unpublishPost,
  updateMedia,
  updateMenu,
  updatePost,
  updateTerm,
  uploadMedia,
  upsertEntry,
  ValidationFailed,
  type Media,
  type PostRow,
  type Tx,
} from '@lithocms/core';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { read, write, type McpContext } from './context.js';
import { parse, tool } from './result.js';

// Tools for the `content` scope (MCP_SPEC.md). Posts are always written as drafts; publishing
// is its own tool. Inputs are snake_case; the core services do the checks and the audit.

const Id = z.uuid();
const DryRun = z.boolean().optional().describe('Return what would change without writing anything');

const PostFields = {
  title: z.string().min(1).max(300),
  markdown: z
    .string()
    .max(500_000)
    .describe('Body in Markdown; read guide://content-format for images, links and directives'),
  excerpt: z.string().max(1000),
  slug: z
    .string()
    .max(100)
    .describe('Lowercase letters, digits and dashes; derived from the title if left out'),
  parent_id: Id.nullable().describe('Pages only: the parent page'),
  term_ids: z.array(Id).max(100).describe('Category and tag ids (see site_info and terms_list)'),
  primary_category_id: Id.nullable(),
  featured_media_id: Id.nullable().describe('An id from media_search or media_upload'),
  template: z.string().max(64).nullable().describe('A page template key, e.g. page.landing'),
  sections: PostUpdateInput.shape.sections,
  seo: PostUpdateInput.shape.seo,
};
const PostWrite = z.object(PostFields).partial();
type PostWrite = z.infer<typeof PostWrite>;

/** The core's input for a write: Markdown parsed, names in camelCase. */
function postInput(args: PostWrite) {
  return {
    ...(args.title !== undefined && { title: args.title }),
    ...(args.markdown !== undefined && {
      content: parse(MarkdownInput, args.markdown, 'markdown'),
    }),
    ...(args.excerpt !== undefined && { excerpt: args.excerpt }),
    ...(args.slug !== undefined && { slug: args.slug }),
    ...(args.parent_id !== undefined && { parentId: args.parent_id }),
    ...(args.term_ids !== undefined && { termIds: args.term_ids }),
    ...(args.primary_category_id !== undefined && {
      primaryCategoryId: args.primary_category_id,
    }),
    ...(args.featured_media_id !== undefined && { featuredMediaId: args.featured_media_id }),
    ...(args.template !== undefined && { template: args.template }),
    ...(args.sections !== undefined && { sections: args.sections }),
    ...(args.seo !== undefined && { seo: args.seo }),
  };
}

export function registerContentTools(server: McpServer, ctx: McpContext): void {
  const absolute = (path: string) => (ctx.siteOrigin ? ctx.siteOrigin + path : path);
  const editUrl = (id: string) => new URL(`/sites/${ctx.siteId}/posts/${id}`, ctx.adminUrl).href;
  const mediaUrl = (m: Media) => absolute(`/media/${m.path}`);

  const urlsOf = async (tx: Tx, rows: PostRow[]) =>
    postUrls(tx, await loadPublicSite(tx, ctx.siteId), rows);
  const summary = (p: PostRow, url: string | undefined) => ({
    id: p.id,
    type: p.type,
    title: p.title,
    slug: p.slug,
    status: p.status,
    published_at: p.publishedAt,
    updated_at: p.updatedAt,
    url: url ? absolute(url) : null,
    edit_url: editUrl(p.id),
  });
  const full = async (tx: Tx, id: string) => {
    const post = await getPost(tx, ctx.siteId, id);
    const url = (await urlsOf(tx, [post])).get(post.id);
    return {
      ...summary(post, url),
      excerpt: post.excerpt,
      markdown: docToMarkdown(post.content as Doc),
      parent_id: post.parentId,
      term_ids: post.termIds,
      primary_category_id: post.primaryCategoryId,
      featured_media_id: post.featuredMediaId,
      template: post.template,
      sections: post.sections,
      seo: post.seo,
    };
  };

  server.registerTool(
    'site_info',
    {
      description:
        'The site: name, language, time zone, URL, categories, tags, collections, menus and theme. Call this first.',
      annotations: { readOnlyHint: true },
    },
    tool(() =>
      read(ctx, async (tx) => {
        const site = await loadPublicSite(tx, ctx.siteId);
        const [categories, tags, collections, menus, theme] = await Promise.all([
          listTerms(tx, ctx.siteId, { taxonomy: 'category' }),
          listTerms(tx, ctx.siteId, { taxonomy: 'tag' }),
          listCollections(tx, ctx.siteId),
          listMenus(tx, ctx.siteId),
          siteThemeVersion(tx, ctx.siteId, ctx.themeDefaults),
        ]);
        const manifest = (theme?.manifest ?? {}) as {
          name?: string;
          menus?: { location: string }[];
          page_templates?: { key: string; sections?: boolean }[];
        };
        return {
          name: site.name,
          tagline: typeof site.settings.tagline === 'string' ? site.settings.tagline : '',
          locale: site.locale,
          timezone: site.timezone,
          url: ctx.siteOrigin,
          permalinks: site.permalinks,
          categories: categories.map((t) => ({
            id: t.id,
            name: t.name,
            path: t.path,
            parent_id: t.parentId,
          })),
          tags: tags.slice(0, 100).map((t) => ({ id: t.id, name: t.name })),
          collections: collections.map((c) => ({ key: c.key, label: c.label, fields: c.fields })),
          menu_locations: [
            ...new Set([
              ...(manifest.menus ?? []).map((m) => m.location),
              ...menus.map((m) => m.location),
            ]),
          ],
          theme: theme && {
            name: manifest.name,
            version: theme.version,
            page_templates: manifest.page_templates ?? [],
          },
          scopes: ctx.scopes,
        };
      }),
    ),
  );

  server.registerTool(
    'posts_search',
    {
      description: 'Find posts and pages by title, type, status or term. Newest changes first.',
      inputSchema: z.object({
        query: z.string().max(200).optional().describe('Words in the title'),
        type: z.enum(schema.POST_TYPES).optional(),
        status: z.enum(schema.POST_STATUSES).optional(),
        term_id: Id.optional(),
        author_id: Id.optional(),
        limit: z.int().min(1).max(50).optional(),
        cursor: z.string().max(200).optional().describe('next_cursor from the previous call'),
      }),
      annotations: { readOnlyHint: true },
    },
    tool((a) =>
      read(ctx, async (tx) => {
        const { items, nextCursor } = await listPosts(tx, ctx.siteId, {
          query: a.query,
          type: a.type,
          status: a.status,
          termId: a.term_id,
          authorId: a.author_id,
          limit: a.limit ?? 20,
          cursor: a.cursor,
        });
        const urls = await urlsOf(tx, items);
        return { items: items.map((p) => summary(p, urls.get(p.id))), next_cursor: nextCursor };
      }),
    ),
  );

  server.registerTool(
    'post_get',
    {
      description: 'One post or page with its body as Markdown, terms, sections and SEO.',
      inputSchema: z.object({ id: Id }),
      annotations: { readOnlyHint: true },
    },
    tool((a) => read(ctx, (tx) => full(tx, a.id))),
  );

  server.registerTool(
    'post_create',
    {
      description:
        'Create a post or page as a draft. It is not public until post_publish. Returns its id and edit link.',
      inputSchema: PostWrite.extend({
        type: z.enum(schema.POST_TYPES),
        title: PostFields.title,
        dry_run: DryRun,
      }),
    },
    tool((a) =>
      write(
        ctx,
        async (tx) => {
          const post = await createPost(tx, ctx.siteId, ctx.actor, {
            ...postInput(a),
            type: a.type,
            title: a.title,
          });
          return full(tx, post.id);
        },
        { dryRun: a.dry_run },
      ),
    ),
  );

  server.registerTool(
    'post_update',
    {
      description:
        'Change a post or page; only the fields given change. Never changes whether it is published.',
      inputSchema: PostWrite.extend({ id: Id, dry_run: DryRun }),
    },
    tool((a) =>
      write(
        ctx,
        async (tx) => {
          await updatePost(tx, ctx.siteId, ctx.actor, a.id, postInput(a));
          return full(tx, a.id);
        },
        { dryRun: a.dry_run },
      ),
    ),
  );

  server.registerTool(
    'post_publish',
    {
      description:
        'Publish a post or page now, or schedule it with `at` (ISO 8601 with offset, in the site time zone unless stated).',
      inputSchema: z.object({
        id: Id,
        at: z.iso.datetime({ offset: true }).optional(),
        dry_run: DryRun,
      }),
    },
    tool((a) =>
      write(
        ctx,
        async (tx) => {
          await publishPost(tx, ctx.siteId, ctx.actor, a.id, a.at ? new Date(a.at) : undefined);
          const { status, published_at, url } = await full(tx, a.id);
          return { status, published_at, url };
        },
        { dryRun: a.dry_run, publish: true },
      ),
    ),
  );

  server.registerTool(
    'post_unpublish',
    {
      description: 'Take a post or page off the site; it becomes a draft again.',
      inputSchema: z.object({ id: Id, dry_run: DryRun }),
    },
    tool((a) =>
      write(
        ctx,
        async (tx) => {
          await unpublishPost(tx, ctx.siteId, ctx.actor, a.id);
          return { id: a.id, status: 'draft' };
        },
        { dryRun: a.dry_run },
      ),
    ),
  );

  server.registerTool(
    'post_trash',
    {
      description:
        'Move a post or page to the trash (it can be restored in admin; nothing is deleted).',
      inputSchema: z.object({ id: Id, dry_run: DryRun }),
      annotations: { destructiveHint: true },
    },
    tool((a) =>
      write(
        ctx,
        async (tx) => {
          await trashPost(tx, ctx.siteId, ctx.actor, a.id);
          return { id: a.id, status: 'trash' };
        },
        { dryRun: a.dry_run },
      ),
    ),
  );

  server.registerTool(
    'post_revisions',
    {
      description: 'Earlier versions of a post or page, newest first.',
      inputSchema: z.object({ id: Id, limit: z.int().min(1).max(50).optional() }),
      annotations: { readOnlyHint: true },
    },
    tool((a) =>
      read(ctx, async (tx) =>
        (await listRevisions(tx, ctx.siteId, a.id, a.limit ?? 20)).map((r) => ({
          id: r.id,
          title: r.snapshot.title,
          source: r.source,
          created_at: r.createdAt,
        })),
      ),
    ),
  );

  server.registerTool(
    'revision_restore',
    {
      description: "Put a revision's content back into its post (saved as a new revision).",
      inputSchema: z.object({ revision_id: Id, dry_run: DryRun }),
    },
    tool((a) =>
      write(
        ctx,
        async (tx) => {
          const post = await restoreRevision(tx, ctx.siteId, ctx.actor, a.revision_id);
          return full(tx, post.id);
        },
        { dryRun: a.dry_run },
      ),
    ),
  );

  // terms
  const term = (t: Awaited<ReturnType<typeof listTerms>>[number]) => ({
    id: t.id,
    taxonomy: t.taxonomy,
    name: t.name,
    slug: t.slug,
    path: t.path,
    parent_id: t.parentId,
    description: t.description,
    meta: t.meta,
  });
  const TermWrite = z
    .object({
      name: z.string().min(1).max(200),
      slug: z.string().max(100),
      parent_id: Id.nullable().describe('Categories only'),
      description: z.string().max(5000),
      meta: z.record(z.string(), z.unknown()).describe('Values for the taxonomy field schema'),
    })
    .partial();
  const termInput = (a: z.infer<typeof TermWrite>) => ({
    ...(a.name !== undefined && { name: a.name }),
    ...(a.slug !== undefined && { slug: a.slug }),
    ...(a.parent_id !== undefined && { parentId: a.parent_id }),
    ...(a.description !== undefined && { description: a.description }),
    ...(a.meta !== undefined && { meta: a.meta }),
  });

  server.registerTool(
    'terms_list',
    {
      description: 'Categories or tags, optionally under a parent or matching a name.',
      inputSchema: z.object({
        taxonomy: z.enum(schema.TAXONOMIES),
        parent_id: Id.optional(),
        query: z.string().max(200).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    tool((a) =>
      read(ctx, async (tx) =>
        (
          await listTerms(tx, ctx.siteId, {
            taxonomy: a.taxonomy,
            parentId: a.parent_id,
            query: a.query,
          })
        ).map(term),
      ),
    ),
  );

  server.registerTool(
    'term_create',
    {
      description: 'Create a category or tag.',
      inputSchema: TermWrite.extend({
        taxonomy: z.enum(schema.TAXONOMIES),
        name: z.string().min(1).max(200),
        dry_run: DryRun,
      }),
    },
    tool((a) =>
      write(
        ctx,
        async (tx) =>
          term(
            await createTerm(tx, ctx.siteId, ctx.actor, {
              ...termInput(a),
              taxonomy: a.taxonomy,
              name: a.name,
            }),
          ),
        { dryRun: a.dry_run },
      ),
    ),
  );

  server.registerTool(
    'term_update',
    {
      description: 'Rename, move or describe a category or tag; only the fields given change.',
      inputSchema: TermWrite.extend({ id: Id, dry_run: DryRun }),
    },
    tool((a) =>
      write(
        ctx,
        async (tx) => term(await updateTerm(tx, ctx.siteId, ctx.actor, a.id, termInput(a))),
        { dryRun: a.dry_run },
      ),
    ),
  );

  // media
  const media = (m: Media) => ({
    id: m.id,
    url: mediaUrl(m),
    alt: m.alt,
    caption: m.caption,
    width: m.width,
    height: m.height,
  });

  server.registerTool(
    'media_search',
    {
      description: 'Images in the media library. Use their ids in Markdown as ![alt](media:<id>).',
      inputSchema: z.object({
        query: z.string().max(200).optional(),
        limit: z.int().min(1).max(50).optional(),
        cursor: z.string().max(200).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    tool((a) =>
      read(ctx, async (tx) => {
        const { items, nextCursor } = await listMedia(tx, ctx.siteId, {
          query: a.query,
          limit: a.limit ?? 20,
          cursor: a.cursor,
        });
        return { items: items.map(media), next_cursor: nextCursor };
      }),
    ),
  );

  server.registerTool(
    'media_upload',
    {
      description:
        'Add an image (JPEG, PNG, WebP, GIF or AVIF) to the media library from a public URL or base64 data. `alt` describes the image for people who cannot see it.',
      inputSchema: z.object({
        source_url: z.url({ protocol: /^https?$/ }).optional(),
        base64: z.string().max(28_000_000).optional(),
        filename: z.string().min(1).max(255).optional().describe('Needed with base64'),
        alt: z.string().min(1).max(500),
        caption: z.string().max(2000).optional(),
      }),
    },
    tool(async (a) => {
      if (!a.source_url === !a.base64) {
        throw new ValidationFailed([
          { path: ['source_url'], message: 'Give source_url or base64' },
        ]);
      }
      let data: Buffer;
      let filename = a.filename;
      if (a.source_url) {
        const res = await ctx.fetchUrl(a.source_url, MAX_UPLOAD_BYTES).catch((e: Error) => {
          throw new ValidationFailed([
            { path: ['source_url'], message: `Could not fetch it: ${e.message}` },
          ]);
        });
        if (res.status !== 200) {
          throw new ValidationFailed([
            { path: ['source_url'], message: `The URL answered ${res.status}` },
          ]);
        }
        data = res.body;
        filename ??= decodeURIComponent(new URL(res.url).pathname.split('/').pop() || 'image');
      } else {
        if (!filename) {
          throw new ValidationFailed([
            { path: ['filename'], message: 'Give a filename with base64' },
          ]);
        }
        data = Buffer.from(a.base64!, 'base64');
      }
      return write(ctx, async (tx) =>
        media(
          await uploadMedia(tx, ctx.store, ctx.siteId, ctx.actor, {
            data,
            filename: filename.slice(0, 255),
            alt: a.alt,
            caption: a.caption,
          }),
        ),
      );
    }),
  );

  server.registerTool(
    'media_update',
    {
      description: "Change an image's alt text or caption.",
      inputSchema: z.object({
        id: Id,
        alt: z.string().max(500).optional(),
        caption: z.string().max(2000).optional(),
        dry_run: DryRun,
      }),
    },
    tool((a) =>
      write(
        ctx,
        async (tx) =>
          media(
            await updateMedia(tx, ctx.siteId, ctx.actor, a.id, {
              ...(a.alt !== undefined && { alt: a.alt }),
              ...(a.caption !== undefined && { caption: a.caption }),
            }),
          ),
        { dryRun: a.dry_run },
      ),
    ),
  );

  // menus
  const Location = z.string().regex(/^[a-z0-9_-]{1,64}$/);
  server.registerTool(
    'menu_get',
    {
      description: 'The items of a menu location (see site_info.menu_locations).',
      inputSchema: z.object({ location: Location }),
      annotations: { readOnlyHint: true },
    },
    tool((a) => read(ctx, (tx) => getMenu(tx, ctx.siteId, a.location))),
  );

  server.registerTool(
    'menu_update',
    {
      description:
        'Replace the items of a menu location. Items link a post (`kind: post`, `ref`: id), a term (`kind: term`) or a URL (`kind: url`, `url`); `children` nest one level more.',
      inputSchema: z.object({
        location: Location,
        items: MenuUpdateInput.shape.items,
        dry_run: DryRun,
      }),
    },
    tool((a) =>
      write(ctx, (tx) => updateMenu(tx, ctx.siteId, ctx.actor, a.location, { items: a.items }), {
        dryRun: a.dry_run,
      }),
    ),
  );

  // collections
  const Key = z.string().regex(/^[a-z0-9_-]{1,64}$/);
  server.registerTool(
    'collection_list',
    {
      description:
        'Entries of a collection (FAQ, testimonials …); fields per site_info.collections.',
      inputSchema: z.object({
        key: Key,
        status: z.enum(schema.ENTRY_STATUSES).optional(),
        limit: z.int().min(1).max(200).optional(),
        offset: z.int().min(0).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    tool((a) =>
      read(ctx, (tx) =>
        listEntries(tx, ctx.siteId, a.key, {
          status: a.status,
          limit: a.limit ?? 50,
          offset: a.offset ?? 0,
        }),
      ),
    ),
  );

  server.registerTool(
    'collection_upsert',
    {
      description:
        'Create a collection entry, or change one with `id`. `data` is checked against the collection fields.',
      inputSchema: z.object({
        key: Key,
        id: Id.optional(),
        data: z.record(z.string(), z.unknown()),
        status: z.enum(schema.ENTRY_STATUSES).optional(),
        dry_run: DryRun,
      }),
    },
    tool((a) =>
      write(
        ctx,
        (tx) =>
          upsertEntry(tx, ctx.siteId, ctx.actor, a.key, a.id, {
            data: a.data,
            ...(a.status && { status: a.status }),
          }),
        { dryRun: a.dry_run },
      ),
    ),
  );
}
