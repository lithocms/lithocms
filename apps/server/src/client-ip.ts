import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';

/** The client's address as seen by our proxy. */
export function clientIp(request: FastifyRequest): string {
  // One proxy (Caddy or the documented nginx setup) sits in front and appends the address it
  // saw, so the last entry is the only one a client cannot choose.
  const forwarded = request.headers['x-forwarded-for'];
  const ip = (Array.isArray(forwarded) ? forwarded.at(-1) : forwarded)?.split(',').at(-1)?.trim();
  return ip || request.ip;
}

/** Hashed client address for audit and rate limits; raw IPs are never stored. */
export function ipHash(request: FastifyRequest, secret: string): string {
  return createHash('sha256')
    .update(`${secret}:${clientIp(request)}`)
    .digest('base64url')
    .slice(0, 22);
}
