import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The URL rules every request obeys: public HTTP(S), no credentials, no explicit port. */
export function checkedUrl(input) {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only public HTTP(S) URLs are supported.');
  if (url.username || url.password) throw new Error('URL credentials are blocked.');
  if (url.port) throw new Error('Nonstandard ports are blocked.');
  url.hash = '';
  return url;
}

function assertPublic(address) {
  // process() normalizes IPv4-mapped IPv6 before classifying it. Non-unicast
  // ranges include private, loopback, link-local, multicast and transition ranges.
  if (!ipaddr.isValid(address)) throw new Error('Non-public network address blocked.');
  const parsed = ipaddr.process(address);
  const globalV6 = parsed.kind() !== 'ipv6' || parsed.match(ipaddr.parse('2000::'), 3);
  if (parsed.range() !== 'unicast' || !globalV6) {
    throw new Error('Non-public network address blocked.');
  }
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

const BINARY_TYPES = /^(?:image\/|application\/(?:pdf|x-pdf|octet-stream)$|binary\/octet-stream$)/;

/** Text of a textual body in its declared charset; binary types (images, PDF, octet-stream) have none. */
function decodedBody(bytes, headers) {
  const contentType = String(headers['content-type'] ?? '');
  if (BINARY_TYPES.test(contentType.split(';')[0].trim().toLowerCase())) return '';
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    throw new Error('Unsupported page character encoding.');
  }
}

function collectBody(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    response.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        response.destroy(new Error('Response exceeds the download size limit.'));
      } else chunks.push(chunk);
    });
    response.on('error', reject);
    response.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// Internal transport boundary: callers must use publicGet, which validates and
// pins DNS. Exported for integration tests against a local HTTP fixture only.
/**
 * @param {URL} url
 * @param {{ address: { address: string, family: number }, headers?: Record<string, string>, signal?: AbortSignal,
 *   maxBytes: number | ((headers: import('node:http').IncomingHttpHeaders) => number) }} options
 *   `maxBytes` may depend on the response headers, for example a larger limit for PDFs.
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string, bytes?: Buffer }>}
 *   `bytes` is the raw body of a successful response; `body` is its decoded text, empty for binary types.
 */
export function requestPinned(url, { address, headers = {}, signal, maxBytes }) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(
      url,
      {
        agent: false,
        signal,
        headers: { 'User-Agent': 'personal-pi-extensions/0.1', 'Accept-Encoding': 'identity', ...headers },
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      },
      response => {
        const status = response.statusCode;
        const responseHeaders = response.headers;
        if (REDIRECTS.has(status) || status < 200 || status >= 300) {
          response.destroy();
          resolve({ status, headers: responseHeaders, body: '' });
          return;
        }
        const encoding = response.headers['content-encoding'];
        if (encoding && encoding !== 'identity') {
          response.destroy();
          reject(new Error('Unsupported compressed Content-Encoding; expected identity.'));
          return;
        }
        const limit = typeof maxBytes === 'function' ? maxBytes(responseHeaders) : maxBytes;
        if (Number(response.headers['content-length']) > limit) {
          response.destroy();
          reject(new Error('Response exceeds the download size limit.'));
          return;
        }
        collectBody(response, limit)
          .then(bytes =>
            resolve({ status, headers: responseHeaders, body: decodedBody(bytes, responseHeaders), bytes }),
          )
          .catch(reject);
      },
    );
    request.on('error', reject);
  });
}

/** Addresses of the URL host; every one must be public, whichever the connection uses. */
async function publicAddresses(url, resolve, signal) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const addresses = family
    ? [{ address: host, family }]
    : await abortable(resolve(host, { all: true, verbatim: true }), signal);
  if (!addresses.length) throw new Error('No public address found.');
  addresses.forEach(({ address }) => assertPublic(address));
  return addresses;
}

function redirectTarget(url, response) {
  if (!response.headers.location) throw new Error('Redirect has no destination.');
  const next = checkedUrl(new URL(response.headers.location, url));
  if (url.protocol === 'https:' && next.protocol === 'http:') throw new Error('HTTPS downgrade redirect blocked.');
  return next;
}

export async function publicGet(input, options = {}, dependencies = {}) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 20_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const resolve = dependencies.lookup ?? lookup;
  const send = dependencies.send ?? requestPinned;
  let url = checkedUrl(input);
  const maxRedirects = options.maxRedirects ?? 4;
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const addresses = await publicAddresses(url, resolve, signal);
    signal.throwIfAborted();
    const response = await send(url, {
      address: addresses[0],
      headers: options.headers,
      signal,
      maxBytes: options.maxBytes ?? 4 * 1024 * 1024,
    });
    if (!REDIRECTS.has(response.status)) return { ...response, url: url.href, redirects };
    if (redirects >= maxRedirects) throw new Error('Redirect limit reached.');
    url = redirectTarget(url, response);
  }
}
