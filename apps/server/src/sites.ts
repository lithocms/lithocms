import { schema, type Db } from '@lithocms/core';
import { eq } from 'drizzle-orm';

export interface ResolvedSite {
  id: string;
  name: string;
  status: 'active' | 'maintenance' | 'disabled';
}

/** Host → site lookup, held in memory and reloaded with `refresh()`. */
export interface SiteResolver {
  resolve(hostname: string): ResolvedSite | undefined;
  refresh(): Promise<void>;
}

export async function createSiteResolver(db: Db): Promise<SiteResolver> {
  let byDomain = new Map<string, ResolvedSite>();

  const refresh = async () => {
    const rows = await db
      .select({
        domain: schema.siteDomains.domain,
        id: schema.sites.id,
        name: schema.sites.name,
        status: schema.sites.status,
      })
      .from(schema.siteDomains)
      .innerJoin(schema.sites, eq(schema.siteDomains.siteId, schema.sites.id));
    byDomain = new Map(rows.map(({ domain, ...site }) => [domain, site]));
  };

  await refresh();
  // TODO(phase-1): call refresh() after site/domain writes; 301 non-primary domains to primary.
  return { resolve: (hostname) => byDomain.get(normalizeHost(hostname)), refresh };
}

/** `Example.COM.` → `example.com` (port already stripped by Fastify's `request.hostname`). */
export function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}
