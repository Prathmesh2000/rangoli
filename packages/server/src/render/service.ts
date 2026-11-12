/**
 * The render service: runs untrusted designs in Chromium, away from the app.
 * It holds one secret (to check requests) and no database or AWS credentials.
 * One job at a time, so a job never shares a live browser with another tenant's page.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { THREE_FONT, THREE_VERSION, validateOps, type EditOp, type ImageFormat } from '@rangoli/engine';
import { EDIT_PAGE_OPTIONS, pageOptions, Refused, runEdit, runShot, type Page } from './execute.js';
import { checkImage, checkInlineImages, MAX_PIXELS } from './limits.js';
import type { ShotJob } from './port.js';
import { inputUrl, MAX_BODY_BYTES, RenderRequest, sha256, SpentTokens, verifyRequest } from './protocol.js';

type Route = {
  request(): { url(): string };
  fulfill(o: { status: number; contentType: string; body: Buffer; headers?: Record<string, string> }): Promise<void>;
  abort(code?: string): Promise<void>;
};
type Context = {
  route(url: RegExp, handler: (r: Route) => unknown): Promise<void>;
  routeWebSocket(url: RegExp, handler: (ws: { close(): Promise<void> | void }) => unknown): Promise<void>;
  newPage(): Promise<Page>;
  close(): Promise<void>;
};
export type ServiceBrowser = { newContext(o: object): Promise<Context>; close(): Promise<void>; on?(event: 'disconnected', fn: () => void): void };
export type Launch = (o: { sandbox: boolean; args: string[]; env: Record<string, string> }) => Promise<ServiceBrowser>;

export interface ServiceOptions {
  secret: string;
  allowNoSandbox?: boolean;
  timeoutMs?: number;
  restartAfter?: number;
  launch?: Launch;
  log?: (message: string) => void;
}

const MAX_QUEUE = 4;

/** Network paths request interception cannot see are closed at the browser level too. */
const BROWSER_ARGS = [
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-extensions',
  '--no-first-run',
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
  '--host-resolver-rules=MAP * ~NOTFOUND',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  // tasks have no GPU; 3D scenes need the software WebGL renderer
  '--enable-unsafe-swiftshader',
];

/** Chromium inherits this environment and nothing else. */
function chromiumEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'COMSPEC', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'];
  return Object.fromEntries(keep.flatMap((k) => (env[k] === undefined ? [] : [[k, env[k]!]])));
}

/** Names that must never be present where this service runs. */
export function forbiddenEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter((k) => /^(DB_|DATABASE_URL$|APP_DATABASE_URL$|AWS_ACCESS_KEY_ID$|AWS_SECRET_ACCESS_KEY$|AWS_SESSION_TOKEN$|AWS_CONTAINER_CREDENTIALS_|AWS_WEB_IDENTITY_TOKEN_FILE$|S3_|SES_)/.test(k));
}

const defaultLaunch: Launch = async ({ sandbox, args, env }) => {
  const { chromium } = (await import('playwright-core')) as unknown as { chromium: { launch(o: object): Promise<ServiceBrowser> } };
  const base = { headless: true, chromiumSandbox: sandbox, args, env, timeout: 30_000 };
  if (process.env.RANGOLI_BROWSER_PATH) return chromium.launch({ ...base, executablePath: process.env.RANGOLI_BROWSER_PATH });
  let failure: unknown = new Error('No browser found');
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ ...base, channel });
    } catch (e) {
      failure = e;
    }
  }
  throw failure;
};

let threeRoot: string | null | undefined;
function vendoredThree(url: string): { body: Buffer; contentType: string } | undefined {
  const esm = `https://esm.sh/three@${THREE_VERSION}`;
  let file: string | undefined;
  if (url === esm) file = 'build/three.module.js';
  else if (url === THREE_FONT) file = 'examples/fonts/helvetiker_bold.typeface.json';
  else if (url.startsWith(`${esm}/examples/jsm/`) && /^[\w/.-]+\.js$/.test(url.slice(esm.length + 1)) && !url.includes('..')) file = url.slice(esm.length + 1);
  if (!file) return undefined;
  if (threeRoot === undefined) {
    try {
      threeRoot = join(dirname(createRequire(import.meta.url).resolve('three')), '..');
    } catch {
      threeRoot = null;
    }
  }
  if (!threeRoot) return undefined;
  try {
    return { body: readFileSync(join(threeRoot, file)), contentType: file.endsWith('.json') ? 'application/json' : 'text/javascript' };
  } catch {
    return undefined;
  }
}

class JobTimeout extends Error {}

export function createRenderService(options: ServiceOptions) {
  const { secret } = options;
  const log = options.log ?? ((m: string) => console.error(m));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const restartAfter = options.restartAfter ?? 200;
  const launchBrowser = options.launch ?? defaultLaunch;
  const spent = new SpentTokens();
  const stats = { jobs: 0, launches: 0, blocked: 0, sandbox: false };
  let browser: Promise<ServiceBrowser> | null = null;
  let sinceLaunch = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;

  const launch = async (): Promise<ServiceBrowser> => {
    const env = chromiumEnv();
    let b: ServiceBrowser;
    try {
      b = await launchBrowser({ sandbox: true, args: BROWSER_ARGS, env });
      stats.sandbox = true;
    } catch (e) {
      if (!options.allowNoSandbox) throw new Error(`Chromium's sandbox is unavailable and RENDER_ALLOW_NO_SANDBOX is not set: ${(e as Error).message}`);
      log('render: Chromium sandbox unavailable; running without it and restarting the browser after every job');
      b = await launchBrowser({ sandbox: false, args: BROWSER_ARGS, env });
      stats.sandbox = false;
    }
    stats.launches++;
    sinceLaunch = 0;
    b.on?.('disconnected', () => {
      if (current === b) browser = null;
    });
    current = b;
    return b;
  };
  let current: ServiceBrowser | undefined;

  const getBrowser = () => {
    browser ??= launch();
    browser.catch(() => (browser = null));
    return browser;
  };

  /** Bounded, because a hung renderer can stall a graceful close. */
  const stopBrowser = async () => {
    const running = browser;
    browser = null;
    if (running) await Promise.race([running.then((b) => b.close()).catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]);
  };

  const run = async <T>(contextOptions: object, serve: (c: Context) => Promise<void>, work: (p: Page) => Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const b = await getBrowser(); // starting Chromium is our cost, not the job's
    const job = (async () => {
      const context = await b.newContext({ ...contextOptions, serviceWorkers: 'block', acceptDownloads: false });
      try {
        await serve(context);
        await context.routeWebSocket(/.*/, (ws) => ws.close());
        return await work(await context.newPage());
      } finally {
        await context.close().catch(() => undefined);
      }
    })();
    job.catch(() => undefined); // a late failure after the timeout has nobody left to hear it
    try {
      return await Promise.race([job, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new JobTimeout()), timeoutMs); })]);
    } catch (e) {
      if (e instanceof JobTimeout) await stopBrowser();
      throw e;
    } finally {
      clearTimeout(timer);
      stats.jobs++;
      if (++sinceLaunch >= (stats.sandbox ? restartAfter : 1)) await stopBrowser();
    }
  };

  async function shot(req: RenderRequest, job: Extract<RenderRequest['job'], { kind: 'shot' }>): Promise<{ png: string }> {
    const allowed = new Map<string, { body: Buffer; mime: string }>();
    req.inputs.forEach((input, n) => {
      const b64 = req.blobs[input.blob];
      if (b64 === undefined) throw new Refused(400, 'Input points at no data');
      if (input.url !== inputUrl(secret, req.jti, n, input.mime, sha256(b64))) throw new Refused(401, 'Bad input signature');
      const body = Buffer.from(b64, 'base64');
      checkImage(body, input.mime);
      allowed.set(input.url, { body, mime: input.mime });
    });
    checkInlineImages(job.html);
    const scene3d = job.scene3d === true && job.html.includes('rk-3d');
    const html = scene3d ? job.html.replace(/<head>/i, `<head><script type="importmap">{"imports":{"three":"https://esm.sh/three@${THREE_VERSION}"}}</script>`) : job.html;
    const shotJob: ShotJob = { ...job, html, scene3d };

    const serve = (context: Context) =>
      context.route(/.*/, (route) => {
        const url = route.request().url();
        const input = allowed.get(url);
        if (input) {
          allowed.delete(url); // one use
          return route.fulfill({ status: 200, contentType: input.mime, body: input.body, headers: { 'access-control-allow-origin': '*' } });
        }
        const three = scene3d ? vendoredThree(url) : undefined;
        if (three) return route.fulfill({ status: 200, contentType: three.contentType, body: three.body, headers: { 'access-control-allow-origin': '*' } });
        stats.blocked++;
        return route.abort('blockedbyclient');
      });

    const png = await run({ ...pageOptions(shotJob), javaScriptEnabled: scene3d }, serve, (p) => runShot(p, shotJob, { maxPixels: MAX_PIXELS }));
    return { png: png.toString('base64') };
  }

  async function edit(job: Extract<RenderRequest['job'], { kind: 'edit' }>): Promise<{ image: string; w: number; h: number }> {
    const image = Buffer.from(job.image, 'base64');
    const size = checkImage(image, job.mime);
    const ops = job.ops as unknown as EditOp[];
    try {
      validateOps(ops, size.w, size.h);
    } catch (e) {
      throw new Refused(400, (e as Error).message);
    }
    const serve = (context: Context) =>
      context.route(/.*/, (route) => {
        stats.blocked++;
        return route.abort('blockedbyclient');
      });
    const r = await run({ ...EDIT_PAGE_OPTIONS, javaScriptEnabled: false }, serve, (p) => runEdit(p, { image, mime: job.mime, ops, format: job.format as ImageFormat, quality: job.quality }));
    return { image: r.buf.toString('base64'), w: r.w, h: r.h };
  }

  const readBody = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Refused(413, 'Request too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  const answer = (res: ServerResponse, status: number, body: object | string) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store' });
    res.end(text);
  };

  async function render(req: IncomingMessage): Promise<object> {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw new Refused(401, 'Missing signature');
    const raw = await readBody(req);
    let claims;
    try {
      claims = verifyRequest(secret, token, raw);
    } catch (e) {
      throw e instanceof Refused ? e : new Refused(401, 'Bad signature');
    }
    if (queued >= MAX_QUEUE) throw new Refused(429, 'The render service is busy');
    if (!spent.use(claims.jti, claims.exp)) throw new Refused(409, 'This request was already used');
    const parsed = RenderRequest.safeParse(JSON.parse(raw.toString()));
    if (!parsed.success || parsed.data.jti !== claims.jti) throw new Refused(400, 'Malformed job');
    const request = parsed.data;
    queued++;
    const next = tail.then<object>(() => (request.job.kind === 'shot' ? shot(request, request.job) : edit(request.job)));
    tail = next.catch(() => undefined);
    try {
      return await next;
    } finally {
      queued--;
    }
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/healthz') return answer(res, 200, { ok: true, sandbox: stats.sandbox, jobs: stats.jobs });
    if (req.method !== 'POST' || path !== '/v1/render') return answer(res, 404, 'Not found');
    render(req).then(
      (out) => answer(res, 200, out),
      (e: unknown) => {
        if (e instanceof Refused) return answer(res, e.status, e.message);
        if (e instanceof JobTimeout) return answer(res, 504, `The render took longer than ${timeoutMs / 1000} seconds`);
        log(`render: job failed: ${(e as Error).message}`);
        answer(res, 500, 'The render failed');
      },
    );
  });

  return {
    server,
    stats,
    /** Launches the browser, so a sandbox failure stops the service at startup. */
    ready: () => getBrowser().then(() => undefined),
    listen: (port: number, host: string) =>
      new Promise<string>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(`http://${host}:${(server.address() as AddressInfo).port}`));
      }),
    close: async () => {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
      await stopBrowser();
    },
  };
}
