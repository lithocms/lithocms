/** Per-token limits from MCP_SPEC.md, kept in memory (one app process). */
const LIMITS = {
  writes: { max: 60, windowMs: 60_000 },
  publishes: { max: 10, windowMs: 3_600_000 },
};

export type LimitKind = keyof typeof LIMITS;

export class RateLimiter {
  private hits = new Map<string, number[]>();

  /** Records one use; false when the limit is reached (nothing recorded then). */
  take(token: string, kind: LimitKind, now = Date.now()): boolean {
    const { max, windowMs } = LIMITS[kind];
    const key = `${kind}:${token}`;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
