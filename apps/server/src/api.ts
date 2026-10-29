import {
  activateTheme,
  createMcpToken,
  listMcpTokens,
  McpTokenInput,
  revokeMcpToken,
  scopesFor,
  assertFormManager,
  can,
  deleteTheme,
  Forbidden,
  getThemeVersion,
  listThemeLibrary,
  recordUploadedTheme,
  rollbackTheme,
  assertRedirectManager,
  CollectionCreateInput,
  CollectionKey,
  CollectionUpdateInput,
  createCollection,
  createPost,
  createRedirect,
  createTerm,
  deleteEntry,
  deleteRedirect,
  FieldList,
  DomainError,
  EntryInput,
  EntryListQuery,
  FormKey,
  FormUpsertInput,
  getCollection,
  getForm,
  getMedia,
  getMenu,
  getPost,
  getSiteSettings,
  listCollections,
  listEntries,
  listForms,
  listMedia,
  listMenus,
  listRedirects,
  listSlots,
  listSubmissions,
  listPosts,
  listRevisions,
  listTerms,
  loadThemeSettings,
  siteThemeVersion,
  MAX_UPLOAD_BYTES,
  MediaListQuery,
  MediaUpdateInput,
  MenuLocation,
  MenuUpdateInput,
  NotFound,
  PostCreateInput,
  PostListQuery,
  PostUpdateInput,
  publishPost,
  RedirectInput,
  RedirectListQuery,
  restoreRevision,
  schema,
  SlotKey,
  SlotUpdateInput,
  SubmissionListQuery,
  SubmissionUpdateInput,
  TermCreateInput,
  TermListQuery,
  TermUpdateInput,
  trashPost,
  unpublishPost,
  updateCollection,
  updateMedia,
  updateMenu,
  updateSlot,
  updateSiteSettings,
  SiteSettingsInput,
  updateThemeSection,
  updateThemeSettings,
  updateSubmission,
  updatePost,
  updateRedirect,
  termFields,
  updateTerm,
  updateTermFields,
  ValidationFailed,
  uploadMedia,
  upsertEntry,
  upsertForm,
  withSite,
  type Actor,
  type Db,
  type MediaStore,
  type Tx,
} from '@lithocms/core';
import { ThemeManifest, validateTheme } from '@lithocms/theme-engine';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getSessionUser, type Auth } from './auth.js';
import { ipHash } from './client-ip.js';
import { hostList } from './sites.js';
import { previewToken } from './theme-preview.js';
import { readThemeZip, ThemeZipError, writeThemeZip } from './theme-zip.js';
import type { ThemeSet } from './themes.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set on `/api/sites/:siteId/*` once the user's membership is checked. */
    actor: (Actor & { siteId: string }) | null;
  }
}

const STATUS: Record<DomainError['code'], number> = {
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  validation_failed: 400,
};

const Id = z.strictObject({ siteId: z.uuid(), id: z.uuid() });
/** A theme is at most 10 MB unpacked (THEME_CONTRACT.md); its zip is smaller. */
const MAX_THEME_ZIP_BYTES = 12 * 1024 * 1024;
const Location = z.strictObject({ siteId: z.uuid(), location: MenuLocation });
const Key = z.strictObject({ siteId: z.uuid(), key: SlotKey });
const CollectionParams = z.strictObject({ siteId: z.uuid(), key: CollectionKey });
const EntryParams = CollectionParams.extend({ id: z.uuid() });
const FormParams = z.strictObject({ siteId: z.uuid(), key: FormKey });
const SectionParams = z.strictObject({ siteId: z.uuid(), name: z.string().regex(/^[\w-]{1,64}$/) });
const TaxonomyParams = z.strictObject({
  siteId: z.uuid(),
  taxonomy: z.enum(schema.TAXONOMIES),
});
const UploadQuery = z.strictObject({
  filename: z.string().min(1).max(255),
  alt: z.string().max(500).optional(),
  caption: z.string().max(2000).optional(),
});
const PublishBody = z.strictObject({
  at: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
});

/** Admin REST API, consumed by the admin SPA. Admin origin only (enforced in app.ts). */
export function registerApi(
  app: FastifyInstance,
  {
    db,
    auth,
    secret,
    store,
    themes,
    adminUrl,
  }: {
    db: Db;
    auth: Auth;
    secret: string;
    store: MediaStore;
    themes: ThemeSet;
    adminUrl: URL;
  },
) {
  app.setValidatorCompiler(validatorCompiler);
  app.decorateRequest('actor', null);

  // The one place domain and validation errors become HTTP responses.
  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues = error.validation.map((v) => ({
        path: v.instancePath.split('/').filter(Boolean),
        message: v.message ?? 'Invalid value',
      }));
      return reply.code(400).send({
        error: 'validation_failed',
        message: new ValidationFailed(issues).message,
        issues,
      });
    }
    if (error instanceof DomainError) {
      return reply.code(STATUS[error.code]).send({
        error: error.code,
        message: error.message,
        ...(error instanceof ValidationFailed ? { issues: error.issues } : {}),
      });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send({ error: 'bad_request', message: (error as Error).message });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong' });
  });

  void app.register(
    (scope, _opts, done) => {
      const api = scope.withTypeProvider<ZodTypeProvider>();

      api.addHook('preHandler', async (request, reply) => {
        const user = await getSessionUser(auth, request);
        if (!user) return reply.code(401).send({ error: 'unauthorized', message: 'Sign in first' });
        const siteId = (request.params as { siteId?: string }).siteId ?? '';
        const role = z.uuid().safeParse(siteId).success
          ? await roleOn(db, user.id, siteId, user.isInstanceOwner)
          : undefined;
        // Sites the user cannot access look the same as sites that do not exist.
        if (!role) throw new NotFound('Site not found');
        request.actor = {
          userId: user.id,
          role,
          channel: 'admin',
          siteId,
          ipHash: ipHash(request, secret),
        };
      });

      const run = <T>(
        request: FastifyRequest,
        fn: (tx: Tx, siteId: string, actor: Actor) => Promise<T>,
      ) => {
        const actor = request.actor!;
        return withSite(db, actor.siteId, (tx) => fn(tx, actor.siteId, actor));
      };

      // posts and pages
      api.get('/posts', { schema: { querystring: PostListQuery } }, (req) =>
        run(req, (tx, siteId) => listPosts(tx, siteId, req.query)),
      );
      api.post('/posts', { schema: { body: PostCreateInput } }, async (req, reply) =>
        reply
          .code(201)
          .send(await run(req, (tx, siteId, actor) => createPost(tx, siteId, actor, req.body))),
      );
      api.get('/posts/:id', { schema: { params: Id } }, (req) =>
        run(req, (tx, siteId) => getPost(tx, siteId, req.params.id)),
      );
      api.patch('/posts/:id', { schema: { params: Id, body: PostUpdateInput } }, (req) =>
        run(req, (tx, siteId, actor) => updatePost(tx, siteId, actor, req.params.id, req.body)),
      );
      api.post('/posts/:id/publish', { schema: { params: Id, body: PublishBody } }, (req) =>
        run(req, (tx, siteId, actor) => publishPost(tx, siteId, actor, req.params.id, req.body.at)),
      );
      api.post('/posts/:id/unpublish', { schema: { params: Id } }, (req) =>
        run(req, (tx, siteId, actor) => unpublishPost(tx, siteId, actor, req.params.id)),
      );
      api.post('/posts/:id/trash', { schema: { params: Id } }, (req) =>
        run(req, (tx, siteId, actor) => trashPost(tx, siteId, actor, req.params.id)),
      );
      api.get('/posts/:id/revisions', { schema: { params: Id } }, (req) =>
        run(req, (tx, siteId) => listRevisions(tx, siteId, req.params.id)),
      );
      api.post('/revisions/:id/restore', { schema: { params: Id } }, (req) =>
        run(req, (tx, siteId, actor) => restoreRevision(tx, siteId, actor, req.params.id)),
      );

      // media: the file is the raw request body; its type is sniffed, never taken from headers
      scope.addContentTypeParser(
        /^(?:application\/octet-stream|image\/[\w.+-]+)$/,
        { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
        (_req, body, done) => {
          done(null, body);
        },
      );
      api.post('/media', { schema: { querystring: UploadQuery } }, async (req, reply) => {
        if (!Buffer.isBuffer(req.body)) {
          throw new ValidationFailed([
            { path: ['file'], message: 'Send the file as the request body' },
          ]);
        }
        const data = req.body;
        const media = await run(req, (tx, siteId, actor) =>
          uploadMedia(tx, store, siteId, actor, { data, ...req.query }),
        );
        return reply.code(201).send(media);
      });
      api.get('/media', { schema: { querystring: MediaListQuery } }, (req) =>
        run(req, (tx, siteId) => listMedia(tx, siteId, req.query)),
      );
      api.get('/media/:id', { schema: { params: Id } }, (req) =>
        run(req, (tx, siteId) => getMedia(tx, siteId, req.params.id)),
      );
      api.patch('/media/:id', { schema: { params: Id, body: MediaUpdateInput } }, (req) =>
        run(req, (tx, siteId, actor) => updateMedia(tx, siteId, actor, req.params.id, req.body)),
      );

      // categories and tags
      api.get('/terms', { schema: { querystring: TermListQuery } }, (req) =>
        run(req, (tx, siteId) => listTerms(tx, siteId, req.query)),
      );
      api.post('/terms', { schema: { body: TermCreateInput } }, async (req, reply) =>
        reply
          .code(201)
          .send(await run(req, (tx, siteId, actor) => createTerm(tx, siteId, actor, req.body))),
      );
      api.get('/taxonomies/:taxonomy/fields', { schema: { params: TaxonomyParams } }, (req) =>
        run(req, (tx, siteId) => termFields(tx, siteId, req.params.taxonomy)),
      );
      api.put(
        '/taxonomies/:taxonomy/fields',
        { schema: { params: TaxonomyParams, body: FieldList } },
        (req) =>
          run(req, (tx, siteId, actor) =>
            updateTermFields(tx, siteId, actor, req.params.taxonomy, req.body),
          ),
      );
      api.patch('/terms/:id', { schema: { params: Id, body: TermUpdateInput } }, (req) =>
        run(req, (tx, siteId, actor) => updateTerm(tx, siteId, actor, req.params.id, req.body)),
      );

      // menus, one per theme location
      api.get('/menus', (req) => run(req, (tx, siteId) => listMenus(tx, siteId)));
      api.get('/menus/:location', { schema: { params: Location } }, (req) =>
        run(req, (tx, siteId) => getMenu(tx, siteId, req.params.location)),
      );
      api.put('/menus/:location', { schema: { params: Location, body: MenuUpdateInput } }, (req) =>
        run(req, (tx, siteId, actor) =>
          updateMenu(tx, siteId, actor, req.params.location, req.body),
        ),
      );

      // collections and their entries
      api.get('/collections', (req) => run(req, (tx, siteId) => listCollections(tx, siteId)));
      api.post('/collections', { schema: { body: CollectionCreateInput } }, async (req, reply) =>
        reply
          .code(201)
          .send(
            await run(req, (tx, siteId, actor) => createCollection(tx, siteId, actor, req.body)),
          ),
      );
      api.get('/collections/:key', { schema: { params: CollectionParams } }, (req) =>
        run(req, (tx, siteId) => getCollection(tx, siteId, req.params.key)),
      );
      api.patch(
        '/collections/:key',
        { schema: { params: CollectionParams, body: CollectionUpdateInput } },
        (req) =>
          run(req, (tx, siteId, actor) =>
            updateCollection(tx, siteId, actor, req.params.key, req.body),
          ),
      );
      api.get(
        '/collections/:key/entries',
        { schema: { params: CollectionParams, querystring: EntryListQuery } },
        (req) => run(req, (tx, siteId) => listEntries(tx, siteId, req.params.key, req.query)),
      );
      api.post(
        '/collections/:key/entries',
        { schema: { params: CollectionParams, body: EntryInput } },
        async (req, reply) =>
          reply
            .code(201)
            .send(
              await run(req, (tx, siteId, actor) =>
                upsertEntry(tx, siteId, actor, req.params.key, undefined, req.body),
              ),
            ),
      );
      api.patch(
        '/collections/:key/entries/:id',
        { schema: { params: EntryParams, body: EntryInput } },
        (req) =>
          run(req, (tx, siteId, actor) =>
            upsertEntry(tx, siteId, actor, req.params.key, req.params.id, req.body),
          ),
      );
      api.delete(
        '/collections/:key/entries/:id',
        { schema: { params: EntryParams } },
        async (req, reply) => {
          await run(req, (tx, siteId, actor) =>
            deleteEntry(tx, siteId, actor, req.params.key, req.params.id),
          );
          return reply.code(204).send();
        },
      );

      // forms and their submissions (admins)
      api.get('/forms', (req) =>
        run(req, (tx, siteId, actor) => {
          assertFormManager(actor);
          return listForms(tx, siteId);
        }),
      );
      api.get('/forms/:key', { schema: { params: FormParams } }, (req) =>
        run(req, (tx, siteId, actor) => {
          assertFormManager(actor);
          return getForm(tx, siteId, req.params.key);
        }),
      );
      api.put('/forms/:key', { schema: { params: FormParams, body: FormUpsertInput } }, (req) =>
        run(req, (tx, siteId, actor) => upsertForm(tx, siteId, actor, req.params.key, req.body)),
      );
      api.get(
        '/forms/:key/submissions',
        { schema: { params: FormParams, querystring: SubmissionListQuery } },
        (req) =>
          run(req, (tx, siteId, actor) =>
            listSubmissions(tx, siteId, actor, req.params.key, req.query),
          ),
      );
      api.patch(
        '/submissions/:id',
        { schema: { params: Id, body: SubmissionUpdateInput } },
        async (req, reply) => {
          await run(req, (tx, siteId, actor) =>
            updateSubmission(tx, siteId, actor, req.params.id, req.body.status),
          );
          return reply.code(204).send();
        },
      );

      // redirects (admins)
      api.get('/redirects', { schema: { querystring: RedirectListQuery } }, (req) =>
        run(req, (tx, siteId, actor) => {
          assertRedirectManager(actor);
          return listRedirects(tx, siteId, req.query);
        }),
      );
      api.post('/redirects', { schema: { body: RedirectInput } }, async (req, reply) =>
        reply
          .code(201)
          .send(await run(req, (tx, siteId, actor) => createRedirect(tx, siteId, actor, req.body))),
      );
      api.put('/redirects/:id', { schema: { params: Id, body: RedirectInput } }, (req) =>
        run(req, (tx, siteId, actor) => updateRedirect(tx, siteId, actor, req.params.id, req.body)),
      );
      api.delete('/redirects/:id', { schema: { params: Id } }, async (req, reply) => {
        await run(req, (tx, siteId, actor) => deleteRedirect(tx, siteId, actor, req.params.id));
        return reply.code(204).send();
      });

      // theme: the active theme's customizer settings and static sections
      const activeTheme = async (tx: Tx, siteId: string) => {
        const version = await siteThemeVersion(tx, siteId, themes.defaults);
        const loaded = version && (await themes.get(version.storagePath));
        if (!loaded) throw new NotFound('This site has no theme');
        return { themeId: version.themeId, version: version.version, ...loaded };
      };
      api.get('/theme', (req) =>
        run(req, async (tx, siteId) => {
          const theme = await activeTheme(tx, siteId);
          const stored = await loadThemeSettings(tx, siteId, theme.themeId);
          const { manifest } = theme;
          return {
            slug: manifest.slug,
            name: manifest.name,
            version: theme.version,
            settings: manifest.settings ?? [],
            values: stored.values,
            sections: Object.entries(theme.engine.sections).map(([name, schema]) => ({
              name,
              schema,
              data: stored.sections[name] ?? null,
            })),
            pageTemplates: manifest.page_templates ?? [],
            menus: manifest.menus ?? [],
            slots: manifest.slots ?? [],
            collections: manifest.collections ?? [],
          };
        }),
      );
      api.put('/theme/settings', { schema: { body: z.record(z.string(), z.unknown()) } }, (req) =>
        run(req, async (tx, siteId, actor) => {
          const theme = await activeTheme(tx, siteId);
          const values = await updateThemeSettings(
            tx,
            siteId,
            actor,
            theme.themeId,
            theme.manifest.settings ?? [],
            req.body,
          );
          return { values };
        }),
      );
      api.put('/theme/sections/:name', { schema: { params: SectionParams } }, (req) =>
        run(req, async (tx, siteId, actor) => {
          const theme = await activeTheme(tx, siteId);
          const schema = Object.hasOwn(theme.engine.sections, req.params.name)
            ? theme.engine.sections[req.params.name]
            : undefined;
          if (!schema) throw new NotFound('No such section');
          return updateThemeSection(
            tx,
            siteId,
            actor,
            theme.themeId,
            req.params.name,
            schema,
            req.body,
          );
        }),
      );

      // theme library: upload (zip body), preview, activate, roll back, download, delete
      const assertThemes = (req: FastifyRequest) => {
        if (!can(req.actor!.role, 'theme.manage')) {
          throw new Forbidden('Only admins can manage themes');
        }
      };
      /** The site's public origin and CSP allowlist. */
      const publicSite = async (tx: Tx, siteId: string) => {
        const [row] = await tx
          .select({ settings: schema.sites.settings, domain: schema.siteDomains.domain })
          .from(schema.sites)
          .leftJoin(schema.siteDomains, eq(schema.siteDomains.siteId, schema.sites.id))
          .where(eq(schema.sites.id, siteId))
          .orderBy(desc(schema.siteDomains.isPrimary), schema.siteDomains.domain)
          .limit(1);
        const port = adminUrl.port ? `:${adminUrl.port}` : '';
        return {
          origin: row?.domain ? `${adminUrl.protocol}//${row.domain}${port}` : null,
          cspAllowlist: hostList(row?.settings.csp_allowlist),
        };
      };
      scope.addContentTypeParser(
        ['application/zip', 'application/x-zip-compressed'],
        { parseAs: 'buffer', bodyLimit: MAX_THEME_ZIP_BYTES },
        (_req, body, done) => {
          done(null, body);
        },
      );
      api.get('/themes', (req) => run(req, (tx, siteId) => listThemeLibrary(tx, siteId)));
      api.post('/themes', async (req, reply) => {
        assertThemes(req);
        if (!Buffer.isBuffer(req.body)) {
          throw new ValidationFailed([
            { path: ['file'], message: 'Send the zip as the request body' },
          ]);
        }
        let bundle;
        try {
          bundle = await readThemeZip(req.body);
        } catch (e) {
          if (!(e instanceof ThemeZipError)) throw e;
          throw new ValidationFailed([{ path: ['file'], message: e.message }]);
        }
        const { siteId } = req.actor!;
        const { cspAllowlist } = await withSite(db, siteId, (tx) => publicSite(tx, siteId));
        const report = await validateTheme(bundle, { cspAllowlist });
        if (!report.valid) {
          return reply
            .code(422)
            .send({ error: 'theme_invalid', message: 'The theme has errors', report });
        }
        const manifest = ThemeManifest.parse(JSON.parse(String(bundle['theme.json'])));
        const storagePath = await themes.save(siteId, bundle);
        const recorded = await run(req, (tx, siteId, actor) =>
          recordUploadedTheme(tx, siteId, actor, {
            slug: manifest.slug,
            name: manifest.name,
            version: manifest.version,
            manifest,
            report,
            storagePath,
          }),
        ).catch(async (e: unknown) => {
          await themes.remove(storagePath);
          throw e;
        });
        if (recorded.replacedPath) await themes.remove(recorded.replacedPath);
        return reply.code(201).send({
          id: recorded.version.id,
          slug: manifest.slug,
          name: manifest.name,
          version: manifest.version,
          replaced: recorded.replacedPath !== null,
          report,
        });
      });
      api.post('/themes/versions/:id/activate', { schema: { params: Id } }, (req) =>
        run(req, (tx, siteId, actor) => activateTheme(tx, siteId, actor, req.params.id)),
      );
      api.post('/themes/rollback', (req) =>
        run(req, (tx, siteId, actor) => rollbackTheme(tx, siteId, actor)),
      );
      api.post('/themes/versions/:id/preview', { schema: { params: Id } }, (req) =>
        run(req, async (tx, siteId) => {
          assertThemes(req);
          const version = await getThemeVersion(tx, siteId, req.params.id);
          if (version.status !== 'valid' && version.status !== 'active') {
            throw new ValidationFailed([
              { path: ['id'], message: 'Only a valid theme can be previewed' },
            ]);
          }
          const { origin } = await publicSite(tx, siteId);
          if (!origin) throw new NotFound('This site has no domain yet');
          const token = previewToken(secret, siteId, version.id);
          return { url: `${origin}/_preview?token=${encodeURIComponent(token)}` };
        }),
      );
      api.get('/themes/versions/:id/download', { schema: { params: Id } }, async (req, reply) => {
        assertThemes(req);
        const version = await run(req, (tx, siteId) => getThemeVersion(tx, siteId, req.params.id));
        const files = await themes.files(version.storagePath);
        if (!files) throw new NotFound('The theme files are missing');
        const name = `${version.slug}-${version.version}`;
        return reply
          .type('application/zip')
          .header('content-disposition', `attachment; filename="${name}.zip"`)
          .header('cache-control', 'no-store')
          .send(await writeThemeZip(files, version.slug));
      });
      api.delete('/themes/:id', { schema: { params: Id } }, async (req, reply) => {
        const paths = await run(req, (tx, siteId, actor) =>
          deleteTheme(tx, siteId, actor, req.params.id),
        );
        await Promise.all(paths.map((p) => themes.remove(p)));
        return reply.code(204).send();
      });

      // general settings (admins write)
      api.get('/settings', (req) => run(req, (tx, siteId) => getSiteSettings(tx, siteId)));
      api.patch('/settings', { schema: { body: SiteSettingsInput } }, (req) =>
        run(req, (tx, siteId, actor) => updateSiteSettings(tx, siteId, actor, req.body)),
      );

      // slots: raw HTML, admins only
      api.get('/slots', (req) => run(req, (tx, siteId) => listSlots(tx, siteId)));
      api.put('/slots/:key', { schema: { params: Key, body: SlotUpdateInput } }, (req) =>
        run(req, (tx, siteId, actor) => updateSlot(tx, siteId, actor, req.params.key, req.body)),
      );

      // Claude connections: the signed-in user's own MCP access tokens for this site
      const mcpInfo = () => ({ url: new URL('/mcp', adminUrl).href });
      api.get('/mcp-tokens', async (req) => ({
        ...mcpInfo(),
        grantable: scopesFor(req.actor!.role),
        tokens: await run(req, (tx, siteId, actor) => listMcpTokens(tx, siteId, actor)),
      }));
      api.post('/mcp-tokens', { schema: { body: McpTokenInput } }, async (req, reply) =>
        reply.code(201).send({
          ...mcpInfo(),
          ...(await run(req, (tx, siteId, actor) => createMcpToken(tx, siteId, actor, req.body))),
        }),
      );
      api.delete('/mcp-tokens/:id', { schema: { params: Id } }, async (req, reply) => {
        await run(req, (tx, siteId, actor) => revokeMcpToken(tx, siteId, actor, req.params.id));
        return reply.code(204).send();
      });

      done();
    },
    { prefix: '/api/sites/:siteId' },
  );
}

/** The user's role on a site; instance owners act as owners everywhere. */
export async function roleOn(db: Db, userId: string, siteId: string, isInstanceOwner: boolean) {
  const [membership] = await db
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.siteId, siteId)));
  if (membership) return membership.role;
  if (!isInstanceOwner) return undefined;
  const [site] = await db
    .select({ id: schema.sites.id })
    .from(schema.sites)
    .where(eq(schema.sites.id, siteId));
  return site ? ('owner' as const) : undefined;
}
