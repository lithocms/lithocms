import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
