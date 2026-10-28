import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createSafeFetch, isBlockedAddress, safeFetch, SafeFetchError } from './safe-fetch.js';

const servers: Server[] = [];

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => {
      s.closeAllConnections();
      return new Promise((resolve) => s.close(resolve));
    }),
  );
});

// Local test servers live on 127.0.0.1, so tests that need a reachable server allow exactly
// that address and keep every other block in place.
const testFetch = createSafeFetch((a) => a !== '127.0.0.1' && isBlockedAddress(a));

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.100.100.200',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fd00:ec2::254',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    '2002:a00:1::',
    '2001:db8::1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['1.1.1.1', '93.184.215.14', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450::1'])(
    'allows %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('safeFetch', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
  ])('refuses %s before connecting', async (url) => {
    await expect(safeFetch(url)).rejects.toBeInstanceOf(SafeFetchError);
  });

  it('refuses a loopback server by IP and by hostname', async () => {
    let hits = 0;
    const base = await serve((_req, res) => {
      hits++;
      res.end('secret');
    });
    await expect(safeFetch(base)).rejects.toBeInstanceOf(SafeFetchError);
    await expect(safeFetch(base.replace('127.0.0.1', 'localhost'))).rejects.toBeInstanceOf(
      SafeFetchError,
    );
    expect(hits).toBe(0);
  });

  it('refuses non-http protocols and credentials in the URL', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toBeInstanceOf(SafeFetchError);
    await expect(safeFetch('ftp://example.com/')).rejects.toBeInstanceOf(SafeFetchError);
    await expect(safeFetch('http://user:pass@example.com/')).rejects.toBeInstanceOf(SafeFetchError);
  });

  it('returns the body of an allowed server', async () => {
    const base = await serve((_req, res) => res.end('hello'));
    const res = await testFetch(`${base}/x`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('hello');
    expect(res.url).toBe(`${base}/x`);
  });

  it.each([
    'http://10.0.0.1/',
    'http://169.254.169.254/',
    'http://[::1]/',
    'http://127.0.0.2/',
    'gopher://example.com/',
  ])('refuses a redirect to %s', async (location) => {
    const base = await serve((_req, res) => res.writeHead(302, { location }).end());
    await expect(testFetch(base)).rejects.toBeInstanceOf(SafeFetchError);
  });

  it('follows allowed redirects and drops credentials across origins', async () => {
    let seen: IncomingHttpHeaders = {};
    const other = await serve((req, res) => {
      seen = req.headers;
      res.end('moved');
    });
    const base = await serve((_req, res) => res.writeHead(301, { location: `${other}/y` }).end());
    const res = await testFetch(base, { headers: { Authorization: 'Bearer t', 'X-Keep': '1' } });
    expect(res.body.toString()).toBe('moved');
    expect(res.url).toBe(`${other}/y`);
    expect(seen.authorization).toBeUndefined();
    expect(seen['x-keep']).toBe('1');
  });

  it('stops after maxRedirects', async () => {
    const base = await serve((req, res) => res.writeHead(302, { location: `${req.url}x` }).end());
    await expect(testFetch(base, { maxRedirects: 3 })).rejects.toThrow('Too many redirects');
  });

  it('caps the body size, declared or streamed', async () => {
    const declared = await serve((_req, res) => res.end('x'.repeat(100)));
    await expect(testFetch(declared, { maxBytes: 10 })).rejects.toThrow('larger than');

    const streamed = await serve((_req, res) => {
      res.write('x'.repeat(8));
      res.end('x'.repeat(8));
    });
    await expect(testFetch(streamed, { maxBytes: 10 })).rejects.toThrow('larger than');
  });

  it('times out', async () => {
    const base = await serve(() => {
      /* never responds */
    });
    await expect(testFetch(base, { timeoutMs: 100 })).rejects.toThrow();
  });
});
