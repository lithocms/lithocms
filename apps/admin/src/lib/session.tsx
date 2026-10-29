import { createContext, useContext, type ReactNode } from 'react';
import { useParams } from 'react-router';
import type { Me, Role } from './types';

const Session = createContext<{ me: Me; reload: () => void } | null>(null);

export function SessionProvider({
  me,
  reload,
  children,
}: {
  me: Me;
  reload: () => void;
  children: ReactNode;
}) {
  return <Session.Provider value={{ me, reload }}>{children}</Session.Provider>;
}

export function useSession() {
  const ctx = useContext(Session);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}

const RANK: Record<Role, number> = { author: 0, editor: 1, admin: 2, owner: 3 };

/** The site in the URL, its API prefix and what the user's role allows there. */
export function useSite() {
  const { me } = useSession();
  const { siteId } = useParams();
  const site = me.sites.find((s) => s.id === siteId);
  if (!site) throw new Error('useSite outside a site route');
  return {
    ...site,
    /** Admin API path for this site. */
    path: (p: string) => `/sites/${site.id}${p}`,
    /** Admin route for this site. */
    to: (p = '') => `/sites/${site.id}${p}`,
    /** Public URL of a media file. */
    media: (path: string) => `${site.url ?? ''}/media/${path}`,
    atLeast: (role: Role) => RANK[site.role] >= RANK[role],
  };
}
