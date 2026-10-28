import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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
