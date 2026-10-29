import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/**
 * RLS condition for tenant tables: `CREATE POLICY … USING (<this>) WITH CHECK (<this>)`.
 * Outside `withSite` the setting is unset or '' → NULL → no rows match.
 */
export const TENANT_POLICY_CONDITION = `site_id = nullif(current_setting('app.site_id', true), '')::uuid`;

const tenantPolicy = (table: string) =>
  pgPolicy(`${table}_tenant`, {
    for: 'all',
    using: sql.raw(TENANT_POLICY_CONDITION),
    withCheck: sql.raw(TENANT_POLICY_CONDITION),
  });

// Instance-level tables: no site_id RLS, accessed only by instance-scoped services.

export const sites = pgTable('sites', {
  id: uuid()
    .primaryKey()
    .default(sql`uuidv7()`),
  name: text().notNull(),
  locale: text().notNull().default('en'),
  timezone: text().notNull().default('UTC'),
  /** URL patterns (`Permalinks`); null = the defaults for the site's locale. */
  permalinks: jsonb().$type<Record<string, string>>(),
  /** Title, tagline, logo, social links, comment policy, SEO defaults, CSP allowlist. */
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  /** Null = the instance's default bundled theme. */
  activeThemeVersionId: uuid().references((): AnyPgColumn => themeVersions.id, {
    onDelete: 'set null',
  }),
  /** What `activeThemeVersionId` was before the last activation (theme rollback); null = default. */
  previousThemeVersionId: uuid().references((): AnyPgColumn => themeVersions.id, {
    onDelete: 'set null',
  }),
  status: text({ enum: ['active', 'maintenance', 'disabled'] })
    .notNull()
    .default('active'),
  /** Bumped by every page cache purge; a render that overlapped one is not stored. */
  cacheVersion: integer().notNull().default(0),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const siteDomains = pgTable(
  'site_domains',
  {
    domain: text().primaryKey(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    isPrimary: boolean().notNull().default(false),
    tlsStatus: text({ enum: ['pending', 'active', 'error'] })
      .notNull()
      .default('pending'),
  },
  (t) => [
    check('site_domains_domain_lowercase', sql`${t.domain} = lower(${t.domain})`),
    uniqueIndex('site_domains_one_primary')
      .on(t.siteId)
      .where(sql`${t.isPrimary}`),
  ],
);

const id = () =>
  uuid()
    .primaryKey()
    .default(sql`uuidv7()`);
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const userRef = () =>
  uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });

// Auth tables: the shape better-auth expects (core + twoFactor + passkey plugins).

export const users = pgTable('users', {
  id: id(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  twoFactorEnabled: boolean().notNull().default(false),
  isInstanceOwner: boolean().notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: userRef(),
    token: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.userId)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    userId: userRef(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.userId)],
);

export const verifications = pgTable(
  'verifications',
  {
    id: id(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.identifier)],
);

export const twoFactors = pgTable(
  'two_factors',
  {
    id: id(),
    userId: userRef(),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    verified: boolean().notNull().default(true),
    failedVerificationCount: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.userId), index().on(t.secret)],
);

export const passkeys = pgTable(
  'passkeys',
  {
    id: id(),
    userId: userRef(),
    name: text(),
    publicKey: text().notNull(),
    credentialID: text('credential_id').notNull(),
    counter: integer().notNull(),
    deviceType: text().notNull(),
    backedUp: boolean().notNull(),
    transports: text(),
    aaguid: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow(),
  },
  (t) => [index().on(t.userId), uniqueIndex().on(t.credentialID)],
);

export const ROLES = ['owner', 'admin', 'editor', 'author'] as const;
export type Role = (typeof ROLES)[number];

/** Which sites a user can work on. Instance-level: login lists a user's sites across tenants. */
export const memberships = pgTable(
  'memberships',
  {
    userId: userRef(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    role: text({ enum: ROLES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.siteId] }), index().on(t.siteId)],
);

export const MCP_SCOPES = ['content', 'design', 'admin'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/**
 * Personal access tokens for MCP clients (Claude Code, scripts): one user × one site × scopes.
 * Instance-level like memberships: a token is looked up by its hash before the site is known.
 */
export const mcpTokens = pgTable(
  'mcp_tokens',
  {
    id: id(),
    userId: userRef(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    scopes: text({ enum: MCP_SCOPES }).array().notNull(),
    /** sha256 of the token; the token itself is shown once. */
    tokenHash: text().notNull().unique(),
    lastUsedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.userId, t.siteId)],
);

export const CHANNELS = ['admin', 'mcp', 'api', 'import', 'system'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Append-only record of every write: the runtime role has no UPDATE, DELETE or TRUNCATE on it
 * (migration 0002). No foreign keys: history outlives deleted users and sites.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    siteId: uuid(),
    actorUserId: uuid(),
    channel: text({ enum: CHANNELS }).notNull(),
    tokenId: uuid(),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: text(),
    diff: jsonb(),
    ipHash: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.siteId, t.createdAt.desc()),
    // Reads see the current site only; writes may also record instance events (no site).
    pgPolicy('audit_log_read', { for: 'select', using: sql.raw(TENANT_POLICY_CONDITION) }),
    pgPolicy('audit_log_write', {
      for: 'insert',
      withCheck: sql.raw(`site_id is null or ${TENANT_POLICY_CONDITION}`),
    }),
  ],
).enableRLS();

// --- tenant tables ------------------------------------------------------------------------
// Every table below has `site_id`, row-level security, and composite foreign keys on
// (site_id, id): foreign key checks bypass RLS, so a plain `parent_id` could point into
// another site.

const siteRef = () =>
  uuid()
    .notNull()
    .references(() => sites.id, { onDelete: 'cascade' });

export interface MediaVariant {
  width: number;
  format: 'webp' | 'avif';
  /** Relative to the site's media root, like `media.path`. */
  path: string;
}

export const media = pgTable(
  'media',
  {
    id: id(),
    siteId: siteRef(),
    /** `YYYY/MM/<uuid>.<ext>` under the site's media root; served at `/media/<path>`. */
    path: text().notNull(),
    originalName: text().notNull(),
    /** Sniffed from the bytes, never taken from the client. */
    mime: text().notNull(),
    size: integer().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    alt: text().notNull().default(''),
    caption: text().notNull().default(''),
    variants: jsonb().$type<MediaVariant[]>().notNull().default([]),
    /** Old URL (e.g. `/wp-content/uploads/...`) that keeps resolving after an import. */
    legacyUrl: text(),
    uploadedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.siteId, t.id),
    unique().on(t.siteId, t.path),
    index().on(t.siteId, t.createdAt.desc()),
    index().on(t.siteId, t.legacyUrl),
    tenantPolicy('media'),
  ],
).enableRLS();

export const POST_TYPES = ['post', 'page'] as const;
export const POST_STATUSES = ['draft', 'scheduled', 'published', 'trash'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export interface SeoFields {
  title?: string;
  description?: string;
  ogImageId?: string;
  canonical?: string;
  noindex?: boolean;
}

export interface SectionInstance {
  type: string;
  settings: Record<string, unknown>;
  blocks: { type: string; settings: Record<string, unknown> }[];
}

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const posts = pgTable(
  'posts',
  {
    id: id(),
    siteId: siteRef(),
    type: text({ enum: POST_TYPES }).notNull(),
    slug: text().notNull(),
    parentId: uuid(),
    title: text().notNull(),
    excerpt: text().notNull().default(''),
    /** ProseMirror JSON, validated by `@lithocms/content-format`. */
    content: jsonb().notNull(),
    /** Sanitized render of `content`, refreshed on every save. */
    contentHtml: text().notNull().default(''),
    status: text({ enum: POST_STATUSES }).notNull().default('draft'),
    publishedAt: timestamp({ withTimezone: true }),
    authorId: uuid()
      .notNull()
      .references(() => users.id),
    featuredMediaId: uuid(),
    template: text(),
    sections: jsonb().$type<SectionInstance[]>(),
    seo: jsonb().$type<SeoFields>().notNull().default({}),
    commentsOpen: boolean().notNull().default(true),
    commentCount: integer().notNull().default(0),
    legacyId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    trashedAt: timestamp({ withTimezone: true }),
    /** Full-text index of title, excerpt and content text; kept by a trigger (migration 0011). */
    search: tsvector(),
  },
  (t) => [
    unique().on(t.siteId, t.id),
    unique().on(t.siteId, t.type, t.parentId, t.slug).nullsNotDistinct(),
    foreignKey({
      columns: [t.siteId, t.parentId],
      foreignColumns: [t.siteId, t.id],
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.siteId, t.featuredMediaId],
      foreignColumns: [media.siteId, media.id],
    }).onDelete('restrict'),
    check('posts_page_parent', sql`${t.parentId} is null or ${t.type} = 'page'`),
    index().on(t.siteId, t.type, t.status, t.publishedAt.desc()),
    index().on(t.siteId, t.slug),
    index().using('gin', t.search),
    tenantPolicy('posts'),
  ],
).enableRLS();

export const REVISION_SOURCES = ['admin', 'mcp', 'import', 'autosave'] as const;

export interface RevisionSnapshot {
  title: string;
  excerpt: string;
  content: unknown;
  sections: SectionInstance[] | null;
  seo: SeoFields;
}

export const revisions = pgTable(
  'revisions',
  {
    id: id(),
    siteId: siteRef(),
    postId: uuid().notNull(),
    snapshot: jsonb().$type<RevisionSnapshot>().notNull(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    source: text({ enum: REVISION_SOURCES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.siteId, t.postId],
      foreignColumns: [posts.siteId, posts.id],
    }).onDelete('cascade'),
    index().on(t.postId, t.createdAt.desc()),
    tenantPolicy('revisions'),
  ],
).enableRLS();

export const TAXONOMIES = ['category', 'tag'] as const;
export type Taxonomy = (typeof TAXONOMIES)[number];

export const terms = pgTable(
  'terms',
  {
    id: id(),
    siteId: siteRef(),
    taxonomy: text({ enum: TAXONOMIES }).notNull(),
    slug: text().notNull(),
    name: text().notNull(),
    description: text().notNull().default(''),
    parentId: uuid(),
    /** Slugs from the root, `parent/child`: what category permalinks match on. */
    path: text().notNull(),
    meta: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    sort: integer().notNull().default(0),
    legacyId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique().on(t.siteId, t.id),
    unique().on(t.siteId, t.taxonomy, t.parentId, t.slug).nullsNotDistinct(),
    foreignKey({
      columns: [t.siteId, t.parentId],
      foreignColumns: [t.siteId, t.id],
    }).onDelete('restrict'),
    check('terms_tag_parent', sql`${t.parentId} is null or ${t.taxonomy} = 'category'`),
    index().on(t.siteId, t.taxonomy, t.path),
    tenantPolicy('terms'),
  ],
).enableRLS();

export const postTerms = pgTable(
  'post_terms',
  {
    siteId: siteRef(),
    postId: uuid().notNull(),
    termId: uuid().notNull(),
    /** One primary category per post: breadcrumbs and `%category%` permalinks. */
    isPrimary: boolean().notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.termId] }),
    foreignKey({
      columns: [t.siteId, t.postId],
      foreignColumns: [posts.siteId, posts.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.siteId, t.termId],
      foreignColumns: [terms.siteId, terms.id],
    }).onDelete('cascade'),
    uniqueIndex('post_terms_one_primary')
      .on(t.postId)
      .where(sql`${t.isPrimary}`),
    index().on(t.termId),
    tenantPolicy('post_terms'),
  ],
).enableRLS();

// --- menus --------------------------------------------------------------------------------

export interface MenuItem {
  id: string;
  label: string;
  kind: 'post' | 'term' | 'url';
  /** Post or term id for `post` / `term` items. */
  ref?: string;
  /** For `url` items. */
  url?: string;
  children: MenuItem[];
}

export const menus = pgTable(
  'menus',
  {
    id: id(),
    siteId: siteRef(),
    /** Declared by the theme: `primary`, `footer`, ... */
    location: text().notNull(),
    items: jsonb().$type<MenuItem[]>().notNull().default([]),
    updatedAt: updatedAt(),
  },
  (t) => [unique().on(t.siteId, t.location), tenantPolicy('menus')],
).enableRLS();

// --- flexibility layer: field schemas and collections ---------------------------------------

export const FIELD_TYPES = [
  'text',
  'richtext',
  'number',
  'select',
  'image',
  'url',
  'date',
  'boolean',
  'reference',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldDef {
  key: string;
  label: string | Record<string, string>;
  type: FieldType;
  required?: boolean;
  /** `select` only. */
  options?: { value: string; label?: string | Record<string, string> }[];
}

export const fieldSchemas = pgTable(
  'field_schemas',
  {
    id: id(),
    siteId: siteRef(),
    /** `term:category` | `term:tag` | `collection:<key>` */
    target: text().notNull(),
    fields: jsonb().$type<FieldDef[]>().notNull().default([]),
    updatedAt: updatedAt(),
  },
  (t) => [unique().on(t.siteId, t.target), tenantPolicy('field_schemas')],
).enableRLS();

export const COLLECTION_SORT_MODES = ['manual', 'created_desc'] as const;

export const collections = pgTable(
  'collections',
  {
    id: id(),
    siteId: siteRef(),
    key: text().notNull(),
    label: text().notNull(),
    sortMode: text({ enum: COLLECTION_SORT_MODES }).notNull().default('manual'),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.siteId, t.key), unique().on(t.siteId, t.id), tenantPolicy('collections')],
).enableRLS();

export const ENTRY_STATUSES = ['draft', 'published'] as const;

export const collectionEntries = pgTable(
  'collection_entries',
  {
    id: id(),
    siteId: siteRef(),
    collectionId: uuid().notNull(),
    /** Validated against the collection's field schema. */
    data: jsonb().$type<Record<string, unknown>>().notNull(),
    sort: integer().notNull().default(0),
    status: text({ enum: ENTRY_STATUSES }).notNull().default('published'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.siteId, t.collectionId],
      foreignColumns: [collections.siteId, collections.id],
    }).onDelete('cascade'),
    index().on(t.collectionId, t.sort),
    tenantPolicy('collection_entries'),
  ],
).enableRLS();

// --- forms --------------------------------------------------------------------------------

export const FORM_FIELD_TYPES = [
  'text',
  'textarea',
  'email',
  'tel',
  'number',
  'select',
  'checkbox',
  'date',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormField {
  key: string;
  label: string | Record<string, string>;
  type: FormFieldType;
  required?: boolean;
  /** `select` only. */
  options?: { value: string; label?: string | Record<string, string> }[];
}

/** Contact-style forms rendered by core (`{% form 'key' %}`); themes style them, never replace them. */
export const forms = pgTable(
  'forms',
  {
    id: id(),
    siteId: siteRef(),
    key: text().notNull(),
    fields: jsonb().$type<FormField[]>().notNull(),
    notifyEmails: text().array().notNull().default([]),
    successMessage: text().notNull().default(''),
    /** When set, a required consent checkbox with this text (KVKK/GDPR). */
    consentText: text().notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique().on(t.siteId, t.key), unique().on(t.siteId, t.id), tenantPolicy('forms')],
).enableRLS();

export const SUBMISSION_STATUSES = ['new', 'read', 'spam'] as const;

export const formSubmissions = pgTable(
  'form_submissions',
  {
    id: id(),
    siteId: siteRef(),
    formId: uuid().notNull(),
    data: jsonb().$type<Record<string, string | number | boolean>>().notNull(),
    ipHash: text(),
    status: text({ enum: SUBMISSION_STATUSES }).notNull().default('new'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.siteId, t.formId],
      foreignColumns: [forms.siteId, forms.id],
    }).onDelete('cascade'),
    index().on(t.formId, t.createdAt.desc()),
    index().on(t.formId, t.ipHash, t.createdAt),
    tenantPolicy('form_submissions'),
  ],
).enableRLS();

// --- page cache -------------------------------------------------------------------------

/** A cached public page; the HTML is a file named after `id` (see the server's page cache). */
export const pageCache = pgTable(
  'page_cache',
  {
    id: id(),
    siteId: siteRef(),
    path: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.siteId, t.path), unique().on(t.siteId, t.id), tenantPolicy('page_cache')],
).enableRLS();

/** What a cached page shows (`post:<id>`, `lists`, `menus`, ...); writes purge by tag. */
export const pageCacheTags = pgTable(
  'page_cache_tags',
  {
    siteId: siteRef(),
    cacheId: uuid().notNull(),
    tag: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cacheId, t.tag] }),
    foreignKey({
      columns: [t.siteId, t.cacheId],
      foreignColumns: [pageCache.siteId, pageCache.id],
    }).onDelete('cascade'),
    index().on(t.siteId, t.tag),
    tenantPolicy('page_cache_tags'),
  ],
).enableRLS();

// --- redirects ----------------------------------------------------------------------------

export const REDIRECT_SOURCES = ['manual', 'import', 'slug_change'] as const;

export const redirects = pgTable(
  'redirects',
  {
    id: id(),
    siteId: siteRef(),
    /** Decoded path, e.g. `/eski-yazı/`; matched with or without the trailing slash. */
    fromPath: text().notNull(),
    /** A `/path` or an absolute http(s) URL; empty for 410. */
    to: text().notNull().default(''),
    code: integer().notNull().default(301),
    source: text({ enum: REDIRECT_SOURCES }).notNull().default('manual'),
    hits: integer().notNull().default(0),
    lastHitAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.siteId, t.fromPath),
    check('redirects_code', sql`${t.code} in (301, 302, 410)`),
    tenantPolicy('redirects'),
  ],
).enableRLS();

// --- slots --------------------------------------------------------------------------------

/** Admin-managed raw HTML for places the theme declares (ads, analytics, banners). */
export const slots = pgTable(
  'slots',
  {
    id: id(),
    siteId: siteRef(),
    key: text().notNull(),
    html: text().notNull().default(''),
    enabled: boolean().notNull().default(false),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [unique().on(t.siteId, t.key), tenantPolicy('slots')],
).enableRLS();

// --- themes ---------------------------------------------------------------------------------
// Bundled themes have no site (visible to every site, written only by the owner role at
// startup); themes made for a site (upload, MCP) belong to it.

const sharedOrTenant = (table: string) => [
  pgPolicy(`${table}_read`, {
    for: 'select',
    using: sql.raw(`site_id is null or ${TENANT_POLICY_CONDITION}`),
  }),
  pgPolicy(`${table}_write`, {
    for: 'all',
    using: sql.raw(TENANT_POLICY_CONDITION),
    withCheck: sql.raw(TENANT_POLICY_CONDITION),
  }),
];

export const THEME_ORIGINS = ['bundled', 'upload', 'mcp', 'git'] as const;

export const themes = pgTable(
  'themes',
  {
    id: id(),
    siteId: uuid().references(() => sites.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    name: text().notNull(),
    origin: text({ enum: THEME_ORIGINS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.siteId, t.slug).nullsNotDistinct(),
    unique().on(t.siteId, t.id),
    ...sharedOrTenant('themes'),
  ],
).enableRLS();

export const THEME_VERSION_STATUSES = ['draft', 'valid', 'invalid', 'active', 'archived'] as const;

export const themeVersions = pgTable(
  'theme_versions',
  {
    id: id(),
    siteId: uuid().references(() => sites.id, { onDelete: 'cascade' }),
    themeId: uuid()
      .notNull()
      .references(() => themes.id, { onDelete: 'cascade' }),
    version: text().notNull(),
    status: text({ enum: THEME_VERSION_STATUSES }).notNull(),
    /** theme.json */
    manifest: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Where the files are: `bundled/<slug>` (shipped in the image) or a path on the themes volume. */
    storagePath: text().notNull(),
    validationReport: jsonb(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdVia: text({ enum: CHANNELS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.themeId, t.version),
    // A site's version must belong to that site's theme (FK checks bypass RLS). Bundled
    // versions have no site, so only the plain theme FK applies to them.
    foreignKey({ columns: [t.siteId, t.themeId], foreignColumns: [themes.siteId, themes.id] }),
    ...sharedOrTenant('theme_versions'),
  ],
).enableRLS();

/** A site's values for a theme's `settings`; kept per theme so switching back restores them. */
export const themeSettings = pgTable(
  'theme_settings',
  {
    siteId: siteRef(),
    themeId: uuid()
      .notNull()
      .references(() => themes.id, { onDelete: 'cascade' }),
    values: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Static sections (`{% section 'name' %}`), by name. */
    sections: jsonb().$type<Record<string, Omit<SectionInstance, 'type'>>>().notNull().default({}),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.themeId] }), tenantPolicy('theme_settings')],
).enableRLS();
