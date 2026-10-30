import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser URL of the shared test Postgres, pointing at its `postgres` database. */
    postgresAdminUrl: string;
    /** Database prepared by init-roles.sh; copied for every test database. */
    postgresTemplate: string;
  }
}

export interface TestDatabase {
  /** Owner role: migrations and test fixtures. */
  ownerUrl: string;
  /** Runtime role: what the app uses. */
  appUrl: string;
  stop: () => Promise<void>;
}

/**
 * A fresh database in the shared test Postgres (`global-setup.ts`), copied from the one
 * init-roles.sh prepared, so schema ownership and default privileges match production.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const adminUrl = inject('postgresAdminUrl');
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Database-level settings are not copied from the template.
    await admin.query(
      `CREATE DATABASE ${name} TEMPLATE ${inject('postgresTemplate')} OWNER lithocms_owner`,
    );
    await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO lithocms_app`);
  } finally {
    await admin.end();
  }
  const url = (user: string, password: string) => {
    const u = new URL(adminUrl);
    u.username = user;
    u.password = password;
    u.pathname = `/${name}`;
    return u.toString();
  };
  return {
    ownerUrl: url('lithocms_owner', 'owner'),
    appUrl: url('lithocms_app', 'app'),
    stop: async () => {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      await client.query(`DROP DATABASE ${name} WITH (FORCE)`).finally(() => client.end());
    },
  };
}
