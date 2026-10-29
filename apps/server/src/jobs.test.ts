import {
  createDb,
  FormUpsertInput,
  runMigrations,
  schema,
  upsertForm,
  withSite,
  type Db,
} from '@lithocms/core';
import { startTestDatabase, type TestDatabase } from '@lithocms/core/testing';
import type { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installJobs, startJobs, type Jobs } from './jobs.js';
import type { Mail } from './mailer.js';

let tdb: TestDatabase;
let db: Db;
let pools: Pool[];
let jobs: Jobs;
let siteId: string;
let formId: string;
const sent: Mail[] = [];

const submission = (email: string) =>
  withSite(db, siteId, async (tx) => {
    const [row] = await tx
      .insert(schema.formSubmissions)
      .values({ siteId, formId, data: { email }, ipHash: 'x' })
      .returning();
    await jobs.notifyForm(tx, siteId, row!.id);
  });

async function until(check: () => boolean, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out');
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  const owner = createDb(tdb.ownerUrl);
  const app = createDb(tdb.appUrl);
  db = app.db;
  pools = [owner.pool, app.pool];
  await installJobs(tdb.ownerUrl, owner.db, 'lithocms_app');
  // A second install (next start of the app) is a no-op.
  await installJobs(tdb.ownerUrl, owner.db, 'lithocms_app');
  const [site] = await owner.db.insert(schema.sites).values({ name: 'Örnek' }).returning();
  siteId = site!.id;
  const [user] = await owner.db
    .insert(schema.users)
    .values({ name: 'A', email: 'a@example.com' })
    .returning();
  const form = await withSite(db, siteId, (tx) =>
    upsertForm(
      tx,
      siteId,
      { userId: user!.id, role: 'admin', channel: 'admin' },
      'contact',
      FormUpsertInput.parse({
        fields: [{ key: 'email', label: 'E-posta', type: 'email', required: true }],
        notifyEmails: ['owner@example.com'],
      }),
    ),
  );
  formId = form.id;
  jobs = await startJobs({
    url: tdb.appUrl,
    db,
    mailer: {
      send: (mail) => {
        sent.push(mail);
        return Promise.resolve();
      },
    },
    log: pino({ level: 'silent' }),
  });
});

afterAll(async () => {
  await jobs.stop();
  await Promise.all(pools.map((p) => p.end()));
  await tdb.stop();
});

describe('form notifications', () => {
  it('are sent for committed submissions only, by the runtime role', async () => {
    await submission('first@example.com');
    await expect(
      withSite(db, siteId, async (tx) => {
        const [row] = await tx
          .insert(schema.formSubmissions)
          .values({ siteId, formId, data: { email: 'never@example.com' }, ipHash: 'x' })
          .returning();
        await jobs.notifyForm(tx, siteId, row!.id);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await submission('second@example.com');
    await until(() => sent.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    // The rolled-back submission's job was never queued.
    expect(sent.map((m) => m.replyTo).sort()).toEqual(['first@example.com', 'second@example.com']);
    expect(sent[0]).toMatchObject({
      to: ['owner@example.com'],
      subject: '[Örnek] New form submission (contact)',
    });
  }, 30_000);
});
