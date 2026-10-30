import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations, withSite, type Db, type Tx } from '../db/client.js';
import { sites, users } from '../db/schema.js';
import { Conflict, Forbidden, ValidationFailed } from '../errors.js';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import type { Actor } from './audit.js';
import {
  CollectionCreateInput,
  createCollection,
  deleteEntry,
  EntryInput,
  EntryListQuery,
  listEntries,
  updateCollection,
  upsertEntry,
} from './collections.js';
import { createPost, PostCreateInput } from './posts.js';

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let siteA: string;
let siteB: string;
let editor: Actor;
let author: Actor;

const inA = <T>(fn: (tx: Tx) => Promise<T>) => withSite(db, siteA, fn);
const entry = (data: Record<string, unknown>, id?: string, actor = editor) =>
  inA((tx) => upsertEntry(tx, siteA, actor, 'branches', id, EntryInput.parse({ data })));

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  ({ db, pool } = createDb(tdb.appUrl));
  [siteA, siteB] = (
    await db
      .insert(sites)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning()
  ).map((s) => s.id) as [string, string];
  const [u] = await db.insert(users).values({ name: 'E', email: 'e@example.com' }).returning();
  editor = { userId: u!.id, role: 'editor', channel: 'admin' };
  author = { ...editor, role: 'author' };
  await inA((tx) =>
    createCollection(
      tx,
      siteA,
      editor,
      CollectionCreateInput.parse({
        key: 'branches',
        label: 'Şubeler',
        fields: [
          { key: 'name', label: { tr: 'Ad', en: 'Name' }, type: 'text', required: true },
          {
            key: 'city',
            label: 'City',
            type: 'select',
            options: [{ value: 'ist' }, { value: 'ank' }],
          },
          { key: 'phone', label: 'Phone', type: 'text' },
          { key: 'website', label: 'Website', type: 'url' },
          { key: 'opened', label: 'Opened', type: 'date' },
          { key: 'page', label: 'Page', type: 'reference' },
        ],
      }),
    ),
  );
});

afterAll(async () => {
  await pool.end();
  await tdb.stop();
});

describe('collections', () => {
  it('stores entries validated by the field schema', async () => {
    const saved = await entry({
      name: 'Kadıköy',
      city: 'ist',
      opened: '2020-05-01',
      website: 'https://ex.com',
    });
    expect(saved.data).toEqual({
      name: 'Kadıköy',
      city: 'ist',
      opened: '2020-05-01',
      website: 'https://ex.com',
    });
    const updated = await entry({ name: 'Kadıköy Şubesi' }, saved.id);
    expect(updated.data).toEqual({ name: 'Kadıköy Şubesi' });
    const list = await inA((tx) => listEntries(tx, siteA, 'branches', EntryListQuery.parse({})));
    expect(list.map((e) => e.id)).toEqual([saved.id]);
  });

  it.each([
    ['a missing required field', { city: 'ist' }, 'name'],
    ['an unknown field', { name: 'x', extra: 1 }, ''],
    ['an unknown option', { name: 'x', city: 'izmir' }, 'city'],
    ['a javascript: URL', { name: 'x', website: 'javascript:alert(1)' }, 'website'],
    ['a malformed date', { name: 'x', opened: '01/05/2020' }, 'opened'],
    ['a malformed reference', { name: 'x', page: 'abc' }, 'page'],
  ])('rejects %s', async (_name, data, path) => {
    const error = await entry(data).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationFailed);
    expect((error as ValidationFailed).issues[0]!.path).toEqual(path ? ['data', path] : ['data']);
  });

  it('rejects references to another site', async () => {
    const theirs = await withSite(db, siteB, (tx) =>
      createPost(tx, siteB, editor, PostCreateInput.parse({ type: 'page', title: 'B' })),
    );
    await expect(
      entry({ name: 'x', page: { kind: 'post', id: theirs.id } }),
    ).rejects.toBeInstanceOf(ValidationFailed);
  });

  it('checks permissions, duplicate keys and schema rules', async () => {
    await expect(entry({ name: 'x' }, undefined, author)).rejects.toBeInstanceOf(Forbidden);
    await expect(
      inA((tx) =>
        createCollection(
          tx,
          siteA,
          editor,
          CollectionCreateInput.parse({ key: 'branches', label: 'x', fields: [] }),
        ),
      ),
    ).rejects.toBeInstanceOf(Conflict);
    for (const fields of [
      [{ key: 'id', label: 'x', type: 'text' }],
      [{ key: 'a', label: 'x', type: 'select' }],
      [{ key: 'a', label: 'x', type: 'text', options: [{ value: 'x' }] }],
      [
        { key: 'a', label: 'x', type: 'text' },
        { key: 'a', label: 'y', type: 'text' },
      ],
    ]) {
      expect(CollectionCreateInput.safeParse({ key: 'k', label: 'k', fields }).success).toBe(false);
    }
  });

  it('validates new entries against changed fields and deletes entries', async () => {
    await inA((tx) =>
      updateCollection(tx, siteA, editor, 'branches', {
        fields: [{ key: 'title', label: 'Title', type: 'text', required: true }],
      }),
    );
    await expect(entry({ name: 'old field' })).rejects.toBeInstanceOf(ValidationFailed);
    const fresh = await entry({ title: 'New' });
    await inA((tx) => deleteEntry(tx, siteA, editor, 'branches', fresh.id));
    const list = await inA((tx) => listEntries(tx, siteA, 'branches', EntryListQuery.parse({})));
    expect(list.map((e) => e.id)).not.toContain(fresh.id);
  });
});
