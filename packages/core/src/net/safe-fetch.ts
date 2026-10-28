import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export class SafeFetchError extends Error {
  override name = 'SafeFetchError';
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  /** Total time budget, including redirects and body. */
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface SafeFetchResponse {
  /** Final URL after redirects. */
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT (also Alibaba metadata)
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3], // multicast, reserved, broadcast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
// IPv6 is an allowlist: only global unicast, minus prefixes that tunnel or embed IPv4.
const globalUnicast = new BlockList();
globalUnicast.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 32, 'ipv6'); // Teredo
blocked.addSubnet('2001:db8::', 32, 'ipv6'); // documentation
blocked.addSubnet('2002::', 16, 'ipv6'); // 6to4

/** True for any address a server-side fetch must never reach. Non-IP input counts as blocked. */
export function isBlockedAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return blocked.check(address, 'ipv4');
    case 6:
      return !globalUnicast.check(address, 'ipv6') || blocked.check(address, 'ipv6');
    default:
      return true;
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Builds a fetch that refuses blocked addresses. Exported for tests only: production code
 * uses `safeFetch`, which blocks with `isBlockedAddress`.
 */
export function createSafeFetch(isBlocked: (address: string) => boolean) {
  // Validates what DNS actually returned and hands exactly those addresses to the socket,
  // so a second resolution (DNS rebinding) cannot swap in a private address.
  const lookup: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '');
      const first = addresses[0];
      if (!first || addresses.some((a) => isBlocked(a.address))) {
        return callback(new SafeFetchError(`${hostname} resolves to a blocked address`), '');
      }
      if (options.all) callback(null, addresses);
      else callback(null, first.address, first.family);
    });
  };

  return async function safeFetch(
    url: string,
    {
      headers = {},
      timeoutMs = 15_000,
      maxBytes = 25 * 1024 * 1024,
      maxRedirects = 5,
    }: SafeFetchOptions = {},
  ): Promise<SafeFetchResponse> {
    const signal = AbortSignal.timeout(timeoutMs);
    let target = new URL(url);
    let sendHeaders = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );

    for (let redirects = 0; ; redirects++) {
      assertAllowedUrl(target, isBlocked);
      const res = await get(target, sendHeaders, signal, lookup);
      const location = res.headers.location;

      if (res.statusCode !== undefined && REDIRECTS.has(res.statusCode) && location) {
        res.resume();
        if (redirects >= maxRedirects) throw new SafeFetchError('Too many redirects');
        const next = new URL(location, target);
        if (next.origin !== target.origin) {
          sendHeaders = { ...sendHeaders };
          delete sendHeaders.authorization;
          delete sendHeaders.cookie;
        }
        target = next;
        continue;
      }

      return {
        url: target.href,
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: await readCapped(res, maxBytes),
      };
    }
  };
}

export const safeFetch = createSafeFetch(isBlockedAddress);

function assertAllowedUrl(url: URL, isBlocked: (address: string) => boolean): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError(`Protocol not allowed: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new SafeFetchError('Credentials in URL are not allowed');
  }
  // IP literals never reach `lookup`, so check them here.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlocked(host)) {
    throw new SafeFetchError(`Blocked address: ${host}`);
  }
}

function get(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  lookup: LookupFunction,
): Promise<IncomingMessage> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    // No shared agent: every connection goes through our `lookup`.
    request(url, { headers, signal, lookup, agent: false }, resolve).on('error', reject).end();
  });
}

async function readCapped(res: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const tooLarge = () => {
    res.destroy();
    return new SafeFetchError(`Response larger than ${maxBytes} bytes`);
  };
  if (Number(res.headers['content-length']) > maxBytes) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw tooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
