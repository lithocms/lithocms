import { schema, type Db } from '@lithocms/core';
import { asc, desc, eq } from 'drizzle-orm';

export interface ResolvedSite {
  id: string;
  name: string;
  status: 'active' | 'maintenance' | 'disabled';
  /** Canonical host; other domains of the site redirect to it. */
  primaryDomain: string;
  /** Extra hosts the site's CSP allows (`settings.csp_allowlist`). */
  cspAllowlist: string[];
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
        isPrimary: schema.siteDomains.isPrimary,
        id: schema.sites.id,
        name: schema.sites.name,
        status: schema.sites.status,
        settings: schema.sites.settings,
      })
      .from(schema.siteDomains)
      .innerJoin(schema.sites, eq(schema.siteDomains.siteId, schema.sites.id))
      .orderBy(desc(schema.siteDomains.isPrimary), asc(schema.siteDomains.domain));
    const primary = new Map<string, string>();
    for (const r of rows) if (!primary.has(r.id)) primary.set(r.id, r.domain);
    byDomain = new Map(
      rows.map((r) => [
        r.domain,
        {
          id: r.id,
          name: r.name,
          status: r.status,
          primaryDomain: primary.get(r.id)!,
          cspAllowlist: hostList(r.settings.csp_allowlist),
        },
      ]),
    );
  };

  await refresh();
  // TODO(phase-1): call refresh() after site/domain/settings writes.
  return { resolve: (hostname) => byDomain.get(normalizeHost(hostname)), refresh };
}

/** `Example.COM.` → `example.com` (port already stripped by Fastify's `request.hostname`). */
export function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Only well-formed host names reach the CSP header. */
function hostList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((h): h is string => typeof h === 'string' && HOST.test(h))
    : [];
}
