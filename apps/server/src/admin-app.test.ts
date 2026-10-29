import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAdminApp } from './admin-app.js';

let dir: string;
let app: FastifyInstance;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'litho-admin-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  await writeFile(join(dir, 'assets', 'app-abc.js'), 'console.log(1)');
  const admin = await loadAdminApp(dir);
  app = Fastify();
  app.addHook('onRequest', async (request, reply) => admin!.serve(request, reply));
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('admin SPA', () => {
  it('is undefined until built', async () => {
    expect(await loadAdminApp(join(dir, 'missing'))).toBeUndefined();
  });

  it('serves fingerprinted assets, and index.html for client routes', async () => {
    const js = await app.inject('/assets/app-abc.js');
    expect(js.headers['content-type']).toMatch(/^text\/javascript/);
    expect(js.headers['cache-control']).toContain('immutable');
    for (const url of ['/', '/sites/x/posts?draft=1', '/../etc/passwd']) {
      const page = await app.inject(url);
      expect(page.statusCode, url).toBe(200);
      expect(page.body, url).toContain('id="root"');
      expect(page.headers['content-security-policy'], url).toContain("script-src 'self'");
      expect(page.headers['cache-control'], url).toBe('no-cache');
    }
    expect((await app.inject('/assets/missing.js')).statusCode).toBe(404);
  });
});
