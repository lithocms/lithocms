import { createDb, runMigrations } from '@lithocms/core';
import { buildApp } from './app.js';
import { createAuth } from './auth.js';
import { loadConfig } from './config.js';
import { createSiteResolver } from './sites.js';

const config = loadConfig();

await runMigrations(config.DATABASE_OWNER_URL);
const { db, pool } = createDb(config.DATABASE_URL);
const app = buildApp({
  db,
  sites: await createSiteResolver(db),
  adminUrl: config.ADMIN_URL,
  auth: createAuth({ db, adminUrl: config.ADMIN_URL, secret: config.AUTH_SECRET }),
  secret: config.AUTH_SECRET,
  logLevel: config.LOG_LEVEL,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => pool.end())
      .finally(() => process.exit(0));
  });
}

await app.listen({ port: config.PORT, host: config.HOST });
