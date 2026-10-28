import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations, withSite, type Db } from '../db/client.js';
import { sites, themes, themeVersions } from '../db/schema.js';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import { registerBundledTheme, siteThemeVersion } from './registry.js';

const fails = (cause: RegExp) => ({ cause: { message: expect.stringMatching(cause) as unknown } });

let tdb: TestDatabase;
let db: Db;
let owner: Db;
const pools: Pool[] = [];
let siteA: string;
let siteB: string;

const bundled = (slug: string, version: string, valid = true) => ({
  slug,
  name: slug,
  version,
  manifest: { slug, version },
  valid,
  report: { errors: [] },
});

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  const app = createDb(tdb.appUrl);
  const own = createDb(tdb.ownerUrl);
  [db, owner] = [app.db, own.db];
  pools.push(app.pool, own.pool);
  [siteA, siteB] = (
    await db
      .insert(sites)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning()
  ).map((s) => s.id) as [string, string];
});

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
  await tdb.stop();
});

describe('theme registry', () => {
  it('registers bundled versions idempotently and picks the default', async () => {
    await registerBundledTheme(owner, bundled('corporate', '1.0.0'));
    const again = await registerBundledTheme(owner, bundled('corporate', '1.0.0'));
    await registerBundledTheme(owner, bundled('broken', '1.0.0', false));
    expect(await owner.select().from(themeVersions)).toHaveLength(2);

    const pick = (defaults: string[]) =>
      withSite(db, siteA, (tx) => siteThemeVersion(tx, siteA, defaults));
    expect((await pick(['corporate']))?.id).toBe(again.id);
    // Invalid bundled versions are never chosen.
    expect((await pick(['broken', 'corporate']))?.id).toBe(again.id);
    expect(await pick(['missing'])).toBeUndefined();
  });

  it("uses a site's active version, but never another site's", async () => {
    const [theme] = await withSite(db, siteB, (tx) =>
      tx
        .insert(themes)
        .values({ siteId: siteB, slug: 'mine', name: 'Mine', origin: 'mcp' })
        .returning(),
    );
    const [version] = await withSite(db, siteB, (tx) =>
      tx
        .insert(themeVersions)
        .values({
          siteId: siteB,
          themeId: theme!.id,
          version: '0.1.0',
          status: 'valid',
          manifest: {},
          storagePath: 'x',
          createdVia: 'mcp',
        })
        .returning(),
    );
    await db.update(sites).set({ activeThemeVersionId: version!.id }).where(eq(sites.id, siteB));
    expect((await withSite(db, siteB, (tx) => siteThemeVersion(tx, siteB, [])))?.id).toBe(
      version!.id,
    );

    // Site A pointing at B's version falls back to the default.
    await db.update(sites).set({ activeThemeVersionId: version!.id }).where(eq(sites.id, siteA));
    const used = await withSite(db, siteA, (tx) => siteThemeVersion(tx, siteA, ['corporate']));
    expect(used?.storagePath).toBe('bundled/corporate');
  });
});

describe('theme row-level security', () => {
  it('shows bundled themes to every site and site themes only to their site', async () => {
    const visible = (siteId: string) =>
      withSite(db, siteId, async (tx) =>
        (await tx.select().from(themes)).map((t) => t.slug).sort(),
      );
    expect(await visible(siteA)).toEqual(['broken', 'corporate']);
    expect(await visible(siteB)).toEqual(['broken', 'corporate', 'mine']);
  });

  it('keeps the runtime role from writing bundled themes', async () => {
    await expect(
      withSite(db, siteA, (tx) =>
        tx.insert(themes).values({ slug: 'fake', name: 'Fake', origin: 'bundled' }),
      ),
    ).rejects.toMatchObject(fails(/row-level security/));
    const changed = await withSite(db, siteA, (tx) =>
      tx.update(themes).set({ name: 'pwned' }).where(eq(themes.slug, 'corporate')).returning(),
    );
    expect(changed).toEqual([]);
  });

  it("keeps a site from attaching versions to another site's theme", async () => {
    const [theirs] = await owner.select().from(themes).where(eq(themes.slug, 'mine'));
    await expect(
      withSite(db, siteA, (tx) =>
        tx.insert(themeVersions).values({
          siteId: siteA,
          themeId: theirs!.id,
          version: '9.9.9',
          status: 'draft',
          manifest: {},
          storagePath: 'x',
          createdVia: 'mcp',
        }),
      ),
    ).rejects.toMatchObject(fails(/foreign key/));
  });
});
