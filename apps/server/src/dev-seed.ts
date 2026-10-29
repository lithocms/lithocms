// Dev stack only (compose.dev.yml): migrate, then make sure DEV_SITE_DOMAIN points to a site
// and a dev admin can sign in to it.
import { createDb, createDiskStore, runMigrations, schema } from '@lithocms/core';
import { pino } from 'pino';
import { createAuth, createPasswordUser } from './auth.js';
import { seedDemo } from './dev-demo.js';
import { loadBundledThemes } from './themes.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const domain = process.env.DEV_SITE_DOMAIN ?? 'site.localhost';
const admin = { email: 'admin@example.com', password: 'lithocms-dev' };

await runMigrations(config.DATABASE_OWNER_URL);
const { db, pool } = createDb(config.DATABASE_URL, 1);

let siteId = (await db.query.siteDomains.findFirst({ where: (d, { eq }) => eq(d.domain, domain) }))
  ?.siteId;
if (!siteId) {
  siteId = await db.transaction(async (tx) => {
    const [site] = await tx.insert(schema.sites).values({ name: 'Dev site' }).returning();
    await tx.insert(schema.siteDomains).values({ domain, siteId: site!.id, isPrimary: true });
    return site!.id;
  });
  console.log(`dev-seed: created "Dev site" on ${domain}`);
}

let userId = (await db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, admin.email) }))
  ?.id;
if (!userId) {
  const auth = createAuth({ db, adminUrl: config.ADMIN_URL, secret: config.AUTH_SECRET });
  const user = await createPasswordUser(auth, {
    ...admin,
    name: 'Dev Admin',
    isInstanceOwner: true,
  });
  userId = user.id;
  await db.insert(schema.memberships).values({ userId, siteId, role: 'owner' });
  console.log(`dev-seed: created ${admin.email} / ${admin.password} (owner of "Dev site")`);
}

// Sample content for the bundled theme, on a site without posts only.
const owner = createDb(config.DATABASE_OWNER_URL, 1);
const log = pino({ level: 'warn' });
const themes = await loadBundledThemes(config.THEMES_DIR, owner.db, config.DEFAULT_THEME, log);
await owner.pool.end();
await seedDemo(db, themes, createDiskStore(config.MEDIA_DIR), siteId, userId);
await pool.end();
