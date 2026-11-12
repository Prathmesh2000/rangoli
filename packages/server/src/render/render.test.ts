import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRdl, createDocument } from '@rangoli/engine';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { editImage } from '../imaging.js';
import { closeShots, renderPng } from '../shots.js';
import { browserEnv, inProcessRenderer } from './in-process.js';
import { closeRenderer, createRenderer } from './index.js';
import { checkImage, checkInlineImages, MAX_PIXELS, sniffMime } from './limits.js';
import { probe } from './probe.js';
import type { ShotJob } from './port.js';
import { INPUT_ORIGIN, inputUrl, sha256, signRequest, type RenderRequest } from './protocol.js';
import { hoistImages, remoteRenderer } from './remote.js';
import { createRenderService, forbiddenEnv, type Launch, type ServiceBrowser, type ServiceOptions } from './service.js';

const SECRET = 'test-secret-that-is-long-enough-for-the-service';
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

type FakeRoute = { url: string; result?: 'fulfilled' | 'aborted'; body?: Buffer };

/** A browser that records what it was asked to do. `onContent` runs when a page loads. */
function fakeBrowser(onContent?: (html: string, request: (url: string) => FakeRoute) => Promise<void> | void) {
  const calls = { launches: [] as { sandbox: boolean; args: string[]; env: Record<string, string> }[], contexts: [] as Record<string, unknown>[], closes: 0, html: [] as string[] };
  const launch: Launch = async (o) => {
    calls.launches.push(o);
    const browser: ServiceBrowser = {
      close: async () => { calls.closes++; },
      newContext: async (options) => {
        calls.contexts.push(options as Record<string, unknown>);
        let handler: (r: never) => unknown = () => undefined;
        const request = (url: string) => {
          const seen: FakeRoute = { url };
          handler({
            request: () => ({ url: () => url }),
            fulfill: async (f: { body: Buffer }) => { seen.result = 'fulfilled'; seen.body = f.body; },
            abort: async () => { seen.result = 'aborted'; },
          } as never);
          return seen;
        };
        return {
          route: async (_u, h) => { handler = h as never; },
          routeWebSocket: async () => undefined,
          close: async () => undefined,
          newPage: async () => ({
            setContent: async (html: string) => { calls.html.push(html); await onContent?.(html, request); },
            evaluate: (async () => ({ uri: `data:image/png;base64,${PNG_1PX.toString('base64')}`, w: 1, h: 1 })) as never,
            locator: () => ({ screenshot: async () => PNG_1PX }),
            close: async () => undefined,
            waitForTimeout: async () => undefined,
          }),
        };
      },
    };
    return browser;
  };
  return { launch, calls };
}

const started: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.close()));
});

async function startService(options: Partial<ServiceOptions>) {
  const service = createRenderService({ secret: SECRET, log: () => undefined, ...options });
  const url = await service.listen(0, '127.0.0.1');
  started.push(service);
  return { service, url };
}

const SHOT: ShotJob = { html: '<!doctype html><html><head></head><body><div id="shot">hi</div></body></html>', viewport: { width: 400, height: 300 }, scale: 1, selector: '#shot' };

const shotRequest = (html = SHOT.html, extra: Partial<RenderRequest> = {}, job: Partial<ShotJob> = {}): RenderRequest => ({ jti: randomUUID(), job: { kind: 'shot', ...SHOT, ...job, html }, blobs: [], inputs: [], ...extra });

const editRequest = (image: Buffer, mime: string): RenderRequest => ({ jti: randomUUID(), job: { kind: 'edit', image: image.toString('base64'), mime, ops: [], format: 'png', quality: 80 }, blobs: [], inputs: [] });

async function post(url: string, request: RenderRequest, options: { secret?: string; body?: Buffer; now?: number; token?: string | null } = {}) {
  const signed = Buffer.from(JSON.stringify(request));
  const body = options.body ?? signed;
  const token = options.token === undefined ? signRequest(options.secret ?? SECRET, request.jti, signed, options.now) : options.token;
  const res = await fetch(`${url}/v1/render`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body });
  return { status: res.status, text: await res.text() };
}

/** A request whose page uses one signed input, built the way the remote adapter builds them. */
function signedImagePage(data: Buffer, mime = 'image/png', occurrences = 1) {
  const jti = randomUUID();
  const inline = `data:${mime};base64,${data.toString('base64')}`;
  const { html, blobs, inputs } = hoistImages(`<!doctype html><html><head></head><body><div id="shot">${`<img src="${inline}">`.repeat(occurrences)}</div></body></html>`, SECRET, jti);
  return { jti, html, blobs, inputs, request: { jti, job: { kind: 'shot', ...SHOT, html }, blobs, inputs } as RenderRequest };
}

describe('signed requests', () => {
  it('runs a correctly signed job', async () => {
    const { launch } = fakeBrowser();
    const { url } = await startService({ launch });
    expect((await post(url, shotRequest())).status).toBe(200);
  });

  it('refuses a missing, forged, tampered or expired signature, before touching the browser', async () => {
    const { launch, calls } = fakeBrowser();
    const { url } = await startService({ launch });
    expect((await post(url, shotRequest(), { token: null })).status).toBe(401);
    expect((await post(url, shotRequest(), { secret: 'another-secret-that-is-long-enough-to-try' })).status).toBe(401);
    expect((await post(url, shotRequest(), { token: 'garbage' })).status).toBe(401);
    const request = shotRequest();
    expect((await post(url, request, { body: Buffer.from(JSON.stringify(shotRequest('<b>other</b>'))) })).status).toBe(401);
    expect((await post(url, shotRequest(), { now: Date.now() - 10 * 60_000 })).status).toBe(401);
    expect(calls.launches).toHaveLength(0);
  });

  it('accepts a token once: the replay is refused and renders nothing', async () => {
    const { launch, calls } = fakeBrowser();
    const { url } = await startService({ launch });
    const request = shotRequest();
    const token = signRequest(SECRET, request.jti, Buffer.from(JSON.stringify(request)));
    expect((await post(url, request, { token })).status).toBe(200);
    const replay = await post(url, request, { token });
    expect(replay.status).toBe(409);
    expect(calls.html).toHaveLength(1);
  });

  it('refuses an input whose URL is not signed for this job', async () => {
    const { launch, calls } = fakeBrowser();
    const { url } = await startService({ launch });
    const first = signedImagePage(PNG_1PX);
    const forged = { ...first.request, inputs: [{ ...first.inputs[0]!, url: `${INPUT_ORIGIN}/${first.jti}/0/forged` }] };
    expect((await post(url, forged)).status).toBe(401);
    const second = signedImagePage(PNG_1PX);
    const stolen = { ...second.request, inputs: [{ ...second.inputs[0]!, url: inputUrl(SECRET, randomUUID(), 0, 'image/png', sha256(second.blobs[0]!)) }] };
    expect((await post(url, stolen)).status).toBe(401);
    expect(calls.html).toHaveLength(0);
  });

  it('serves a signed input once; a second fetch of the same URL is blocked', async () => {
    const seen: FakeRoute[] = [];
    let wanted = '';
    const { launch } = fakeBrowser((_html, request) => {
      seen.push(request(wanted), request(wanted));
    });
    const { url } = await startService({ launch });
    const { request, inputs } = signedImagePage(PNG_1PX);
    wanted = inputs[0]!.url;
    expect((await post(url, request)).status).toBe(200);
    expect(seen.map((s) => s.result)).toEqual(['fulfilled', 'aborted']);
    expect(seen[0]!.body!.equals(PNG_1PX)).toBe(true);
  });

  it('gives each occurrence of an image its own one-use URL while the bytes travel once', () => {
    const { blobs, inputs, html } = signedImagePage(PNG_1PX, 'image/png', 3);
    expect(blobs).toHaveLength(1);
    expect(new Set(inputs.map((i) => i.url)).size).toBe(3);
    expect(html).not.toContain('data:image');
  });
});

describe('request interception', () => {
  it('blocks every URL that is not a signed input, including the 3D hosts for a job without 3D', async () => {
    const seen: FakeRoute[] = [];
    const { launch } = fakeBrowser((_html, request) => {
      for (const u of ['https://example.com/x.png', 'http://169.254.169.254/latest/meta-data/', `${INPUT_ORIGIN}/guess/0/nope`, 'https://esm.sh/three@0.170.0']) seen.push(request(u));
    });
    const { url } = await startService({ launch });
    expect((await post(url, shotRequest())).status).toBe(200);
    expect(seen.map((s) => s.result)).toEqual(['aborted', 'aborted', 'aborted', 'aborted']);
  });

  it('turns JavaScript on only for a job that really contains a 3D scene', async () => {
    const { launch, calls } = fakeBrowser();
    const { url } = await startService({ launch });
    await post(url, shotRequest());
    await post(url, shotRequest(SHOT.html, {}, { scene3d: true })); // claims 3D, has none
    await post(url, shotRequest('<head></head><div class="rk-3d"></div>', {}, { scene3d: true }));
    expect(calls.contexts.map((c) => c.javaScriptEnabled)).toEqual([false, false, true]);
  });
});

describe('timeouts and restarts', () => {
  it('answers 504 at the deadline, kills the browser, and recovers for the next job', async () => {
    let hang = true;
    const { launch, calls } = fakeBrowser(() => (hang ? new Promise<void>(() => undefined) : undefined));
    const { url } = await startService({ launch, timeoutMs: 60 });
    expect((await post(url, shotRequest())).status).toBe(504);
    expect(calls.closes).toBe(1);
    hang = false;
    expect((await post(url, shotRequest())).status).toBe(200);
    expect(calls.launches).toHaveLength(2);
  });

  it('restarts the browser after the configured number of jobs (default 200)', async () => {
    const { launch, calls } = fakeBrowser();
    const { url } = await startService({ launch, restartAfter: 2 });
    for (let i = 0; i < 5; i++) expect((await post(url, shotRequest())).status).toBe(200);
    expect(calls.launches).toHaveLength(3);
  });

  it('runs jobs one at a time, and refuses work past a short queue', async () => {
    let active = 0, most = 0;
    const { launch } = fakeBrowser(async () => {
      most = Math.max(most, ++active);
      await new Promise((r) => setTimeout(r, 25));
      active--;
    });
    const { url } = await startService({ launch });
    const answers = await Promise.all(Array.from({ length: 7 }, () => post(url, shotRequest())));
    expect(most).toBe(1);
    expect(answers.filter((a) => a.status === 429).length).toBeGreaterThan(0);
    expect(answers.filter((a) => a.status === 200).length).toBeGreaterThan(0);
  });
});

describe('sandbox', () => {
  it('launches with the sandbox on, with no flag disabling it', async () => {
    const { launch, calls } = fakeBrowser();
    const { service } = await startService({ launch });
    await service.ready();
    expect(calls.launches[0]!.sandbox).toBe(true);
    expect(calls.launches[0]!.args).not.toContain('--no-sandbox');
    expect(service.stats.sandbox).toBe(true);
  });

  it('fails closed when the sandbox cannot start, unless the operator opted in', async () => {
    const refuse = (inner: Launch): Launch => (o) => (o.sandbox ? Promise.reject(new Error('no usable sandbox')) : inner(o));
    const closed = fakeBrowser();
    const a = await startService({ launch: refuse(closed.launch) });
    await expect(a.service.ready()).rejects.toThrow(/RENDER_ALLOW_NO_SANDBOX/);

    const opted = fakeBrowser();
    const b = await startService({ launch: refuse(opted.launch), allowNoSandbox: true });
    await b.service.ready();
    expect(b.service.stats.sandbox).toBe(false);
    // without the sandbox no browser outlives a job, whatever restartAfter says
    await post(b.url, shotRequest());
    await post(b.url, shotRequest());
    expect(opted.calls.launches.filter((l) => !l.sandbox).length).toBeGreaterThanOrEqual(2);
  });
});

describe('upload limits', () => {
  it('reads the true type from the bytes', () => {
    expect(sniffMime(PNG_1PX)).toBe('image/png');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffMime(Buffer.from('<?xml version="1.0"?><!-- c --><svg width="1" height="1"></svg>'))).toBe('image/svg+xml');
    expect(sniffMime(Buffer.from('<html><script>alert(1)</script></html>'))).toBeUndefined();
  });

  it('refuses a file whose bytes do not match its label', async () => {
    expect(() => checkImage(PNG_1PX, 'image/jpeg')).toThrow(/does not match/);
    const { launch, calls } = fakeBrowser();
    const { url } = await startService({ launch });
    const mislabeled = await post(url, editRequest(PNG_1PX, 'image/jpeg'));
    expect(mislabeled.status).toBe(415);
    const html = await post(url, editRequest(Buffer.from('<html>not an image</html>'), 'image/png'));
    expect(html.status).toBe(415);
    const asInput = await post(url, signedImagePage(Buffer.from('<html>nope</html>')).request);
    expect(asInput.status).toBe(415);
    expect(calls.launches).toHaveLength(0);
  });

  it('refuses more than 40 megapixels from the header, before any decode', async () => {
    expect(MAX_PIXELS).toBe(40_000_000);
    expect(checkImage(pngHeader(8000, 5000), 'image/png')).toEqual({ w: 8000, h: 5000 });
    expect(() => checkImage(pngHeader(8000, 5001), 'image/png')).toThrow(/megapixels/);
    const { launch, calls } = fakeBrowser();
    const { url } = await startService({ launch });
    expect((await post(url, editRequest(pngHeader(50_000, 50_000), 'image/png'))).status).toBe(413);
    expect((await post(url, signedImagePage(pngHeader(50_000, 50_000)).request)).status).toBe(413);
    expect(calls.launches).toHaveLength(0);
  });

  it('checks images left inline in the page too, whatever their case or parameters', async () => {
    const big = pngHeader(50_000, 50_000).toString('base64');
    expect(() => checkInlineImages(`<img src="DATA:IMAGE/PNG;charset=x;BASE64,${big}">`)).toThrow(/megapixels/);
    const { launch, calls } = fakeBrowser();
    const { url } = await startService({ launch });
    expect((await post(url, shotRequest(`<div id="shot"><img src="data:image/png;charset=x;base64,${big}"></div>`))).status).toBe(413);
    expect(calls.launches).toHaveLength(0);
  });

  it('takes an SVG size from its root tag, so stroke-width or a nested element cannot understate it', () => {
    expect(() => checkImage(Buffer.from('<svg stroke-width="1" height="10000" width="10000"><rect width="1" height="1"/></svg>'), 'image/svg+xml')).toThrow(/megapixels/);
    expect(() => checkImage(Buffer.from('<svg viewBox="0 0 10000 10000"><rect width="1" height="1"/></svg>'), 'image/svg+xml')).toThrow(/megapixels/);
  });
});

describe('credentials', () => {
  it('will not put Chromium in a process holding database credentials', () => {
    expect(() => createRenderer({ DB_OWNER_PASSWORD: 'x' })).toThrow(/database credentials/);
    expect(() => createRenderer({ DATABASE_URL: 'postgres://x' })).toThrow(/database credentials/);
    expect(createRenderer({})).toBeDefined();
    expect(createRenderer({ RENDER_SERVICE_URL: 'http://render:4500', RENDER_SIGNING_SECRET: SECRET, DB_OWNER_PASSWORD: 'x' })).toBeDefined();
    expect(() => createRenderer({ RENDER_SERVICE_URL: 'http://render:4500' })).toThrow(/RENDER_SIGNING_SECRET/);
  });

  it('keeps secrets out of Chromium\'s environment in both adapters', async () => {
    expect(browserEnv({ PATH: '/bin', DB_OWNER_PASSWORD: 'x', AWS_REGION: 'y', RENDER_SIGNING_SECRET: 'z', MY_API_TOKEN: 't' })).toEqual({ PATH: '/bin' });
    const { launch, calls } = fakeBrowser();
    const { service } = await startService({ launch });
    vi.stubEnv('DB_OWNER_PASSWORD', 'hunter2');
    try {
      await service.ready();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(JSON.stringify(calls.launches[0]!.env)).not.toContain('hunter2');
  });

  it('the service refuses to start beside database or AWS credentials', () => {
    expect(forbiddenEnv({ DB_OWNER_PASSWORD: 'x', AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2', DATABASE_URL: 'y', S3_BUCKET: 'b', PATH: '/bin', AWS_REGION: 'r' }).sort()).toEqual(['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'DATABASE_URL', 'DB_OWNER_PASSWORD', 'S3_BUCKET']);
  });

  it('the service entry point cannot import a database, AWS or app module', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const m of readFileSync(file, 'utf8').matchAll(/from '([^']+)'|import\('([^']+)'\)/g)) {
        const spec = m[1] ?? m[2]!;
        expect(spec, `${file} imports ${spec}`).not.toMatch(/^(pg|@aws-sdk|@electric-sql)|\/app\//);
        if (spec.startsWith('.')) walk(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      }
    };
    walk(join(here, 'main.ts'));
    expect(seen.size).toBeGreaterThan(3);
  });

  it('the render deployment declares no database secret, task role or open egress', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const yaml = readFileSync(join(root, 'deploy/aws/render-service.yaml'), 'utf8');
    const live = yaml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(live).not.toMatch(/DB_|DATABASE|TaskRoleArn/);
    expect(live).toContain('ReadonlyRootFilesystem: true');
    expect(live).not.toMatch(/AssignPublicIp: ENABLED/);
    expect(live).not.toMatch(/CidrIp: 0\.0\.0\.0\/0/);
    const docker = readFileSync(join(root, 'Dockerfile.render'), 'utf8');
    expect(docker).toMatch(/USER node/);
    expect(docker).not.toMatch(/DB_|--no-sandbox/);
    expect(readFileSync(join(root, 'Dockerfile'), 'utf8')).not.toMatch(/install[^\n]*chromium|RANGOLI_BROWSER_PATH/);
  });
});

const hasBrowser = await (async () => {
  if (process.env.RANGOLI_BROWSER_PATH) return true;
  const { chromium } = await import('playwright-core');
  for (const channel of ['msedge', 'chrome']) {
    try {
      await (await chromium.launch({ channel, headless: true })).close();
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
})();

describe.runIf(hasBrowser)('with a real browser', () => {
  let service: ReturnType<typeof createRenderService>;
  let url: string;
  const local = inProcessRenderer();

  beforeAll(async () => {
    service = createRenderService({ secret: SECRET, log: () => undefined });
    url = await service.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await service.close();
    await local.close();
  }, 60_000); // Edge can take seconds to close while the rest of the suite is running

  const remote = () => remoteRenderer({ url, secret: SECRET });

  const imageDoc = () => {
    const doc = createDocument();
    doc.apply([{ op: 'setAsset', id: 'a1b2c3d4e5f6', meta: { id: 'a1b2c3d4e5f6', name: 'hero.png', file: 'a1b2c3d4e5f6.png', mime: 'image/png', w: 1, h: 1, bytes: PNG_1PX.length, source: 'upload', time: 0 } }]);
    applyRdl(doc, 'Card col gap4 p6 fill:surface name:"card"\n  Text "Same pixels"\n  Image asset:hero.png w120 h80\n  Text body-sm "from either adapter"');
    return doc;
  };
  const assetUrl = () => `data:image/png;base64,${PNG_1PX.toString('base64')}`;

  it('launches with Chromium\'s sandbox on', async () => {
    await service.ready();
    expect(service.stats.sandbox).toBe(true);
  });

  it('both adapters return identical PNG bytes for a simple render with an image', async () => {
    vi.stubEnv('RANGOLI_RENDERER', 'in-process');
    await closeRenderer();
    let inProcess: Buffer;
    try {
      inProcess = await renderPng(imageDoc(), { assetUrl });
    } finally {
      vi.unstubAllEnvs();
      await closeShots();
    }
    vi.stubEnv('RENDER_SERVICE_URL', url);
    vi.stubEnv('RENDER_SIGNING_SECRET', SECRET);
    let hosted: Buffer;
    try {
      hosted = await renderPng(imageDoc(), { assetUrl });
    } finally {
      vi.unstubAllEnvs();
      await closeRenderer();
    }
    expect(sniffMime(hosted)).toBe('image/png');
    expect(inProcess.length).toBeGreaterThan(200);
    expect(hosted.equals(inProcess)).toBe(true);
  }, 60_000);

  it('both adapters agree on a filmstrip and a transparent 2x capture with JavaScript off', async () => {
    const strip: ShotJob = {
      html: '<!doctype html><html><head><style>@keyframes a{from{opacity:0}to{opacity:1}}[data-rid]{animation:a 1s linear both;width:80px;height:40px;background:#c33}.cell{margin:0}.crop{overflow:hidden}.inner{width:max-content}#strip{display:inline-flex;gap:8px}</style></head><body><div id="strip"><figure class="cell"><div class="crop"><div class="inner"><div data-rid="n1"></div></div></div></figure><figure class="cell"><div class="crop"><div class="inner"><div data-rid="n1"></div></div></div></figure></div></body></html>',
      viewport: { width: 800, height: 400 }, scale: 1, selector: '#strip', prepare: { kind: 'filmstrip', times: [0, 500], tracks: [{ id: 'n1', at: 0 }], exit: false },
    };
    // a frozen frame depends on how long the animation ran before it was paused, so bytes vary run to run in either adapter
    expect(probe(await remote().shot(strip), 'image/png')).toEqual(probe(await local.shot(strip), 'image/png'));
    const compose: ShotJob = { html: '<!doctype html><html><head></head><body style="margin:0;background:transparent"><div id="c" style="display:inline-block"><div style="width:30px;height:20px;background:#0a7"></div></div></body></html>', viewport: { width: 400, height: 300 }, scale: 2, selector: '#c > *', omitBackground: true, prepare: { kind: 'decodeImages' } };
    expect((await remote().shot(compose)).equals(await local.shot(compose))).toBe(true);
  }, 60_000);

  it('both adapters return identical image edits, decoded with JavaScript off', async () => {
    const job = { image: PNG_1PX, mime: 'image/png', ops: [{ op: 'resize' as const, w: 8 }], format: 'png' as const, quality: 80 };
    const [a, b] = [await remote().edit(job), await local.edit(job)];
    expect(a.w).toBe(8);
    expect(a.buf.equals(b.buf)).toBe(true);
  }, 60_000);

  it('page JavaScript does not run in an ordinary job', async () => {
    const plain = '<!doctype html><html><head></head><body><div id="shot" style="width:40px;height:40px;background:#fff"></div>';
    const scripted = `${plain}<script>document.getElementById('shot').style.background='#f00'</script>`;
    const [a, b] = [await remote().shot({ ...SHOT, html: plain }), await remote().shot({ ...SHOT, html: scripted })];
    expect(a.equals(b)).toBe(true);
  }, 60_000);

  describe('egress', () => {
    let target: Server;
    let hits = 0;
    let base = '';

    beforeAll(async () => {
      target = createServer((_req, res) => { hits++; res.writeHead(204); res.end(); });
      target.on('upgrade', (_req, socket) => { hits++; socket.destroy(); });
      await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
      base = `127.0.0.1:${(target.address() as AddressInfo).port}`;
    });

    afterAll(() => new Promise((r) => target.close(r)));

    /** JS on (via a 3D marker), reaching out every way a page can. */
    const leaky = () => ({
      ...SHOT,
      scene3d: true,
      html: `<!doctype html><html><head><link rel="stylesheet" href="http://${base}/css"><style>body{background:url(http://${base}/bg.png)}</style></head><body><div id="shot" class="rk-3d" data-ready="1" data-scene="[]"><img src="http://${base}/img"><iframe src="http://${base}/frame"></iframe></div>
<script>
fetch('http://${base}/fetch').catch(()=>{});
new Image().src='http://${base}/image';
try{new WebSocket('ws://${base}/ws')}catch(e){}
navigator.sendBeacon('http://${base}/beacon','x');
window.open('http://${base}/popup');
try{const p=new XMLHttpRequest();p.open('GET','http://${base}/xhr');p.send()}catch(e){}
</script></body></html>`,
    });

    it('the leaky page really does reach out when nothing blocks it (control)', async () => {
      hits = 0;
      await local.shot(leaky());
      await new Promise((r) => setTimeout(r, 400));
      expect(hits).toBeGreaterThan(2);
    }, 60_000);

    it('the render service lets none of it out, with JavaScript on', async () => {
      hits = 0;
      const blockedBefore = service.stats.blocked;
      await remote().shot(leaky());
      await new Promise((r) => setTimeout(r, 400));
      expect(hits).toBe(0);
      expect(service.stats.blocked).toBeGreaterThan(blockedBefore);
    }, 60_000);

    it('a meta refresh cannot navigate the page out either', async () => {
      hits = 0;
      // the blocked navigation leaves an error page, so failing the job is the expected result
      await remote().shot({ ...SHOT, html: `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=http://${base}/go"></head><body><div id="shot">x</div></body></html>` }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      expect(hits).toBe(0);
    }, 60_000);
  });

  it('3D scenes draw under the egress policy, from the bundled three.js', async () => {
    const doc = createDocument();
    applyRdl(doc, '@Scene3D w200 h120 objects="box color=#c33"');
    const blockedBefore = service.stats.blocked;
    vi.stubEnv('RENDER_SERVICE_URL', url);
    vi.stubEnv('RENDER_SIGNING_SECRET', SECRET);
    const started = Date.now();
    try {
      const png = await renderPng(doc);
      expect(sniffMime(png)).toBe('image/png');
    } finally {
      vi.unstubAllEnvs();
      await closeRenderer();
    }
    expect(service.stats.blocked).toBe(blockedBefore); // nothing it asked for was missing
    expect(Date.now() - started).toBeLessThan(14_000); // drew, rather than waiting out the 15 s poster fallback
  }, 60_000);

  it('a page that hangs the browser is cut off at the deadline, and the next job works', async () => {
    const quick = createRenderService({ secret: SECRET, log: () => undefined, timeoutMs: 8000 });
    const quickUrl = await quick.listen(0, '127.0.0.1');
    try {
      const client = remoteRenderer({ url: quickUrl, secret: SECRET });
      await expect(client.shot({ ...SHOT, scene3d: true, html: '<!doctype html><html><head></head><body><div id="shot" class="rk-3d"></div><script>for(;;);</script></body></html>' })).rejects.toThrow(/504/);
      expect(sniffMime(await client.shot(SHOT))).toBe('image/png');
    } finally {
      await quick.close();
    }
  }, 60_000);

  it('editImage refuses a bomb through the whole path', async () => {
    vi.stubEnv('RENDER_SERVICE_URL', url);
    vi.stubEnv('RENDER_SIGNING_SECRET', SECRET);
    try {
      await expect(editImage(pngHeader(50_000, 50_000), 'image/png', [], 'png')).rejects.toThrow(/413/);
    } finally {
      vi.unstubAllEnvs();
      await closeRenderer();
    }
  }, 60_000);
});

it('real-browser tests ran here (fails only if this machine lost its browser)', () => {
  expect(hasBrowser || !existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')).toBe(true);
});
