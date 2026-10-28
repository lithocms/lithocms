// Dev stack only (compose.dev.yml): migrate, then make sure DEV_SITE_DOMAIN points to a site
// and a dev admin can sign in to it.
import { createDb, runMigrations, schema } from '@lithocms/core';
import { createAuth, createPasswordUser } from './auth.js';
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

const existing = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, admin.email) });
if (!existing) {
  const auth = createAuth({ db, adminUrl: config.ADMIN_URL, secret: config.AUTH_SECRET });
  const user = await createPasswordUser(auth, {
    ...admin,
    name: 'Dev Admin',
    isInstanceOwner: true,
  });
  await db.insert(schema.memberships).values({ userId: user.id, siteId, role: 'owner' });
  console.log(`dev-seed: created ${admin.email} / ${admin.password} (owner of "Dev site")`);
}
await pool.end();
