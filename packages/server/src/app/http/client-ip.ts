/**
 * The address a request came from, given how many proxies in front of this server are trusted.
 *
 * Each proxy appends the address it received the request from to x-forwarded-for, so the list read right to
 * left is: the socket peer, then what each trusted proxy saw. With N trusted proxies the client is N hops back.
 * Anything further left was written by the client and is ignored, so it cannot be used to pick an address.
 * With 0 trusted proxies the header is ignored entirely.
 */
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

const unmap = (a: string) => (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4 ? a.slice(7) : a);

export function clientIp(req: IncomingMessage, trustedProxies: number): string {
  const peer = unmap(req.socket.remoteAddress ?? '');
  if (trustedProxies <= 0) return peer;
  const raw = req.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(raw) ? raw.join(',') : raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // hops[0] is the peer, hops[i] is what the i-th trusted proxy saw
  const hops = [peer, ...forwarded.reverse()];
  const picked = unmap(hops[Math.min(trustedProxies, hops.length - 1)] ?? '');
  // a proxy we trust writes a bare address; anything else means the chain is not what was configured
  return isIP(picked) ? picked : peer;
}

/** The part of an address that one party controls: the whole IPv4 address, or an IPv6 /64. */
export function addressKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
