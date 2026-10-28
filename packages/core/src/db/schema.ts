import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
  status: text({ enum: ['active', 'maintenance', 'disabled'] })
    .notNull()
    .default('active'),
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
  },
  (t) => [
    unique().on(t.siteId, t.id),
    unique().on(t.siteId, t.type, t.parentId, t.slug).nullsNotDistinct(),
    foreignKey({
      columns: [t.siteId, t.parentId],
      foreignColumns: [t.siteId, t.id],
    }).onDelete('restrict'),
    check('posts_page_parent', sql`${t.parentId} is null or ${t.type} = 'page'`),
    index().on(t.siteId, t.type, t.status, t.publishedAt.desc()),
    index().on(t.siteId, t.slug),
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
