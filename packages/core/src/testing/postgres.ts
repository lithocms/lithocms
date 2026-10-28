import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { fileURLToPath } from 'node:url';

export interface TestDatabase {
  superuserUrl: string;
  /** Owner role: migrations and test fixtures. */
  ownerUrl: string;
  /** Runtime role: what the app uses. */
  appUrl: string;
  stop: () => Promise<void>;
}

/** Real Postgres with the same role setup as production (`deploy/postgres/init-roles.sh`). */
export async function startTestDatabase(): Promise<TestDatabase> {
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
    .start();
  const url = (user: string, password: string) =>
    `postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
  return {
    superuserUrl: container.getConnectionUri(),
    ownerUrl: url('lithocms_owner', 'owner'),
    appUrl: url('lithocms_app', 'app'),
    stop: async () => {
      await container.stop();
    },
  };
}
