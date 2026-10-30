import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

// The admin SPA (apps/admin build output), served from memory on the admin origin only.

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  json: 'application/json',
};

// Media previews come from the sites' own origins, so images may load from anywhere; nothing
// else may.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export interface AdminApp {
  serve(request: FastifyRequest, reply: FastifyReply): FastifyReply;
}

/** Loads the built SPA from `dir`; undefined when it has not been built. */
export async function loadAdminApp(dir: string): Promise<AdminApp | undefined> {
  const files = new Map<string, Buffer>();
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const entry of entries.filter((e) => e.isFile())) {
    const full = join(entry.parentPath, entry.name);
    files.set('/' + relative(dir, full).split(sep).join('/'), await readFile(full));
  }
  const index = files.get('/index.html');
  if (!index) return undefined;
  return {
    serve(request, reply) {
      const path = request.url.split('?', 1)[0]!;
      const file = files.get(path);
      const type = TYPES[path.split('.').pop() ?? ''];
      reply
        .header('content-security-policy', CSP)
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'same-origin');
      // Vite fingerprints everything under /assets/; any other path is a client-side route.
      if (file && type && path !== '/index.html') {
        return reply
          .type(type)
          .header(
            'cache-control',
            path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
          )
          .send(file);
      }
      if (path.startsWith('/assets/')) return reply.code(404).send({ error: 'not_found' });
      return reply.type(TYPES.html!).header('cache-control', 'no-cache').send(index);
    },
  };
}
