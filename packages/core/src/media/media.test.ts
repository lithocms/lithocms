import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../content/audit.js';
import { DocInput } from '../content/input.js';
import { createPost, PostCreateInput } from '../content/posts.js';
import { createDb, runMigrations, withSite, type Db, type Tx } from '../db/client.js';
import { sites, users } from '../db/schema.js';
import { Forbidden, NotFound, ValidationFailed } from '../errors.js';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import {
  getMedia,
  listMedia,
  MediaListQuery,
  updateMedia,
  uploadMedia,
  type UploadInput,
} from './media.js';
import { createDiskStore, type MediaStore } from './store.js';

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let dir: string;
let store: MediaStore;
let siteA: string;
let siteB: string;
let editor: Actor;
let author: Actor;

const inA = <T>(fn: (tx: Tx) => Promise<T>) => withSite(db, siteA, fn);
const upload = (actor: Actor, input: UploadInput, siteId = siteA) =>
  withSite(db, siteId, (tx) => uploadMedia(tx, store, siteId, actor, input));
const file = async (path: string) => readFile(join(dir, siteA, path));

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#3366cc' } });

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  ({ db, pool } = createDb(tdb.appUrl));
  dir = await mkdtemp(join(tmpdir(), 'litho-media-'));
  store = createDiskStore(dir);
  [siteA, siteB] = (
    await db
      .insert(sites)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning()
  ).map((s) => s.id) as [string, string];
  const [e, a] = await db
    .insert(users)
    .values([
      { name: 'Editor', email: 'editor@example.com' },
      { name: 'Author', email: 'author@example.com' },
    ])
    .returning();
  editor = { userId: e!.id, role: 'editor', channel: 'admin' };
  author = { userId: a!.id, role: 'author', channel: 'admin' };
});

afterAll(async () => {
  await pool.end();
  await tdb.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('uploadMedia', () => {
  it('re-encodes, applies orientation, drops EXIF and makes variants', async () => {
    // 2000x1000 stored sideways (orientation 6 = rotate 90°), with camera metadata.
    const data = await solid(2000, 1000)
      .jpeg()
      .withMetadata({
        orientation: 6,
        exif: { IFD0: { Copyright: 'Someone', Artist: 'GPS here' } },
      })
      .toBuffer();
    const row = await upload(author, { data, filename: 'photo.png', alt: 'Blue' });

    expect(row).toMatchObject({ mime: 'image/jpeg', width: 1000, height: 2000, alt: 'Blue' });
    expect(row.path).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
    const stored = await sharp(await file(row.path)).metadata();
    expect(stored).toMatchObject({ width: 1000, height: 2000 });
    expect(stored.exif).toBeUndefined();
    expect(stored.orientation).toBeUndefined();
    expect(row.variants.map((v) => `${v.width}.${v.format}`)).toEqual([
      '400.webp',
      '400.avif',
      '800.webp',
      '800.avif',
    ]);
    const variant = await sharp(await file(row.variants[0]!.path)).metadata();
    expect(variant).toMatchObject({ format: 'webp', width: 400 });
  });

  it('keeps small images without variants and sniffs the real format', async () => {
    const data = await solid(300, 200).png().toBuffer();
    const row = await upload(author, { data, filename: 'looks-like.jpg' });
    expect(row).toMatchObject({ mime: 'image/png', width: 300, variants: [] });
    expect(row.path.endsWith('.png')).toBe(true);
  });

  it('makes only WebP variants for animated images', async () => {
    const frame = (background: string) =>
      sharp({ create: { width: 600, height: 400, channels: 4, background } })
        .png()
        .toBuffer();
    const data = await sharp([await frame('#f00'), await frame('#00f')], {
      join: { animated: true },
    })
      .gif()
      .toBuffer();
    const row = await upload(author, { data, filename: 'anim.gif' });
    expect(row).toMatchObject({ mime: 'image/gif', width: 600, height: 400 });
    expect(row.variants.length).toBeGreaterThan(0);
    expect(row.variants.every((v) => v.format === 'webp')).toBe(true);
  });

  it.each([
    ['text', Buffer.from('hello world')],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>')],
  ])('rejects %s', async (_name, data) => {
    await expect(upload(author, { data, filename: 'x.jpg' })).rejects.toBeInstanceOf(
      ValidationFailed,
    );
  });

  it('rejects files over the size limit', async () => {
    const data = Buffer.alloc(20 * 1024 * 1024 + 1);
    await expect(upload(author, { data, filename: 'big.jpg' })).rejects.toThrow(/20 MB/);
  });
});

describe('media access', () => {
  it('lists, searches and pages', async () => {
    const page = await inA((tx) => listMedia(tx, siteA, MediaListQuery.parse({ limit: 1 })));
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const found = await inA((tx) => listMedia(tx, siteA, MediaListQuery.parse({ query: 'blue' })));
    expect(found.items.map((m) => m.alt)).toEqual(['Blue']);
  });

  it('lets uploaders edit their own media and editors any', async () => {
    const data = await solid(100, 100).png().toBuffer();
    const mine = await upload(editor, { data, filename: 'e.png' });
    await expect(
      inA((tx) => updateMedia(tx, siteA, author, mine.id, { alt: 'x' })),
    ).rejects.toBeInstanceOf(Forbidden);
    const updated = await inA((tx) => updateMedia(tx, siteA, editor, mine.id, { alt: 'Square' }));
    expect(updated.alt).toBe('Square');
  });

  it('keeps media inside its site', async () => {
    const data = await solid(100, 100).png().toBuffer();
    const theirs = await upload(editor, { data, filename: 'b.png' }, siteB);
    await expect(inA((tx) => getMedia(tx, siteA, theirs.id))).rejects.toBeInstanceOf(NotFound);
    await expect(
      inA((tx) =>
        createPost(
          tx,
          siteA,
          editor,
          PostCreateInput.parse({ type: 'post', title: 'X', featuredMediaId: theirs.id }),
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationFailed);
  });

  it('renders images in content with their variants', async () => {
    const data = await solid(1000, 500).jpeg().toBuffer();
    const image = await upload(editor, { data, filename: 'wide.jpg', alt: 'Wide' });
    const post = await inA((tx) =>
      createPost(
        tx,
        siteA,
        editor,
        PostCreateInput.parse({
          type: 'post',
          title: 'With image',
          featuredMediaId: image.id,
          content: DocInput.parse({
            type: 'doc',
            content: [{ type: 'image', attrs: { mediaId: image.id, alt: 'Wide', title: null } }],
          }),
        }),
      ),
    );
    expect(post.featuredMediaId).toBe(image.id);
    expect(post.contentHtml).toContain(`src="/media/${image.path}"`);
    expect(post.contentHtml).toContain('width="1000"');
    expect(post.contentHtml).toMatch(
      /srcset="\/media\/\S+-400\.webp 400w, \/media\/\S+-800\.webp 800w, \/media\/\S+\.jpg 1000w"/,
    );
  });
});

describe('disk store', () => {
  it('refuses keys outside its root', async () => {
    await expect(store.put('../escape.txt', Buffer.from('x'))).rejects.toThrow(/Invalid media key/);
    await expect(store.open('a/../../etc/passwd')).rejects.toThrow(/Invalid media key/);
    expect(await store.open(`${siteA}/missing.jpg`)).toBeNull();
  });
});
