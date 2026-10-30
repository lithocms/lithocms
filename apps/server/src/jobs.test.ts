import {
  createDb,
  createDiskStore,
  FormUpsertInput,
  getMedia,
  runMigrations,
  schema,
  uploadMedia,
  upsertForm,
  withSite,
  type Actor,
  type Db,
  type MediaStore,
} from '@lithocms/core';
import { startTestDatabase, type TestDatabase } from '@lithocms/core/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import sharp from 'sharp';
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
let actor: Actor;
let mediaDir: string;
let store: MediaStore;
const sent: Mail[] = [];

const submission = (email: string) =>
  withSite(db, siteId, async (tx) => {
    const [row] = await tx
      .insert(schema.formSubmissions)
      .values({ siteId, formId, data: { email }, ipHash: 'x' })
      .returning();
    await jobs.notifyForm(tx, siteId, row!.id);
  });

async function until(check: () => boolean | Promise<boolean>, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
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
  actor = { userId: user!.id, role: 'admin', channel: 'admin' };
  mediaDir = await mkdtemp(join(tmpdir(), 'litho-jobs-'));
  store = createDiskStore(mediaDir);
  jobs = await startJobs({
    url: tdb.appUrl,
    db,
    store,
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
  await rm(mediaDir, { recursive: true, force: true });
});

describe('image variants', () => {
  it('are made in the background once the upload commits', async () => {
    const data = await sharp({
      create: { width: 900, height: 600, channels: 3, background: '#3366cc' },
    })
      .jpeg()
      .toBuffer();
    const row = await withSite(db, siteId, (tx) =>
      uploadMedia(tx, store, siteId, actor, { data, filename: 'a.jpg' }, jobs.queueVariants),
    );
    expect(row.variants).toEqual([]);
    const variants = async () =>
      (await withSite(db, siteId, (tx) => getMedia(tx, siteId, row.id))).variants;
    await until(async () => (await variants()).length > 0);
    expect((await variants()).map((v) => `${v.width}.${v.format}`)).toEqual([
      '400.webp',
      '400.avif',
      '800.webp',
      '800.avif',
    ]);
    expect(await store.open(`${siteId}/${(await variants())[0]!.path}`)).not.toBeNull();
  }, 30_000);
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
