import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

/** The URL rules every outgoing request obeys: public HTTP(S), no credentials, no explicit port. */
export function checkedUrl(input) {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only public HTTP(S) URLs are supported.');
  if (url.username || url.password) throw new Error('URL credentials are blocked.');
  if (url.port) throw new Error('Nonstandard ports are blocked.');
  url.hash = '';
  return url;
}

/** @param {string} address */
export function assertPublicAddress(address) {
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
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Addresses of the URL host; every one must be public, whichever a connection would use.
 * @param {URL} url
 * @param {{ resolve?: typeof lookup, signal?: AbortSignal }} [options]
 * @returns {Promise<{ address: string, family: number }[]>}
 */
export async function publicAddresses(url, { resolve = lookup, signal } = {}) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const addresses = family
    ? [{ address: host, family }]
    : await abortable(resolve(host, { all: true, verbatim: true }), signal);
  if (!addresses.length) throw new Error('No public address found.');
  addresses.forEach(({ address }) => assertPublicAddress(address));
  return addresses;
}
