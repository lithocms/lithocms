import { z } from 'zod';

const Config = z.object({
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Runtime role. */
  DATABASE_URL: z.url(),
  /** Owner role, used only to run migrations at startup. */
  DATABASE_OWNER_URL: z.url(),
  /** Admin origin, e.g. `https://admin.example.com`. */
  ADMIN_URL: z.url().transform((url) => new URL(url)),
  /** Signs sessions and encrypts auth secrets (2FA). Generate with `openssl rand -base64 32`. */
  AUTH_SECRET: z.string().min(32),
  /** Uploaded media; a volume in production. */
  MEDIA_DIR: z.string().default('/data/media'),
});

export type Config = z.infer<typeof Config>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Config.parse(env);
}
