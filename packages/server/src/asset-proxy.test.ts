import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fontHead, proxiedFontPreviewUrl, proxiedFontUrl, googleFontUrl, createDocument, applyRdl } from '@rangoli/engine';
import { openDatabase, type Database } from './app/db.js';
import { startApp, type AppServer } from './app/server.js';
import { createAssetProxy, isPublicAddress, pinnedLookup, rewriteFontCss, sanitizeSvg, type AssetProxy, type AssetProxyOptions } from './asset-proxy.js';
import { LOCAL_EDITOR_CSP } from './http.js';

const P = '/api/asset-proxy';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M1 1h2"/></svg>';
const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(64, 1)]);
const face = (file: string) => `/* latin */\n@font-face {\n  font-family: 'Inter';\n  font-style: normal;\n  font-weight: 400;\n  font-display: swap;\n  src: url(${file}) format('woff2');\n  unicode-range: U+0000-00FF, U+2000;\n}\n`;
const GSTATIC = 'https://fonts.gstatic.com/s/inter/v20/abc.woff2';

/** Stands in for the three upstream hosts over a real socket. */
let upstream: Server;
let upstreamPort = 0;
let handler: (req: IncomingMessage, res: ServerResponse) => void = (_q, s) => s.writeHead(500).end();
let hits: IncomingMessage[] = [];
const reply = (type: string, body: string | Buffer, status = 200, headers: Record<string, string> = {}) => (_q: IncomingMessage, s: ServerResponse) => s.writeHead(status, { 'content-type': type, ...headers }).end(body);

/** Sends the proxy's request to the stand-in, without its address check. */
const toUpstream = ((opts: Parameters<typeof httpRequest>[0] & object, cb: never) => httpRequest({ ...opts, protocol: 'http:', host: '127.0.0.1', port: upstreamPort, lookup: undefined, headers: { ...(opts as { headers: object }).headers, 'x-host': (opts as { host: string }).host } }, cb)) as unknown as typeof httpsRequest;
/** Keeps the proxy's own lookup, so whatever it resolves is what the socket connects to. */
const withLookup = ((opts: Parameters<typeof httpRequest>[0] & object, cb: never) => httpRequest({ ...opts, protocol: 'http:', port: upstreamPort }, cb)) as unknown as typeof httpsRequest;

const servers: Server[] = [];
async function mount(proxy: AssetProxy, user: (req: IncomingMessage) => string = (r) => String(r.headers['x-user'] ?? 'u1')) {
  const s = createServer((q, r) => void proxy.handle(q, r, new URL(q.url!, 'http://x'), user(q)));
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  servers.push(s);
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return (path: string, headers: Record<string, string> = {}) => fetch(base + P + path, { headers });
}
const proxy = (o: AssetProxyOptions = {}) => mount(createAssetProxy({ request: toUpstream, ...o }));

beforeAll(async () => {
  upstream = createServer((q, s) => { hits.push(q); handler(q, s); });
  await new Promise<void>((ok) => upstream.listen(0, '127.0.0.1', ok));
  upstreamPort = (upstream.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const s of [...servers, upstream]) { s.closeAllConnections(); await new Promise((ok) => s.close(ok)); }
});
beforeEach(() => { hits = []; });

describe('addresses', () => {
  it.each(['127.0.0.1', '127.8.8.8', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.100.100.200', '100.64.0.1', '0.0.0.0', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', '2001:0:a9fe::1', '2001:db8::1', 'ff02::1', 'not-an-ip', ''])('refuses %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it.each(['8.8.8.8', '1.1.1.1', '142.250.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4001::1'])('allows %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', 'fd00:ec2::254', '::ffff:10.0.0.1'])('never connects when the pinned host resolves to %s', async (address) => {
    const get = await mount(createAssetProxy({ request: withLookup, resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }] }));
    handler = reply('application/json', '{}');
    expect((await get('/icons/collections')).status).toBe(502);
    expect(hits).toHaveLength(0);
  });
  it('refuses when any one answer is private, even beside public ones', async () => {
    const get = await mount(createAssetProxy({ request: withLookup, resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] }));
    expect((await get('/icons/collections')).status).toBe(502);
    expect(hits).toHaveLength(0);
  });
  it('resolves only pinned hosts', () => {
    let asked = false;
    const lookup = pinnedLookup(async () => { asked = true; return [{ address: '8.8.8.8', family: 4 }]; });
    let err: Error | null = null;
    lookup('evil.example', { all: true }, (e) => { err = e; });
    expect(err).toBeInstanceOf(Error);
    expect(asked).toBe(false);
  });
  it('hands the checked public address to the socket', async () => {
    const out = await new Promise<unknown>((ok) => pinnedLookup(async () => [{ address: '8.8.8.8', family: 4 }])('api.iconify.design', { all: true }, (_e, a) => ok(a)));
    expect(out).toEqual([{ address: '8.8.8.8', family: 4 }]);
  });
});

describe('inputs', () => {
  it.each([
    '/icons/collection?prefix=https://evil.example/',
    '/icons/collection?prefix=//evil.example',
    '/icons/collection?prefix=http%3A%2F%2F169.254.169.254',
    '/icons/collection?url=https://evil.example',
    '/icons/collections?host=evil.example',
    '/icons/search?query=http://169.254.169.254/',
    '/fonts/css?family=https://evil.example/x.css',
    '/fonts/css?url=https://fonts.googleapis.com/css2',
    '/icons/svg/https:%2F%2Fevil.example/x.svg',
    '/icons/svg/..%2F..%2Fadmin/x.svg',
    '/fonts/file/https:%2F%2Fevil.example%2Fx.woff2',
    `/fonts/file/${'a'.repeat(32)}?src=https://evil.example`,
  ])('refuses the URL-shaped input %s without an upstream request', async (path) => {
    const get = await proxy();
    expect((await get(path)).status).toBe(400);
    expect(hits).toHaveLength(0);
  });
  it.each([
    '/icons/svg/https://evil.example/x.svg',
    '/icons/svg/../../etc/x.svg',
    '/fonts/file/s/inter/v20/abc.woff2',
    '/nothing',
  ])('has no route for %s', async (path) => {
    const get = await proxy();
    expect((await get(path)).status).toBeGreaterThanOrEqual(400);
    expect(hits).toHaveLength(0);
  });

  it.each(['', 'A', 'In<ter', "Inter'", 'Inter;x', 'Inter\n', 'Inter%00', '../Inter', '-Inter', 'Not A Real Font Family', 'Arial', 'x'.repeat(81)])('refuses the malformed or unknown family %j', async (family) => {
    const get = await proxy();
    expect((await get(`/fonts/css?family=${encodeURIComponent(family)}`)).status).toBe(400);
    expect(hits).toHaveLength(0);
  });
  it('limits how many families one request names', async () => {
    const get = await proxy();
    expect((await get(`/fonts/css?${Array(25).fill('family=Inter').join('&')}`)).status).toBe(400);
    expect((await get('/fonts/css')).status).toBe(400);
  });
  it.each(['Evil.Name', 'UPPER', 'a/b', 'a b', '.hidden', '-x'])('refuses the icon collection %j', async (prefix) => {
    const get = await proxy();
    expect((await get(`/icons/collection?prefix=${encodeURIComponent(prefix)}`)).status).toBe(400);
  });
  it('refuses a font token this proxy never issued', async () => {
    const get = await proxy();
    expect((await get(`/fonts/file/${'a'.repeat(32)}`)).status).toBe(404);
    expect(hits).toHaveLength(0);
  });
  it('builds the upstream request only from the names', async () => {
    const get = await proxy();
    handler = reply('application/json', JSON.stringify({ icons: ['mdi:home'] }));
    const r = await get('/icons/search?query=home%20page&limit=240&prefix=mdi');
    expect(await r.json()).toEqual({ icons: ['mdi:home'] });
    expect(hits[0]!.url).toBe('/search?query=home%20page&limit=240&prefix=mdi');
    expect(hits[0]!.headers['x-host']).toBe('api.iconify.design');
  });
  it('takes font weights from the catalogue, not the caller', async () => {
    const get = await proxy();
    handler = reply('text/css', face(GSTATIC));
    await get('/fonts/css?family=Inter');
    expect('https://fonts.googleapis.com' + hits[0]!.url).toBe(googleFontUrl(['Inter']));
    expect(hits[0]!.headers['x-host']).toBe('fonts.googleapis.com');
  });
});

describe('upstream responses', () => {
  it('does not follow a redirect', async () => {
    const get = await proxy();
    handler = (q, s) => (q.url === '/mdi/home.svg' ? s.writeHead(302, { location: `http://127.0.0.1:${upstreamPort}/secret.svg`, 'content-type': 'image/svg+xml' }).end() : reply('image/svg+xml', SVG)(q, s));
    expect((await get('/icons/svg/mdi/home.svg')).status).toBe(502);
    expect(hits.map((h) => h.url)).toEqual(['/mdi/home.svg']);
  });
  it('refuses a declared oversize body', async () => {
    const get = await proxy({ maxBytes: { svg: 200 } });
    handler = reply('image/svg+xml', `<svg>${' '.repeat(5000)}</svg>`);
    expect((await get('/icons/svg/mdi/big.svg')).status).toBe(502);
  });
  it('refuses a streamed body that passes the cap, with no length declared', async () => {
    const get = await proxy({ maxBytes: { svg: 2000 } });
    handler = (_q, s) => { s.writeHead(200, { 'content-type': 'image/svg+xml' }); s.write('x'.repeat(1500)); setTimeout(() => s.end('y'.repeat(1500)), 20); };
    expect((await get('/icons/svg/mdi/stream.svg')).status).toBe(502);
  });
  it.each([
    ['/icons/svg/mdi/a.svg', 'text/html'],
    ['/icons/svg/mdi/b.svg', 'text/plain'],
    ['/icons/svg/mdi/c.svg', ''],
    ['/icons/collections', 'text/html'],
    ['/fonts/css?family=Roboto', 'text/html'],
  ])('refuses %s answered as %j', async (path, type) => {
    const get = await proxy();
    handler = reply(type, '<html></html>');
    expect((await get(path)).status).toBe(502);
  });
  it('refuses compressed responses rather than inflating them', async () => {
    const get = await proxy();
    handler = reply('image/svg+xml', SVG, 200, { 'content-encoding': 'gzip' });
    expect((await get('/icons/svg/mdi/gz.svg')).status).toBe(502);
  });
  it('asks for an uncompressed body', async () => {
    const get = await proxy();
    handler = reply('image/svg+xml', SVG);
    await get('/icons/svg/mdi/plain.svg');
    expect(hits[0]!.headers['accept-encoding']).toBe('identity');
  });
  it('times out a server that never answers', async () => {
    const get = await proxy({ timeoutMs: 60 });
    handler = () => undefined;
    expect((await get('/icons/svg/mdi/slow.svg')).status).toBe(504);
  });
  it('times out a body that stalls after the headers', async () => {
    const get = await proxy({ timeoutMs: 60 });
    handler = (_q, s) => { s.writeHead(200, { 'content-type': 'image/svg+xml' }); s.write('<svg>'); };
    expect((await get('/icons/svg/mdi/stall.svg')).status).toBe(504);
  });
  it('passes a 404 on and refuses other errors', async () => {
    const get = await proxy();
    handler = reply('text/plain', 'no', 404);
    expect((await get('/icons/svg/mdi/none.svg')).status).toBe(404);
    handler = reply('text/plain', 'oops', 500);
    expect((await get('/icons/svg/mdi/err.svg')).status).toBe(502);
  });
  it('backs off a host that rate limits it, while cached answers keep working', async () => {
    let t = 1_000_000;
    const get = await proxy({ now: () => t });
    handler = reply('image/svg+xml', SVG);
    await get('/icons/svg/mdi/kept.svg');
    hits = [];
    handler = reply('text/plain', 'error code: 1015', 429, { 'retry-after': '35' });
    const first = await get('/icons/svg/mdi/x1.svg');
    expect(first.status).toBe(503);
    expect(first.headers.get('retry-after')).toBe('35');
    const second = await get('/icons/svg/mdi/x2.svg');
    expect(second.status).toBe(503);
    expect(hits).toHaveLength(1);
    expect((await get('/icons/svg/mdi/kept.svg')).status).toBe(200);
    handler = reply('text/css', face(GSTATIC));
    expect((await get('/fonts/css?family=Karla')).status).toBe(200); // a different host is unaffected
    t += 36_000;
    handler = reply('image/svg+xml', SVG);
    expect((await get('/icons/svg/mdi/x2.svg')).status).toBe(200);
  });
  it('never tells the client what went wrong upstream', async () => {
    const get = await proxy();
    handler = reply('text/plain', 'internal-secret', 500);
    expect(await (await get('/icons/collections')).text()).not.toContain('internal-secret');
  });
  it('reduces JSON to the fields the editor reads', async () => {
    const get = await proxy();
    handler = reply('application/json', JSON.stringify({ mdi: { name: 'Material', total: 7, author: { url: 'https://x' }, license: { title: 'MIT', url: 'https://y' } }, 'bad/id': { name: 'x', total: 1 } }));
    expect(await (await get('/icons/collections')).json()).toEqual({ mdi: { name: 'Material', total: 7, palette: false, license: { title: 'MIT' } } });
  });
  it('refuses invalid JSON', async () => {
    const get = await proxy();
    handler = reply('application/json', '{nope');
    expect((await get('/icons/collection?prefix=mdi')).status).toBe(502);
  });
  it('refuses a "font" that is not one', async () => {
    const get = await proxy();
    handler = reply('text/css', face(GSTATIC));
    const css = await (await get('/fonts/css?family=Lato')).text();
    handler = reply('font/woff2', '<html>not a font</html>');
    expect((await get(css.match(/fonts\/file\/[a-f0-9]{32}/)![0].replace(/^/, '/'))).status).toBe(502);
  });
});

describe('fonts', () => {
  it('serves every font file through the proxy', async () => {
    const get = await proxy();
    handler = reply('text/css', face(GSTATIC));
    const res = await get('/fonts/css?family=Oswald');
    const css = await res.text();
    expect(res.headers.get('content-type')).toContain('text/css');
    expect(css).not.toContain('gstatic');
    expect(css).not.toContain('https:');
    const path = /url\(\/api\/asset-proxy(\/fonts\/file\/[a-f0-9]{32})\) format\('woff2'\)/.exec(css)![1]!;
    expect(css).toContain("font-family:'Inter'");
    hits = [];
    handler = reply('font/woff2', WOFF2);
    const file = await get(path);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('font/woff2');
    expect(Buffer.from(await file.arrayBuffer()).equals(WOFF2)).toBe(true);
    expect(hits[0]!.url).toBe('/s/inter/v20/abc.woff2');
    expect(hits[0]!.headers['x-host']).toBe('fonts.gstatic.com');
  });
  it('keeps the kit parameters of a preview subset', async () => {
    const get = await proxy();
    handler = reply('text/css', face('https://fonts.gstatic.com/l/font?kit=AbC-_1&skey=c491&v=v20'));
    const css = await (await get('/fonts/css?family=Inter&preview=1')).text();
    handler = reply('font/woff2', WOFF2);
    hits = [];
    expect((await get(/\/fonts\/file\/[a-f0-9]{32}/.exec(css)![0])).status).toBe(200);
    expect(hits[0]!.url).toBe('/l/font?kit=AbC-_1&skey=c491&v=v20');
  });
  it('drops everything that is not a known font-face descriptor', () => {
    const css = rewriteFontCss(`@import url(https://evil.example/x.css);\nbody{background:url(https://evil.example/p)}\n@font-face{font-family:'A';src:url(${GSTATIC});font-style:normal;color:expression(alert(1));behavior:url(x)}`, () => 'tok');
    expect(css).toBe("@font-face{font-family:'A';font-style:normal;src:url(/api/asset-proxy/fonts/file/tok)}");
  });
  it.each(['https://evil.example/a.woff2', 'http://fonts.gstatic.com/a.woff2', 'https://fonts.gstatic.com.evil.example/a.woff2', 'https://fonts.gstatic.com@evil.example/a.woff2'])('refuses a stylesheet pointing fonts at %s', (file) => {
    expect(() => rewriteFontCss(`@font-face{font-family:'A';src:url(${file})}`, () => 'tok')).toThrow();
  });
  it('cannot be broken out of with a closing brace', () => {
    const css = rewriteFontCss(`@font-face{font-family:'A';src:url(${GSTATIC})}body{x:url(y)}`, () => 'tok');
    expect(css).toBe("@font-face{font-family:'A';src:url(/api/asset-proxy/fonts/file/tok)}");
  });
  it('fails closed when the stylesheet has nothing usable', async () => {
    const get = await proxy();
    handler = reply('text/css', 'body{color:red}');
    expect((await get('/fonts/css?family=Merriweather')).status).toBe(502);
  });
});

describe('svg', () => {
  const clean = (s: string) => sanitizeSvg(s);
  it('leaves an ordinary icon intact', () => expect(clean(SVG)).toBe(SVG));
  it('strips script', () => {
    const out = clean('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1<2)</script><path d="M0 0"/><SCRIPT src="x"></SCRIPT></svg>');
    expect(out).toBe('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
  });
  it('strips event handlers', () => {
    expect(clean('<svg onload="alert(1)"><path onclick=\'x()\' d="M0 0"/></svg>')).toBe('<svg><path d="M0 0"/></svg>');
  });
  it('strips foreignObject, images, links and styles with their contents', () => {
    const out = clean('<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="x"></iframe></div></foreignObject><image href="https://x/y.png"/><a href="javascript:alert(1)"><path d="M1 1"/></a><style>@import "x";</style></svg>');
    expect(out).toBe('<svg></svg>');
  });
  it('keeps only local references', () => {
    expect(clean('<svg><use href="https://evil.example/x.svg#a"/><use href="#a"/><use xlink:href="javascript:alert(1)"/></svg>')).toBe('<svg><use/><use href="#a"/><use/></svg>');
    expect(clean('<svg><path fill="url(https://evil.example/p)" stroke="url(#g)" d="M0 0"/></svg>')).toBe('<svg><path stroke="url(#g)" d="M0 0"/></svg>');
  });
  it('blocks encoded schemes and hostile style', () => {
    expect(clean('<svg><use href="&#106;avascript:alert(1)"/></svg>')).toBe('<svg><use/></svg>');
    expect(clean('<svg><path style="background:url(https://x/y)" d="M0 0"/></svg>')).toBe('<svg><path d="M0 0"/></svg>');
  });
  it('cannot be animated into a link', () => {
    expect(clean('<svg><animate attributeName="href" to="javascript:alert(1)"/></svg>')).toBe('<svg><animate/></svg>');
    expect(clean('<svg><circle r="1"><animate attributeName="r" values="1;2" dur="1s" repeatCount="indefinite"/></circle></svg>')).toBe('<svg><circle r="1"><animate attributeName="r" values="1;2" dur="1s" repeatCount="indefinite"/></circle></svg>');
  });
  it.each(['<div/>', 'plain text', '<svg>', '<svg></svg><svg></svg>', '<svg><g></svg>', '<svg><!DOCTYPE x [<!ENTITY a "b">]></svg>', '<svg><![CDATA[x]]></svg>', '<svg onload=alert(1)></svg>', '<svg><script>x</svg>', '<svg><!-- open </svg>'])('refuses %s', (s) => {
    expect(() => clean(s)).toThrow();
  });
  it('is sanitised and locked down on the wire', async () => {
    const get = await proxy();
    handler = reply('image/svg+xml; charset=utf-8', '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>alert(1)</script><path d="M0 0"/></svg>');
    const r = await get('/icons/svg/mdi/evil.svg');
    const body = await r.text();
    expect(r.status).toBe(200);
    expect(body).not.toMatch(/script|onload/);
    expect(r.headers.get('content-type')).toBe('image/svg+xml');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
  it('refuses an icon that cannot be sanitised', async () => {
    const get = await proxy();
    handler = reply('image/svg+xml', '<svg><g></svg>');
    expect((await get('/icons/svg/mdi/broken.svg')).status).toBe(502);
  });
});

describe('cache and limits', () => {
  it('serves a repeat from the cache', async () => {
    const get = await proxy();
    handler = reply('image/svg+xml', SVG);
    await get('/icons/svg/mdi/one.svg');
    expect(await (await get('/icons/svg/mdi/one.svg')).text()).toBe(SVG);
    expect(hits).toHaveLength(1);
  });
  it('makes one upstream request for concurrent callers', async () => {
    const get = await proxy();
    handler = (q, s) => void setTimeout(() => reply('image/svg+xml', SVG)(q, s), 30);
    await Promise.all([get('/icons/svg/mdi/two.svg'), get('/icons/svg/mdi/two.svg', { 'x-user': 'u2' })]);
    expect(hits).toHaveLength(1);
  });
  it('keeps names apart, so one icon can never answer for another', async () => {
    const get = await proxy();
    handler = (q, s) => reply('image/svg+xml', `<svg id="${q.url!.replace(/\W/g, '')}"></svg>`)(q, s);
    expect(await (await get('/icons/svg/a/b-c.svg')).text()).toContain('abcsvg');
    expect(await (await get('/icons/svg/a-b/c.svg')).text()).toContain('abcsvg');
    expect(hits).toHaveLength(2);
    handler = reply('application/json', JSON.stringify({ icons: [] }));
    await get('/icons/search?query=home&limit=240');
    await get('/icons/search?query=home&limit=240&prefix=mdi');
    expect(hits).toHaveLength(4);
  });
  it('sends nothing from the visitor upstream, so a cached answer cannot depend on who asked', async () => {
    const get = await proxy();
    handler = reply('image/svg+xml', SVG);
    await get('/icons/svg/mdi/three.svg', { cookie: 'rangoli_session=secret', authorization: 'Bearer rng_secret', 'x-forwarded-for': '10.0.0.9', 'user-agent': 'victim-browser', 'accept-language': 'hi-IN', referer: 'http://app/p/secret' });
    const h = hits[0]!.headers;
    expect(h.cookie).toBeUndefined();
    expect(h.authorization).toBeUndefined();
    expect(h['x-forwarded-for']).toBeUndefined();
    expect(h['accept-language']).toBeUndefined();
    expect(h.referer).toBeUndefined();
    expect(h['user-agent']).not.toContain('victim');
  });
  it('marks every response private so shared caches keep out', async () => {
    const get = await proxy();
    handler = reply('image/svg+xml', SVG);
    expect((await get('/icons/svg/mdi/four.svg')).headers.get('cache-control')).toMatch(/^private/);
    handler = reply('text/css', face(GSTATIC));
    expect((await get('/fonts/css?family=Barlow')).headers.get('cache-control')).toBe('no-store');
  });
  it('does not share a cache or font tokens between proxies', async () => {
    const [a, b] = [await proxy(), await proxy()];
    handler = reply('text/css', face(GSTATIC));
    const css = await (await a('/fonts/css?family=Cabin')).text();
    await b('/fonts/css?family=Cabin');
    expect(hits).toHaveLength(2);
    const c = await proxy();
    expect((await c(/\/fonts\/file\/[a-f0-9]{32}/.exec(css)![0])).status).toBe(404);
  });
  it('never stores a refused or failed answer', async () => {
    const get = await proxy();
    handler = reply('text/plain', 'oops', 500);
    expect((await get('/icons/svg/mdi/five.svg')).status).toBe(502);
    handler = reply('image/svg+xml', SVG);
    expect((await get('/icons/svg/mdi/five.svg')).status).toBe(200);
  });
  it('expires entries', async () => {
    let t = 1_000_000;
    const get = await proxy({ now: () => t });
    handler = reply('image/svg+xml', SVG);
    await get('/icons/svg/mdi/six.svg');
    t += 25 * 3600_000;
    await get('/icons/svg/mdi/six.svg');
    expect(hits).toHaveLength(2);
  });
  it('stays within its byte and entry bounds, oldest out first', async () => {
    const get = await proxy({ cacheEntries: 2 });
    handler = reply('image/svg+xml', SVG);
    for (const n of ['a', 'b', 'c']) await get(`/icons/svg/mdi/${n}.svg`);
    await get('/icons/svg/mdi/c.svg');
    expect(hits).toHaveLength(3);
    await get('/icons/svg/mdi/a.svg');
    expect(hits).toHaveLength(4);
  });
  it('limits each user separately, cached answers included', async () => {
    const get = await proxy({ rate: { burst: 3, perSecond: 0.001 } });
    handler = reply('image/svg+xml', SVG);
    for (let i = 0; i < 3; i++) expect((await get('/icons/svg/mdi/seven.svg')).status).toBe(200);
    const blocked = await get('/icons/svg/mdi/seven.svg');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await get('/icons/svg/mdi/seven.svg', { 'x-user': 'u2' })).status).toBe(200);
  });
  it('counts refused input against the limit', async () => {
    const get = await proxy({ rate: { burst: 1, perSecond: 0.001 } });
    expect((await get('/icons/collection?prefix=BAD')).status).toBe(400);
    expect((await get('/icons/collection?prefix=BAD')).status).toBe(429);
  });
  it('recovers as the bucket refills', async () => {
    let t = 1_000_000;
    const get = await proxy({ now: () => t, rate: { burst: 1, perSecond: 1 } });
    handler = reply('image/svg+xml', SVG);
    await get('/icons/svg/mdi/eight.svg');
    expect((await get('/icons/svg/mdi/eight.svg')).status).toBe(429);
    t += 1500;
    expect((await get('/icons/svg/mdi/eight.svg')).status).toBe(200);
  });
});

describe('where it is mounted', () => {
  let db: Database;
  let app: AppServer;
  beforeAll(async () => {
    db = await openDatabase();
    app = await startApp({ db, port: 0 });
  }, 120_000); // opening the database runs every migration
  afterAll(async () => {
    await app.close();
    await db.close();
  }, 60_000);
  it.each(['/icons/collections', '/icons/svg/mdi/home.svg', '/fonts/css?family=Inter', `/fonts/file/${'a'.repeat(32)}`])('needs a session on the hosted app: %s', async (path) => {
    const r = await fetch(new URL(`api/asset-proxy${path}`, app.url));
    expect(r.status).toBe(401);
    expect(await r.text()).toContain('Sign in');
  });
  it('refuses a made-up session too', async () => {
    const r = await fetch(new URL('api/asset-proxy/icons/collections', app.url), { headers: { cookie: 'rangoli_session=nope' } });
    expect(r.status).toBe(401);
  });
  it('reaches the proxy once signed in, and input checks still apply', async () => {
    const signup = await fetch(new URL('api/auth/signup', app.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'p@example.com', name: 'P', password: 'correct horse battery' }) });
    const cookie = signup.headers.get('set-cookie')!.split(';')[0]!;
    const r = await fetch(new URL('api/asset-proxy/icons/collection?prefix=https://evil.example', app.url), { headers: { cookie } });
    expect(r.status).toBe(400);
  });
});

describe('the editor side', () => {
  const docWith = () => { const d = createDocument('t'); applyRdl(d, 'Text "x" font:"Playfair Display"'); return d; };
  it('exports keep linking Google directly', () => {
    expect(fontHead(docWith()).links.join()).toContain('https://fonts.googleapis.com/css2?');
  });
  it('the editor gets names on the same origin', () => {
    const links = fontHead(docWith(), { proxied: true }).links;
    expect(links).toEqual(['/api/asset-proxy/fonts/css?family=Playfair%20Display']);
    expect(proxiedFontUrl(['Arial'])).toBeUndefined();
    expect(proxiedFontPreviewUrl('Inter')).toBe('/api/asset-proxy/fonts/css?family=Inter&preview=1');
  });
  it('the local editor policy refuses what must stay refused', () => {
    expect(LOCAL_EDITOR_CSP).toContain("script-src-attr 'none'");
    expect(LOCAL_EDITOR_CSP).toContain("object-src 'none'");
    expect(LOCAL_EDITOR_CSP).toContain("base-uri 'none'");
    expect(LOCAL_EDITOR_CSP).toContain("frame-ancestors 'none'");
    expect(LOCAL_EDITOR_CSP).not.toContain('unsafe-eval');
    expect(LOCAL_EDITOR_CSP).toMatch(/script-src 'self';/);
  });
});
