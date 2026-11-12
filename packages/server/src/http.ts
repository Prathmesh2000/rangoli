import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_PROXY_PREFIX, assetProxy } from './asset-proxy.js';
import { cleanName, createDesignRoutes } from './design-routes.js';
import { writeLock } from './lock.js';
import type { Role, Session } from './session.js';

/** Built editor bundle (packages/editor/dist), served at /editor/ */
const EDITOR_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../editor/dist');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };

/**
 * The editor page on a person's own machine. Tighter than no policy but looser than the hosted one, and each
 * looser part is a working local feature. Run is a srcdoc frame, which inherits this policy, so inline <script>
 * elements (and esm.sh, for its 3D) stay allowed; markup injected into the editor cannot start those, and inline
 * event handlers, the way such markup does run, are refused. https: covers images, fonts and 3D models a design
 * links to, and Google's stylesheet is for canvas and Run pages that still link it directly.
 */
export const LOCAL_EDITOR_CSP = "default-src 'self'; script-src 'self'; script-src-elem 'self' 'unsafe-inline' https://esm.sh; script-src-attr 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https:; media-src 'self' blob: https:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface PreviewServer {
  url: string;
  server: Server;
  /** LAN base URLs when sharing is enabled */
  lanUrls: string[];
  close(): Promise<void>;
}

export interface PreviewOptions {
  port?: number;
  /** listen on all interfaces so teammates on the network can join with invite links */
  share?: boolean;
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export async function startPreview(session: Session, portOrOpts: number | PreviewOptions = 4400, legacyHost?: string): Promise<PreviewServer> {
  const opts: PreviewOptions = typeof portOrOpts === 'number' ? { port: portOrOpts } : portOrOpts;
  const host = opts.share ? '0.0.0.0' : legacyHost ?? '127.0.0.1';
  const lan = opts.share ? lanAddresses() : [];
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', ...lan]);

  let baseUrl = '';
  const routes = createDesignRoutes(session, { baseUrl: () => baseUrl, lan });

  const server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const deny = (status: number, msg: string) => res.writeHead(status, { 'content-type': 'text/plain' }).end(msg);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const hostName = (req.headers.host ?? '').replace(/:\d+$/, '');

      // ---------------- who is this? ----------------
      // Loopback = the owner's own machine. Everyone else needs an invite token (cookie or ?t=).
      let role: Role | null = null;
      const loopback = LOOPBACK.has(req.socket.remoteAddress ?? '');
      if (loopback) {
        // DNS-rebinding guard: a hostile page in the owner's browser would arrive with a foreign Host header
        if (!allowedHosts.has(hostName)) return deny(403, 'Forbidden host');
        role = 'owner';
      } else {
        const qt = url.searchParams.get('t');
        const token = qt ?? cookie(req, 'rangoli_t');
        role = token ? session.shareTokens.get(token) ?? null : null;
        if (!role) return deny(401, 'This Rangoli session needs an invite link.');
        if (qt) res.setHeader('set-cookie', `rangoli_t=${encodeURIComponent(qt)}; HttpOnly; SameSite=Strict; Path=/`);
      }
      const name = cleanName(req.headers['x-rangoli-name']) || (role === 'owner' ? '' : role);

      // ---------------- static: editor ----------------
      if (url.pathname === '/editor' || url.pathname.startsWith('/editor/')) {
        if (!existsSync(EDITOR_DIR)) return deny(503, 'Editor not built. Run: npm run build -w @rangoli/editor');
        let rel = url.pathname.replace(/^\/editor\/?/, '') || 'index.html';
        const file = normalize(join(EDITOR_DIR, rel));
        if (!file.startsWith(EDITOR_DIR)) return deny(403, 'Forbidden');
        rel = existsSync(file) ? file : join(EDITOR_DIR, 'index.html'); // SPA fallback
        res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream', 'cache-control': rel.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable', 'content-security-policy': LOCAL_EDITOR_CSP });
        return void res.end(await readFile(rel));
      }

      if (url.pathname.startsWith(`${ASSET_PROXY_PREFIX}/`)) return await assetProxy.handle(req, res, url, loopback ? 'owner' : `guest:${req.socket.remoteAddress}`);

      if (!(await routes.handle(req, res, url, { role, name }))) deny(404, 'Not found');
    } catch (e) {
      if (!res.headersSent) json(500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  const actualPort = await new Promise<number>((resolveP, reject) => {
    const tryListen = (p: number, attempts: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempts > 0) tryListen(p + 1, attempts - 1);
        else reject(err);
      });
      server.listen(p, host, () => resolveP(p));
    };
    tryListen(opts.port ?? 4400, 20);
  });
  baseUrl = `http://127.0.0.1:${actualPort}/`;
  const releaseLock = writeLock(session.dir, baseUrl);

  return {
    url: `http://127.0.0.1:${actualPort}/`,
    lanUrls: lan.map((a) => `http://${a}:${actualPort}/`),
    server,
    close: () =>
      new Promise((r) => {
        routes.close();
        releaseLock();
        server.close(() => r());
      }),
  };
}
