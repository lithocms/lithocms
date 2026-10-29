import { createDb, createDiskStore, runMigrations } from '@lithocms/core';
import { buildApp } from './app.js';
import { createAuth } from './auth.js';
import { loadConfig } from './config.js';
import { installJobs, startJobs } from './jobs.js';
import { smtpMailer } from './mailer.js';
import { createSiteResolver } from './sites.js';
import { loadBundledThemes } from './themes.js';
import { pino } from 'pino';

const config = loadConfig();

await runMigrations(config.DATABASE_OWNER_URL);
const log = pino({ level: config.LOG_LEVEL });
const owner = createDb(config.DATABASE_OWNER_URL, 1);
const themes = await loadBundledThemes(config.THEMES_DIR, owner.db, config.DEFAULT_THEME, log);
const appRole = decodeURIComponent(new URL(config.DATABASE_URL).username);
await installJobs(config.DATABASE_OWNER_URL, owner.db, appRole);
await owner.pool.end();
const { db, pool } = createDb(config.DATABASE_URL);
const jobs = await startJobs({
  url: config.DATABASE_URL,
  db,
  mailer: config.SMTP_URL
    ? smtpMailer(
        config.SMTP_URL,
        config.MAIL_FROM ?? `LithoCMS <noreply@${config.ADMIN_URL.hostname}>`,
      )
    : null,
  log,
});
const app = buildApp({
  db,
  sites: await createSiteResolver(db),
  adminUrl: config.ADMIN_URL,
  auth: createAuth({ db, adminUrl: config.ADMIN_URL, secret: config.AUTH_SECRET }),
  secret: config.AUTH_SECRET,
  store: createDiskStore(config.MEDIA_DIR),
  themes,
  jobs,
  logLevel: config.LOG_LEVEL,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => jobs.stop())
      .then(() => pool.end())
      .finally(() => process.exit(0));
  });
}

await app.listen({ port: config.PORT, host: config.HOST });
