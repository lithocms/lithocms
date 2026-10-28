import { sql } from 'drizzle-orm';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import { createDb, runMigrations, TENANT_POLICY_CONDITION, withSite, type Db } from './client.js';
import { siteDomains, sites } from './schema.js';

const SITE_A = '0190d6c2-0000-7000-8000-00000000000a';
const SITE_B = '0190d6c2-0000-7000-8000-00000000000b';

// drizzle wraps the driver error; the Postgres message is on `cause`.
const RLS_VIOLATION = {
  cause: { message: expect.stringMatching(/violates row-level security/) as unknown },
};

let tdb: TestDatabase;
let db: Db;
let pool: Pool;

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);

  // A tenant table created by the owner role, exactly as a migration would.
  const owner = new Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  await owner.query(`
    create table rls_probe (id serial primary key, site_id uuid not null, body text not null);
    alter table rls_probe enable row level security;
    create policy rls_probe_tenant on rls_probe
      using (${TENANT_POLICY_CONDITION}) with check (${TENANT_POLICY_CONDITION});
  `);
  await owner.end();

  // One connection, so "outside withSite" runs on a connection that was used inside it.
  ({ db, pool } = createDb(tdb.appUrl, 1));
  await withSite(db, SITE_A, (tx) =>
    tx.execute(sql`insert into rls_probe (site_id, body) values (${SITE_A}, 'a')`),
  );
  await withSite(db, SITE_B, (tx) =>
    tx.execute(sql`insert into rls_probe (site_id, body) values (${SITE_B}, 'b')`),
  );
});

afterAll(async () => {
  await pool.end();
  await tdb.stop();
});

const bodies = async (tx: Pick<Db, 'execute'>) =>
  (await tx.execute<{ body: string }>(sql`select body from rls_probe order by id`)).rows.map(
    (r) => r.body,
  );

describe('runtime role', () => {
  it('is not a superuser, cannot bypass RLS and owns nothing', async () => {
    const { rows } = await db.execute<{ rolsuper: boolean; rolbypassrls: boolean; owned: string }>(
      sql`select rolsuper, rolbypassrls,
            (select count(*) from pg_tables where tableowner = current_user) as owned
          from pg_roles where rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, owned: '0' });
  });

  it('cannot change the schema', async () => {
    await expect(db.execute(sql`create table nope (id int)`)).rejects.toThrow();
    await expect(
      db.execute(sql`alter table rls_probe disable row level security`),
    ).rejects.toThrow();
  });
});

describe('tenant isolation', () => {
  it('returns nothing outside withSite', async () => {
    expect(await bodies(db)).toEqual([]);
  });

  it('refuses writes outside withSite', async () => {
    await expect(
      db.execute(sql`insert into rls_probe (site_id, body) values (${SITE_A}, 'x')`),
    ).rejects.toMatchObject(RLS_VIOLATION);
  });

  it('shows each site only its own rows', async () => {
    expect(await withSite(db, SITE_A, bodies)).toEqual(['a']);
    expect(await withSite(db, SITE_B, bodies)).toEqual(['b']);
  });

  it("does not let site B update or delete site A's rows", async () => {
    await withSite(db, SITE_B, async (tx) => {
      const updated = await tx.execute(
        sql`update rls_probe set body = 'pwned' where site_id = ${SITE_A}`,
      );
      const deleted = await tx.execute(sql`delete from rls_probe where site_id = ${SITE_A}`);
      expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
    });
    expect(await withSite(db, SITE_A, bodies)).toEqual(['a']);
  });

  it('does not let site B write rows for site A', async () => {
    await expect(
      withSite(db, SITE_B, (tx) =>
        tx.execute(sql`insert into rls_probe (site_id, body) values (${SITE_A}, 'x')`),
      ),
    ).rejects.toMatchObject(RLS_VIOLATION);
  });
});

describe('instance tables', () => {
  it('are usable by the runtime role and keep domains lowercase', async () => {
    const [site] = await db.insert(sites).values({ name: 'Example' }).returning();
    expect(site?.id).toMatch(/^[0-9a-f-]{36}$/);
    await db
      .insert(siteDomains)
      .values({ domain: 'example.com', siteId: site!.id, isPrimary: true });
    await expect(
      db.insert(siteDomains).values({ domain: 'Example.org', siteId: site!.id }),
    ).rejects.toThrow();
  });
});
