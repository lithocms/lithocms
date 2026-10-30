import type { MediaStore } from '@lithocms/core';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};
// Exactly what uploadMedia writes: YYYY/MM/<uuid>[-<width>].<ext>
const FILE = /^\d{4}\/\d{2}\/[0-9a-f-]{36}(?:-\d{2,4})?\.(jpg|png|webp|gif|avif)$/;

/** Serves a site's uploaded files on its own origins. Files are immutable (new upload = new name). */
export function registerMediaFiles(app: FastifyInstance, store: MediaStore) {
  app.get('/media/*', async (request, reply) => {
    const path = (request.params as { '*': string })['*'];
    const ext = FILE.exec(path)?.[1];
    const file = request.site && ext ? await store.open(`${request.site.id}/${path}`) : null;
    if (!file || !ext) return reply.code(404).send({ error: 'not_found' });
    return reply
      .type(TYPES[ext]!)
      .header('content-length', file.size)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .send(file.stream);
  });
}
