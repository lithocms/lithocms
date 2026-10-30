import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import './postgres.js';

/**
 * One Postgres for the whole run, with the same role setup as production
 * (`deploy/postgres/init-roles.sh`); each test file gets its own database (see `postgres.ts`).
 * `TEST_POSTGRES_URL` (superuser URL of a database prepared by init-roles.sh) uses an existing
 * server instead, e.g. the `test-postgres` service when tests run in compose.
 */
// eslint-disable-next-line no-restricted-syntax -- vitest requires a default export
export default async function setup(project: TestProject) {
  const external = process.env.TEST_POSTGRES_URL;
  if (external) {
    const url = new URL(external);
    project.provide('postgresTemplate', url.pathname.slice(1));
    url.pathname = '/postgres';
    project.provide('postgresAdminUrl', url.toString());
    return;
  }
  const container = await new PostgreSqlContainer('postgres:18-alpine')
    .withEnvironment({ LITHO_DB_OWNER_PASSWORD: 'owner', LITHO_DB_APP_PASSWORD: 'app' })
    .withCopyFilesToContainer([
      {
        source: fileURLToPath(
          new URL('../../../../deploy/postgres/init-roles.sh', import.meta.url),
        ),
        target: '/docker-entrypoint-initdb.d/10-init-roles.sh',
        mode: 0o755,
      },
    ])
    // Every test file opens its own pools.
    .withCommand(['-c', 'max_connections=1000'])
    .start();
  const url = new URL(container.getConnectionUri());
  url.pathname = '/postgres';
  project.provide('postgresAdminUrl', url.toString());
  project.provide('postgresTemplate', container.getDatabase());
  return async () => {
    await container.stop();
  };
}
