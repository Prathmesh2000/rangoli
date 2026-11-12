/**
 * Same-origin proxy for the online icon library and Google Fonts, so the editor never talks to a third party.
 *
 * Callers supply names only: a collection, an icon, a font family from the catalogue. Every upstream URL is
 * built here, for hosts in PINNED. Font files are addressed by tokens this file issued when it rewrote
 * Google's CSS, so a client can never choose what is fetched. Whoever mounts it authenticates first.
 */
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import type { IncomingMessage, RequestOptions, ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { findFont, fontPreviewUrl, googleFontUrl } from '@rangoli/engine';

export const ASSET_PROXY_PREFIX = '/api/asset-proxy';

const ICONIFY = 'api.iconify.design';
const FONT_CSS = 'fonts.googleapis.com';
const FONT_FILES = 'fonts.gstatic.com';
const PINNED = new Set([ICONIFY, FONT_CSS, FONT_FILES]);

/** Google picks the font format from the browser: this one is answered with woff2, for every user alike. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const KiB = 1024;
const MiB = 1024 * KiB;
const HOUR = 3600_000;

type Kind = 'json' | 'svg' | 'css' | 'font';
const POLICY: Record<Kind, { cap: number; types: RegExp; accept: string; ttl: number; browser: string }> = {
  json: { cap: 4 * MiB, types: /^application\/json$/, accept: 'application/json', ttl: HOUR, browser: 'private, max-age=300' },
  svg: { cap: 256 * KiB, types: /^image\/svg\+xml$/, accept: 'image/svg+xml', ttl: 24 * HOUR, browser: 'private, max-age=86400' },
  // tokens in the CSS live only as long as this process, so a browser must not keep a copy across a restart
  css: { cap: MiB, types: /^text\/css$/, accept: 'text/css', ttl: HOUR, browser: 'no-store' },
  font: { cap: 8 * MiB, types: /^(font\/(woff2|woff|ttf|otf|sfnt)|application\/(font-woff2?|font-sfnt|x-font-(ttf|otf|woff)|octet-stream))$/, accept: 'font/woff2,font/*', ttl: 7 * 24 * HOUR, browser: 'private, max-age=604800' },
};

class ProxyError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: number) {
    super(message);
  }
}
const bad = (message: string) => new ProxyError(400, message);
const unavailable = () => new ProxyError(502, 'The online library could not be reached. Try again.');

// ---------------------------------------------------------------- addresses

const BLOCKED_V4 = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) BLOCKED_V4.addSubnet(net, bits, 'ipv4');

function ipv6Head(ip: string): [number, number] {
  const bare = ip.split('%')[0]!;
  const [left = '', right] = bare.split('::');
  const head = left ? left.split(':') : [];
  const groups = right === undefined ? head : [...head, ...Array<string>(8).fill('0')].slice(0, Math.max(2, head.length));
  return [parseInt(groups[0] ?? '0', 16) || 0, parseInt(groups[1] ?? '0', 16) || 0];
}

/**
 * True only for ordinary public unicast. IPv6 is an allowlist of global unicast, so loopback, link-local,
 * unique-local, IPv4-mapped, NAT64 and the tunnelling ranges that can wrap a private IPv4 are all refused.
 */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip.split('%')[0]!);
  if (family === 4) return !BLOCKED_V4.check(ip, 'ipv4');
  if (family !== 6) return false;
  const [a, b] = ipv6Head(ip);
  if ((a & 0xe000) !== 0x2000) return false;
  if (a === 0x2002) return false; // 6to4
  if (a === 0x2001 && (b < 0x200 || b === 0xdb8)) return false; // Teredo, IETF special use, documentation
  return true;
}

type Resolved = { address: string; family: number };
export type Resolver = (host: string) => Promise<Resolved[]>;
const systemResolver: Resolver = (host) => new Promise((ok, fail) => dnsLookup(host, { all: true }, (e, list) => (e ? fail(e) : ok(list))));

/**
 * The address checked is the address connected to, because this is the socket's own lookup:
 * a name cannot pass the check and then rebind to something internal.
 */
export function pinnedLookup(resolve: Resolver) {
  return (hostname: string, options: unknown, callback: (e: Error | null, address?: unknown, family?: number) => void): void => {
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    const refuse = () => callback(Object.assign(new Error('Refused address'), { code: 'EADDRREFUSED' }));
    if (!PINNED.has(hostname)) return refuse();
    resolve(hostname).then((list) => {
      if (!list.length || !list.every((a) => isPublicAddress(a.address))) return refuse();
      if (all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    }, () => refuse());
  };
}

// ---------------------------------------------------------------- SVG

const SVG_ELEMENTS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'defs', 'symbol', 'use', 'clipPath', 'mask', 'pattern', 'linearGradient', 'radialGradient', 'stop', 'animate', 'animateTransform', 'animateMotion', 'mpath', 'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset']);
const SVG_ATTRS = new Set(`xmlns xmlns:xlink viewBox width height x y x1 y1 x2 y2 cx cy r rx ry fx fy d points id href xlink:href style fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity opacity transform transform-origin transform-box clip-path clip-rule mask filter color display visibility vector-effect paint-order offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod patternUnits patternContentUnits patternTransform maskUnits maskContentUnits clipPathUnits filterUnits primitiveUnits preserveAspectRatio mask-type attributeName attributeType type values from to by dur begin end repeatCount repeatDur restart keyTimes keySplines keyPoints calcMode additive accumulate rotate path in in2 result stdDeviation dx dy flood-color flood-opacity mode operator k1 k2 k3 k4 tableValues slope intercept exponent amplitude radius color-interpolation color-interpolation-filters`.split(' '));
const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
const ATTR = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function safeSvgValue(name: string, value: string): boolean {
  if (/[&<>\\]|javascript:|data:|expression\(|@import/i.test(value)) return false;
  if (name === 'href' || name === 'xlink:href') return /^#[\w.:-]+$/.test(value);
  if (name === 'attributeName') return SVG_ATTRS.has(value) && !/^(href|xlink:href|id|style)$/.test(value);
  const urls = value.match(/url\([^)]*\)?/gi) ?? [];
  return urls.every((u) => /^url\(\s*['"]?#[\w.:-]+['"]?\s*\)$/i.test(u));
}

/**
 * Rebuilds the SVG from an allowlist instead of filtering what arrived: only known elements and attributes
 * are written back. Anything else, including all text, goes. Input that does not parse is refused.
 */
export function sanitizeSvg(source: string): string {
  const out: string[] = [];
  const open: { name: string; kept: boolean }[] = [];
  let pos = 0;
  let roots = 0;
  const skipTo = (marker: string, from: number) => {
    const end = source.indexOf(marker, from);
    if (end < 0) throw new Error('unterminated markup');
    return end + marker.length;
  };
  while (pos < source.length) {
    const lt = source.indexOf('<', pos);
    if (lt < 0) break;
    if (source.startsWith('<!--', lt)) { pos = skipTo('-->', lt + 4); continue; }
    if (source.startsWith('<?', lt)) { pos = skipTo('?>', lt + 2); continue; }
    if (source.startsWith('<!', lt)) throw new Error('doctype or CDATA in icon');
    TAG.lastIndex = lt;
    const m = TAG.exec(source);
    if (!m) throw new Error('malformed tag');
    pos = TAG.lastIndex;
    const [, closing, name = '', attrs = '', selfClosing] = m;
    if (closing) {
      const top = open.pop();
      if (!top || top.name !== name || selfClosing || attrs) throw new Error('unbalanced tags');
      if (top.kept) out.push(`</${name}>`);
      continue;
    }
    if (!open.length && (roots++ > 0 || name !== 'svg')) throw new Error('not a single svg');
    if (/^(script|style)$/i.test(name) && !selfClosing) {
      // raw content: its "<" characters are not markup
      const close = new RegExp(`</${name}\\s*>`, 'gi');
      close.lastIndex = pos;
      if (!close.exec(source)) throw new Error('unterminated script');
      pos = close.lastIndex;
      continue;
    }
    const kept = SVG_ELEMENTS.has(name) && (!open.length || open.at(-1)!.kept);
    if (kept) {
      const safe: string[] = [];
      for (const a of attrs.matchAll(ATTR)) {
        const key = a[1]!;
        const value = a[2] ?? a[3] ?? '';
        if (SVG_ATTRS.has(key) && safeSvgValue(key, value)) safe.push(` ${key}="${value.replace(/"/g, "'")}"`);
      }
      out.push(`<${name}${safe.join('')}${selfClosing ? '/' : ''}>`);
    }
    if (!selfClosing) open.push({ name, kept });
  }
  if (open.length || roots !== 1) throw new Error('unbalanced tags');
  return out.join('');
}

// ---------------------------------------------------------------- Google CSS

const FACE = /@font-face\s*\{([^{}]*)\}/g;
const SRC = /^url\((https:\/\/fonts\.gstatic\.com\/[\w.~/?=&%-]+)\)(?:\s+format\('?([a-z0-9-]+)'?\))?$/;
const DESCRIPTORS: Record<string, RegExp> = {
  'font-family': /^'[\w ]+'$/,
  'font-style': /^(normal|italic|oblique( -?\d+deg){0,2})$/,
  'font-weight': /^\d{1,4}( \d{1,4})?$/,
  'font-stretch': /^(\d{1,3}(\.\d+)?%( \d{1,3}(\.\d+)?%)?|[a-z-]+)$/,
  'font-display': /^(auto|block|swap|fallback|optional)$/,
  'unicode-range': /^U\+[0-9A-Fa-f?-]+(, ?U\+[0-9A-Fa-f?-]+)*$/,
};

/** Keeps @font-face rules and known descriptors only; each font file becomes a token served by this proxy. */
export function rewriteFontCss(css: string, mint: (url: string) => string): string {
  const out: string[] = [];
  for (const [, body = ''] of css.matchAll(FACE)) {
    const parts: string[] = [];
    let file: string | undefined;
    for (const raw of body.split(';')) {
      const at = raw.indexOf(':');
      if (at < 0) continue;
      const key = raw.slice(0, at).trim().toLowerCase();
      const value = raw.slice(at + 1).trim();
      if (key === 'src') {
        const m = SRC.exec(value);
        if (m) file = `src:url(${ASSET_PROXY_PREFIX}/fonts/file/${mint(m[1]!)})${m[2] ? ` format('${m[2]}')` : ''}`;
      } else if (DESCRIPTORS[key]?.test(value)) parts.push(`${key}:${value}`);
    }
    if (file && parts.some((p) => p.startsWith('font-family:'))) out.push(`@font-face{${parts.join(';')};${file}}`);
  }
  if (!out.length) throw new Error('no usable font faces');
  return out.join('\n');
}

// ---------------------------------------------------------------- bounded state

interface Entry { body: Buffer; type: string; expires: number; tokens?: [string, string][] }

class ByteCache {
  private readonly items = new Map<string, Entry>();
  private bytes = 0;
  constructor(private readonly maxBytes: number, private readonly maxEntries: number) {}
  get(key: string, now: number): Entry | undefined {
    const e = this.items.get(key);
    if (!e) return undefined;
    this.drop(key, e);
    if (e.expires <= now) return undefined;
    this.put(key, e);
    return e;
  }
  set(key: string, e: Entry): void {
    if (e.body.length > this.maxBytes) return;
    const old = this.items.get(key);
    if (old) this.drop(key, old);
    this.put(key, e);
    for (const [k, v] of this.items) {
      if (this.bytes <= this.maxBytes && this.items.size <= this.maxEntries) break;
      this.drop(k, v);
    }
  }
  private put(key: string, e: Entry) { this.items.set(key, e); this.bytes += e.body.length; }
  private drop(key: string, e: Entry) { this.items.delete(key); this.bytes -= e.body.length; }
}

class Buckets {
  private readonly items = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly burst: number, private readonly perSecond: number) {}
  /** Seconds to wait, or 0 when the request may go ahead. */
  take(key: string, now: number): number {
    const b = this.items.get(key) ?? { tokens: this.burst, at: now };
    this.items.delete(key);
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSecond);
    b.at = now;
    this.items.set(key, b);
    if (this.items.size > 20_000) this.items.delete(this.items.keys().next().value!);
    if (b.tokens < 1) return Math.max(1, Math.ceil((1 - b.tokens) / this.perSecond));
    b.tokens -= 1;
    return 0;
  }
}

// ---------------------------------------------------------------- requests

const ICON_PART = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ]{0,79}$/;
const QUERY = /^[\p{L}\p{N}][\p{L}\p{N} _'-]{0,99}$/u;
const TOKEN = /^[a-f0-9]{32}$/;

interface Target { key: string; kind: Kind; host: string; path: string; finish?: (body: Buffer) => Buffer }

/** Names only: unknown parameters and anything shaped like a URL are refused before a route is considered. */
function params(url: URL, allowed: string[]): URLSearchParams {
  if (url.search.length > 2048) throw bad('That request is too long.');
  for (const [k, v] of url.searchParams) {
    if (!allowed.includes(k)) throw bad(`Unknown parameter: ${k.slice(0, 40)}`);
    if (/:\/\/|^\/\/|\\/.test(v)) throw bad('URLs are not accepted.');
  }
  return url.searchParams;
}
function single(q: URLSearchParams, name: string): string | undefined {
  const all = q.getAll(name);
  if (all.length > 1) throw bad(`Send ${name} once.`);
  return all[0];
}
function iconPart(value: string | undefined, what: string): string {
  if (!value || !ICON_PART.test(value)) throw bad(`That is not a valid ${what} name.`);
  return value;
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const names = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string' && ICON_PART.test(n)) : []);

/** Upstream JSON is reduced to the fields the editor reads, so nothing else can pass through. */
const SHAPE = {
  collections(j: Record<string, { name?: unknown; total?: unknown; license?: { title?: unknown }; palette?: unknown }>) {
    const out: Record<string, unknown> = {};
    for (const [id, c] of Object.entries(j)) {
      if (ICON_PART.test(id) && c && Number.isFinite(c.total)) out[id] = { name: text(c.name, 120) || id, total: c.total, palette: c.palette === true, ...(typeof c.license?.title === 'string' ? { license: { title: text(c.license.title, 120) } } : {}) };
    }
    return out;
  },
  collection(j: { uncategorized?: unknown; categories?: Record<string, unknown> }) {
    const categories: Record<string, string[]> = {};
    for (const [name, list] of Object.entries(j.categories ?? {})) categories[text(name, 120)] = names(list);
    return { uncategorized: names(j.uncategorized), categories };
  },
  search(j: { icons?: unknown }) {
    const icons = Array.isArray(j.icons) ? j.icons.filter((n): n is string => typeof n === 'string' && n.split(':').length === 2 && n.split(':').every((p) => ICON_PART.test(p))) : [];
    return { icons };
  },
};
const shaped = (fn: (j: never) => unknown) => (body: Buffer) => Buffer.from(JSON.stringify(fn(JSON.parse(body.toString('utf8')) as never)));

function fontTarget(q: URLSearchParams, finish: Target['finish']): Target {
  const asked = q.getAll('family');
  const preview = single(q, 'preview');
  if (preview !== undefined && preview !== '1') throw bad('preview must be 1.');
  if (!asked.length || asked.length > 24 || (preview && asked.length !== 1)) throw bad('Name between 1 and 24 font families.');
  const families = [...new Set(asked.map((name) => {
    const font = FAMILY.test(name) ? findFont(name) : undefined;
    if (font?.source !== 'google') throw bad('That is not a font family in the catalogue.');
    return font.family;
  }))].sort();
  const built = new URL(preview ? fontPreviewUrl(families[0]!) : googleFontUrl(families)!);
  return { key: `css|${preview ? 'preview' : 'full'}|${families.join(',')}`, kind: 'css', host: built.hostname, path: built.pathname + built.search, finish };
}

function fontMime(body: Buffer): string {
  const magic = body.subarray(0, 4).toString('latin1');
  if (magic === 'wOF2') return 'font/woff2';
  if (magic === 'wOFF') return 'font/woff';
  if (magic === 'OTTO') return 'font/otf';
  if (body.length >= 4 && body.readUInt32BE(0) === 0x00010000) return 'font/ttf';
  throw new Error('not a font file');
}

export interface AssetProxyOptions {
  /** the https client; tests replace it to reach a local stand-in */
  request?: typeof httpsRequest;
  resolve?: Resolver;
  timeoutMs?: number;
  /** overrides each kind's size cap */
  maxBytes?: Partial<Record<Kind, number>>;
  cacheBytes?: number;
  cacheEntries?: number;
  rate?: { burst: number; perSecond: number };
  now?: () => number;
}

export interface AssetProxy {
  /** Answers a GET under ASSET_PROXY_PREFIX. `userKey` is who the rate limit applies to; the caller has authenticated them. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL, userKey: string): Promise<void>;
}

export function createAssetProxy(options: AssetProxyOptions = {}): AssetProxy {
  const request = options.request ?? httpsRequest;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const lookup = pinnedLookup(options.resolve ?? systemResolver);
  const cache = new ByteCache(options.cacheBytes ?? 128 * MiB, options.cacheEntries ?? 20_000);
  // a page opens at most a few hundred icons at once; the cap is for loops, not for browsing
  const buckets = new Buckets(options.rate?.burst ?? 1200, options.rate?.perSecond ?? 30);
  const fontFiles = new Map<string, string>();
  const inFlight = new Map<string, Promise<Entry>>();
  const coolUntil = new Map<string, number>();
  const waiting: (() => void)[] = [];
  let active = 0;

  const rememberToken = (token: string, path: string) => {
    fontFiles.delete(token);
    fontFiles.set(token, path);
    if (fontFiles.size > 50_000) fontFiles.delete(fontFiles.keys().next().value!);
  };

  const slot = async () => {
    if (active < 24) { active++; return; }
    if (waiting.length >= 512) throw new ProxyError(503, 'The online library is busy. Try again.');
    await new Promise<void>((go) => waiting.push(go)); // the slot is handed over, so active stays counted
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  /** One request, to a pinned host, with no redirects and no decompression. */
  const download = (t: Target) =>
    new Promise<{ body: Buffer; type: string }>((resolve, reject) => {
      if (!PINNED.has(t.host)) return reject(unavailable());
      const policy = POLICY[t.kind];
      const cap = options.maxBytes?.[t.kind] ?? policy.cap;
      const opts: RequestOptions = {
        protocol: 'https:',
        host: t.host,
        port: 443,
        path: t.path,
        method: 'GET',
        lookup: lookup as RequestOptions['lookup'],
        // deliberately nothing from the visitor's request: no cookie, no language, no user agent
        headers: { accept: policy.accept, 'accept-encoding': 'identity', 'user-agent': USER_AGENT },
      };
      let timer: NodeJS.Timeout | undefined;
      const stop = (e: unknown, c: ReturnType<typeof request>) => { clearTimeout(timer); c.destroy(); reject(e); };
      const client = request(opts, (up) => {
        const status = up.statusCode ?? 0;
        if (status === 404) return stop(new ProxyError(404, 'Not found'), client);
        if (status === 429) {
          const seconds = Math.min(300, Number(up.headers['retry-after']) || 30);
          coolUntil.set(t.host, now() + seconds * 1000);
          return stop(new ProxyError(503, 'The online library is busy. Try again shortly.', seconds), client);
        }
        const encoding = String(up.headers['content-encoding'] ?? 'identity').toLowerCase();
        const type = String(up.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        // a 3xx lands here too: its Location is never read
        if (status !== 200 || encoding !== 'identity' || !policy.types.test(type) || Number(up.headers['content-length'] ?? 0) > cap) return stop(unavailable(), client);
        const chunks: Buffer[] = [];
        let size = 0;
        up.on('data', (c: Buffer) => {
          size += c.length;
          if (size > cap) return stop(unavailable(), client);
          chunks.push(c);
        });
        up.on('end', () => { clearTimeout(timer); resolve({ body: Buffer.concat(chunks), type }); });
        up.on('error', (e) => stop(e, client));
      });
      timer = setTimeout(() => stop(new ProxyError(504, 'The online library took too long to answer.'), client), timeoutMs);
      client.on('error', (e) => { clearTimeout(timer); reject(e); });
      client.end();
    });

  const load = async (t: Target): Promise<Entry> => {
    const cached = cache.get(t.key, now());
    if (cached) return cached;
    const running = inFlight.get(t.key);
    if (running) return running;
    // every user shares this server's address upstream, so a host that says stop gets left alone
    const cooling = (coolUntil.get(t.host) ?? 0) - now();
    if (cooling > 0) throw new ProxyError(503, 'The online library is busy. Try again shortly.', Math.ceil(cooling / 1000));
    const job = (async () => {
      await slot();
      try {
        const got = await download(t);
        const tokens: [string, string][] = [];
        let body = got.body;
        let type = got.type;
        if (t.kind === 'css') {
          body = Buffer.from(rewriteFontCss(got.body.toString('utf8'), (file) => {
            const parsed = new URL(file);
            if (parsed.protocol !== 'https:' || parsed.hostname !== FONT_FILES) throw new Error('font on an unexpected host');
            const token = createHash('sha256').update(file).digest('hex').slice(0, 32);
            tokens.push([token, parsed.pathname + parsed.search]);
            return token;
          }));
          type = 'text/css; charset=utf-8';
        } else if (t.kind === 'svg') {
          body = Buffer.from(sanitizeSvg(got.body.toString('utf8')));
        } else if (t.kind === 'font') {
          type = fontMime(got.body);
        } else {
          body = t.finish ? t.finish(got.body) : got.body;
          type = 'application/json; charset=utf-8';
        }
        const entry: Entry = { body, type, expires: now() + POLICY[t.kind].ttl, tokens };
        cache.set(t.key, entry);
        return entry;
      } finally {
        release();
      }
    })();
    inFlight.set(t.key, job);
    try {
      return await job;
    } finally {
      inFlight.delete(t.key);
    }
  };

  function route(url: URL): Target {
    const rest = url.pathname.slice(ASSET_PROXY_PREFIX.length);
    let m: RegExpExecArray | null;
    if (rest === '/icons/collections') {
      params(url, []);
      return { key: 'icons|collections', kind: 'json', host: ICONIFY, path: '/collections', finish: shaped(SHAPE.collections as never) };
    }
    if (rest === '/icons/collection') {
      const prefix = iconPart(single(params(url, ['prefix']), 'prefix'), 'collection');
      return { key: `icons|collection|${prefix}`, kind: 'json', host: ICONIFY, path: `/collection?prefix=${prefix}`, finish: shaped(SHAPE.collection as never) };
    }
    if (rest === '/icons/search') {
      const q = params(url, ['query', 'prefix', 'limit']);
      const query = single(q, 'query')?.trim();
      if (!query || !QUERY.test(query)) throw bad('Search with letters and numbers.');
      const limit = single(q, 'limit') ?? '240';
      if (!/^\d{1,3}$/.test(limit) || Number(limit) < 32 || Number(limit) > 240) throw bad('limit must be between 32 and 240.');
      const given = single(q, 'prefix');
      const prefix = given === undefined ? undefined : iconPart(given, 'collection');
      return { key: `icons|search|${prefix ?? ''}|${limit}|${query}`, kind: 'json', host: ICONIFY, path: `/search?query=${encodeURIComponent(query)}&limit=${limit}${prefix ? `&prefix=${prefix}` : ''}`, finish: shaped(SHAPE.search as never) };
    }
    if ((m = /^\/icons\/svg\/([^/]+)\/([^/]+)\.svg$/.exec(rest))) {
      params(url, []);
      const prefix = iconPart(m[1], 'collection');
      const name = iconPart(m[2], 'icon');
      return { key: `icons|svg|${prefix}|${name}`, kind: 'svg', host: ICONIFY, path: `/${prefix}/${name}.svg` };
    }
    if (rest === '/fonts/css') return fontTarget(params(url, ['family', 'preview']), undefined);
    if ((m = /^\/fonts\/file\/([^/]+)$/.exec(rest))) {
      params(url, []);
      if (!TOKEN.test(m[1]!)) throw bad('That is not a font file reference.');
      const path = fontFiles.get(m[1]!);
      if (!path) throw new ProxyError(404, 'Not found');
      return { key: `font|${m[1]}`, kind: 'font', host: FONT_FILES, path };
    }
    throw new ProxyError(404, 'Not found');
  }

  return {
    async handle(req, res, url, userKey) {
      const fail = (status: number, message: string, retryAfter?: number) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(retryAfter ? { 'retry-after': String(retryAfter) } : {}) });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: message }));
      };
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'Method not allowed');
        const wait = buckets.take(userKey, now());
        if (wait) return fail(429, 'Too many requests. Slow down and try again.', wait);
        const target = route(url);
        const entry = await load(target);
        for (const [token, path] of entry.tokens ?? []) rememberToken(token, path);
        const headers: Record<string, string | number> = {
          'content-type': entry.type,
          'content-length': entry.body.length,
          'cache-control': POLICY[target.kind].browser,
          'x-content-type-options': 'nosniff',
          'cross-origin-resource-policy': 'same-origin',
        };
        if (target.kind === 'svg') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : entry.body);
      } catch (e) {
        if (res.headersSent) return void res.destroy();
        if (e instanceof ProxyError) return fail(e.status, e.message, e.retryAfter);
        // upstream details stay here: a client learns nothing about what was reached or how it failed
        fail(502, unavailable().message);
      }
    },
  };
}

/** The process-wide proxy: its cache and limits are shared by every project this server hosts. */
export const assetProxy = createAssetProxy();
