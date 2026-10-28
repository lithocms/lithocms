import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Runtime connection. `url` must use the runtime role, never the owner or superuser. */
export function createDb(url: string, max = 10): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString: url, max });
  return { db: drizzle(pool, { schema, casing: 'snake_case' }), pool };
}

/** Applies pending migrations. `ownerUrl` must use the owner role. */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
    });
  } finally {
    await pool.end();
  }
}

/**
 * Runs `fn` in a transaction scoped to one site: row-level security on tenant tables then
 * only sees and accepts rows with this `site_id`. Every query on tenant data goes through here.
 */
export function withSite<T>(db: Db, siteId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.site_id', ${siteId}, true)`);
    return fn(tx);
  });
}

export { TENANT_POLICY_CONDITION } from './schema.js';
