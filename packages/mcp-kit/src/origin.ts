import { isIP } from 'node:net';

export interface ServiceOriginOptions {
  /** Permit `http:` for a loopback IP literal. For explicit local tests only; never a production fallback. */
  allowLoopbackHttp?: boolean;
}

const isLoopback = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, '');
  return (isIP(host) === 4 && host.startsWith('127.')) || host === '::1';
};

/**
 * Normalize a service origin supplied by configuration. Accepts `https://host[:port]` only (plus loopback
 * `http` when explicitly allowed). Credentials, paths, queries and fragments are rejected, so a configured
 * value cannot smuggle a different destination.
 */
export function parseServiceOrigin(raw: string, options: ServiceOriginOptions = {}): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Service URL is not a valid absolute URL.');
  }
  const secure = url.protocol === 'https:';
  if (!secure && !(options.allowLoopbackHttp === true && url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('Service URL must use https. Plain http is allowed only for an explicitly enabled loopback test address.');
  }
  if (url.username || url.password) throw new Error('Service URL must not contain credentials.');
  if (raw.includes('?') || raw.includes('#') || url.search || url.hash) throw new Error('Service URL must not contain a query or fragment.');
  if (url.pathname !== '/') throw new Error('Service URL must be an origin without a path.');
  return url.origin;
}
