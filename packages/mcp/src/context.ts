import {
  withSite,
  type Actor,
  type Db,
  type McpScope,
  type MediaStore,
  type SafeFetchResponse,
  type ThemeVersion,
  type Tx,
} from '@lithocms/core';
import type { ThemeBundle, ValidationReport } from '@lithocms/theme-engine';
import type { RateLimiter } from './limits.js';

/** Theme files live outside the database; the server stores, validates and previews them. */
export interface ThemeStore {
  files(storagePath: string): Promise<ThemeBundle | undefined>;
  validate(siteId: string, bundle: ThemeBundle): Promise<ValidationReport>;
  /** Saves a site version keyed by theme.json's slug and version; `draft` keeps it if invalid. */
  save(
    siteId: string,
    actor: Actor,
    bundle: ThemeBundle,
    draft: { slug: string; name: string; version: string },
  ): Promise<{ version: ThemeVersion; report: ValidationReport; replaced: boolean }>;
  previewUrl(tx: Tx, siteId: string, version: ThemeVersion, path?: string): Promise<string>;
}

/** Everything a request's tools may use: who is calling, for which site, with what. */
export interface McpContext {
  db: Db;
  siteId: string;
  /** Channel `mcp`, with the token id for the audit log. */
  actor: Actor & { tokenId: string };
  /** The token's scopes, already cut down to what the user's role allows. */
  scopes: McpScope[];
  adminUrl: URL;
  /** The site's public origin (`https://example.com`); null while it has no domain. */
  siteOrigin: string | null;
  store: MediaStore;
  limiter: RateLimiter;
  /** Bundled themes a site without an active theme renders with. */
  themeDefaults: string[];
  themes: ThemeStore;
  guides: { themeAuthoring: string };
  /** SSRF-safe fetch for media from a URL. */
  fetchUrl: (url: string, maxBytes: number) => Promise<SafeFetchResponse>;
}

export const read = <T>(ctx: McpContext, fn: (tx: Tx) => Promise<T>) =>
  withSite(ctx.db, ctx.siteId, fn);

export class RateLimited extends Error {
  readonly code = 'rate_limited';
  override name = 'RateLimited';
}

/** Counts a write (and a publish) against the token's limits. */
export function spend(ctx: McpContext, publish = false): void {
  const token = ctx.actor.tokenId;
  if (!ctx.limiter.take(token, 'writes')) {
    throw new RateLimited('Too many writes: at most 60 a minute. Wait a moment and retry.');
  }
  if (publish && !ctx.limiter.take(token, 'publishes')) {
    throw new RateLimited('Too many publishes: at most 10 an hour.');
  }
}

/** Thrown to roll back a dry run's transaction; carries what the write returned. */
class DryRun extends Error {
  constructor(readonly value: unknown) {
    super('dry run');
  }
}

/**
 * Runs a write in one transaction. With `dryRun` the transaction is rolled back after the
 * write ran (audit and revisions included) and the would-be result is returned.
 */
export async function write<T>(
  ctx: McpContext,
  fn: (tx: Tx) => Promise<T>,
  opts: { dryRun?: boolean; publish?: boolean } = {},
): Promise<T | { dry_run: true; result: unknown }> {
  if (!opts.dryRun) spend(ctx, opts.publish);
  try {
    return await withSite(ctx.db, ctx.siteId, async (tx) => {
      const value = await fn(tx);
      if (opts.dryRun) throw new DryRun(value);
      return value;
    });
  } catch (e) {
    if (e instanceof DryRun) return { dry_run: true, result: e.value };
    throw e;
  }
}
