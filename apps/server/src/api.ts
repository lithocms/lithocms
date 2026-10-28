import {
  assertFormManager,
  CollectionCreateInput,
  CollectionKey,
  CollectionUpdateInput,
  createCollection,
  createPost,
  createTerm,
  deleteEntry,
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
  listCollections,
  listEntries,
  listForms,
  listMedia,
  listMenus,
  listSlots,
  listSubmissions,
  listPosts,
  listRevisions,
  listTerms,
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
  updateSubmission,
  updatePost,
  updateTerm,
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
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getSessionUser, type Auth } from './auth.js';
import { ipHash } from './client-ip.js';

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
const Location = z.strictObject({ siteId: z.uuid(), location: MenuLocation });
const Key = z.strictObject({ siteId: z.uuid(), key: SlotKey });
const CollectionParams = z.strictObject({ siteId: z.uuid(), key: CollectionKey });
const EntryParams = CollectionParams.extend({ id: z.uuid() });
const FormParams = z.strictObject({ siteId: z.uuid(), key: FormKey });
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
  { db, auth, secret, store }: { db: Db; auth: Auth; secret: string; store: MediaStore },
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

      // slots: raw HTML, admins only
      api.get('/slots', (req) => run(req, (tx, siteId) => listSlots(tx, siteId)));
      api.put('/slots/:key', { schema: { params: Key, body: SlotUpdateInput } }, (req) =>
        run(req, (tx, siteId, actor) => updateSlot(tx, siteId, actor, req.params.key, req.body)),
      );

      done();
    },
    { prefix: '/api/sites/:siteId' },
  );
}

/** The user's role on a site; instance owners act as owners everywhere. */
async function roleOn(db: Db, userId: string, siteId: string, isInstanceOwner: boolean) {
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
