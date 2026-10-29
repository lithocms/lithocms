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
  /** Rendered pages; a volume in production. Empty turns the page cache off. */
  CACHE_DIR: z.string().default('/data/cache'),
  /** The built admin SPA (apps/admin/dist). */
  ADMIN_DIR: z.string().default('/app/admin'),
  /** Bundled themes, one folder per theme. */
  THEMES_DIR: z.string().default('/app/themes'),
  /** Bundled theme(s) for sites without an active theme, in order of preference. */
  DEFAULT_THEME: z
    .string()
    .default('corporate')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /** Outgoing mail (form notifications), e.g. `smtps://user:pass@smtp.example.com:465`. */
  SMTP_URL: z.url().optional(),
  /** Sender address; defaults to `LithoCMS <noreply@admin host>`. */
  MAIL_FROM: z.string().min(3).optional(),
});

export type Config = z.infer<typeof Config>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Config.parse(env);
}
