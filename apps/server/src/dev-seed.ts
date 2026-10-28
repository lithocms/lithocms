// Dev stack only (compose.dev.yml): migrate, then make sure DEV_SITE_DOMAIN points to a site.
import { createDb, runMigrations, schema } from '@lithocms/core';
import { loadConfig } from './config.js';

const config = loadConfig();
const domain = process.env.DEV_SITE_DOMAIN ?? 'site.localhost';

await runMigrations(config.DATABASE_OWNER_URL);
const { db, pool } = createDb(config.DATABASE_URL, 1);
await db.transaction(async (tx) => {
  const existing = await tx.query.siteDomains.findFirst({
    where: (d, { eq }) => eq(d.domain, domain),
  });
  if (existing) return;
  const [site] = await tx.insert(schema.sites).values({ name: 'Dev site' }).returning();
  await tx.insert(schema.siteDomains).values({ domain, siteId: site!.id, isPrimary: true });
  console.log(`dev-seed: created "Dev site" on ${domain}`);
});
await pool.end();
