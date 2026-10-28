import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';

/** Hashed client address for audit and rate limits; raw IPs are never stored. */
export function ipHash(request: FastifyRequest, secret: string): string {
  // Caddy replaces X-Forwarded-For with the real client address (same assumption as auth).
  const forwarded = request.headers['x-forwarded-for'];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return createHash('sha256')
    .update(`${secret}:${ip ?? request.ip}`)
    .digest('base64url')
    .slice(0, 22);
}
