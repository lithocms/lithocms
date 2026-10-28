import { z } from 'zod';

const Config = z.object({
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Runtime role. */
  DATABASE_URL: z.url(),
  /** Owner role, used only to run migrations at startup. */
  DATABASE_OWNER_URL: z.url(),
  ADMIN_DOMAIN: z.string().toLowerCase(),
});

export type Config = z.infer<typeof Config>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Config.parse(env);
}
