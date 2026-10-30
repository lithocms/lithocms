// The admin SPA renders the pages of the OAuth flow (MCP clients such as Claude.ai). better-auth
// sends the browser to them with a signed copy of the authorization request in the query.

/** The signed authorization request on a flow page, or undefined outside the flow. */
export function oauthQuery(): string | undefined {
  return new URLSearchParams(location.search).has('sig') ? location.search.slice(1) : undefined;
}

const SIGNING = ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param'];

/**
 * The authorization request itself, to resume it with the session. The client's cross-site
 * redirect arrives without the SameSite=Strict session cookie; this same-site one carries it.
 */
export function authorizeUrl(query: string): string {
  const params = new URLSearchParams(query);
  for (const key of SIGNING) params.delete(key);
  return `/api/auth/oauth2/authorize?${params.toString()}`;
}

/** A flow step's answer: where to go next. */
export interface FlowStep {
  redirect?: boolean;
  url?: string;
}

/** Goes where a flow step says; false when it said nothing. */
export function follow(step: FlowStep | undefined): boolean {
  if (!step?.redirect || !step.url) return false;
  location.assign(step.url);
  return true;
}
