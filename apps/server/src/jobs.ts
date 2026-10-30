import {
  formNotification,
  processVariants,
  withSite,
  type Db,
  type MediaStore,
  type Tx,
  type VariantQueue,
} from '@lithocms/core';
import { sql } from 'drizzle-orm';
import { fromDrizzle, PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import type { Mailer } from './mailer.js';
import type { PageCache } from './page-cache.js';

// Background jobs on pg-boss. The owner role installs and migrates the `pgboss` schema at
// startup; the app runs the queue as the runtime role.

const SCHEMA = 'pgboss';
const QUEUES = {
  formNotify: 'form-notify',
  cacheSweep: 'cache-sweep',
  mediaVariants: 'media-variants',
} as const;

interface FormNotifyJob {
  siteId: string;
  submissionId: string;
}

interface MediaVariantsJob {
  siteId: string;
  mediaId: string;
}

export interface Jobs {
  /** Queues the notification email in `tx`, so it is only sent if the submission commits. */
  notifyForm(tx: Tx, siteId: string, submissionId: string): Promise<void>;
  /** Queues an upload's image variants in its transaction. */
  queueVariants: VariantQueue;
  stop(): Promise<void>;
}

/** Creates or migrates the queue schema and lets `appRole` use it. Run as the owner role. */
export async function installJobs(ownerUrl: string, ownerDb: Db, appRole: string) {
  const boss = new PgBoss({
    connectionString: ownerUrl,
    schema: SCHEMA,
    max: 1,
    supervise: false,
    schedule: false,
  });
  await boss.start();
  for (const name of Object.values(QUEUES)) {
    if (!(await boss.getQueue(name))) {
      // SMTP hiccups are common: back off up to about an hour. Variants retry the same way.
      await boss.createQueue(name, { retryLimit: 6, retryDelay: 60, retryBackoff: true });
    }
  }
  await boss.stop();
  const role = sql.identifier(appRole);
  await ownerDb.execute(sql`grant usage on schema ${sql.identifier(SCHEMA)} to ${role}`);
  await ownerDb.execute(
    sql`grant select, insert, update, delete on all tables in schema ${sql.identifier(SCHEMA)} to ${role}`,
  );
  await ownerDb.execute(
    sql`grant usage, select on all sequences in schema ${sql.identifier(SCHEMA)} to ${role}`,
  );
  await ownerDb.execute(
    sql`grant execute on all functions in schema ${sql.identifier(SCHEMA)} to ${role}`,
  );
}

/** Starts the workers. Without a mailer, form notifications are not queued at all. */
export async function startJobs({
  url,
  db,
  store,
  mailer,
  cache,
  log,
}: {
  url: string;
  db: Db;
  store: MediaStore;
  mailer: Mailer | null;
  cache?: PageCache;
  log: Logger;
}): Promise<Jobs> {
  const boss = new PgBoss({ connectionString: url, schema: SCHEMA, migrate: false });
  boss.on('error', (err) => log.error({ err }, 'job queue error'));
  await boss.start();
  if (cache) {
    await boss.schedule(QUEUES.cacheSweep, '*/15 * * * *');
    await boss.work(QUEUES.cacheSweep, () => cache.sweep());
  }
  // One image at a time per process: resizing is CPU-bound.
  await boss.work<MediaVariantsJob>(QUEUES.mediaVariants, async ([job]) => {
    const { siteId, mediaId } = job!.data;
    await processVariants(db, store, siteId, mediaId);
  });
  if (mailer) {
    await boss.work<FormNotifyJob>(QUEUES.formNotify, async ([job]) => {
      const { siteId, submissionId } = job!.data;
      const mail = await withSite(db, siteId, (tx) => formNotification(tx, siteId, submissionId));
      if (mail) await mailer.send(mail);
    });
  } else {
    log.warn('SMTP_URL is not set: form notifications are not sent');
  }
  return {
    async notifyForm(tx, siteId, submissionId) {
      if (!mailer) return;
      await boss.send(QUEUES.formNotify, { siteId, submissionId } satisfies FormNotifyJob, {
        db: fromDrizzle(tx, sql),
      });
    },
    async queueVariants(tx, siteId, mediaId) {
      await boss.send(QUEUES.mediaVariants, { siteId, mediaId } satisfies MediaVariantsJob, {
        db: fromDrizzle(tx, sql),
      });
    },
    stop: () => boss.stop(),
  };
}
