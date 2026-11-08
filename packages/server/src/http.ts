import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { applyRdl, defaultTokens, formatLint, lint, prototypeHtml, renderDocument, serializeRdl, type ChangeEntry, type EditOp, type ImageFormat, type Severity } from '@rangoli/engine';
import { composeImage, editImage, placeholder } from './imaging.js';
import { writeLock } from './lock.js';
import { createMcpServer } from './mcp.js';
import { PREVIEW_CLIENT } from './preview-client.js';
import type { AgentMode, Role, Session } from './session.js';

/** Built editor bundle (packages/editor/dist), served at /editor/ */
const EDITOR_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../editor/dist');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };

const RANK: Record<Role, number> = { viewer: 0, reviewer: 1, editor: 2, owner: 3 };
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

const MIME_IMG: Record<string, string> = { png: 'image/png', webp: 'image/webp', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' };
/** Safe display/file name: letters, digits, space . _ - only. */
const cleanFile = (s: unknown) => (typeof s === 'string' ? s.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 80) : '');

const cleanName = (s: unknown) => (typeof s === 'string' ? s.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 32) : '');

export async function startPreview(session: Session, portOrOpts: number | PreviewOptions = 4400, legacyHost?: string): Promise<PreviewServer> {
  const opts: PreviewOptions = typeof portOrOpts === 'number' ? { port: portOrOpts } : portOrOpts;
  const host = opts.share ? '0.0.0.0' : legacyHost ?? '127.0.0.1';
  const lan = opts.share ? lanAddresses() : [];
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', ...lan]);

  // ---------------- server-sent events ----------------
  const clients = new Set<ServerResponse>();
  const send = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(payload);
  };
  const onSaved = () => send('change', Date.now()); // preview page reloads after save
  const onDoc = (e: ChangeEntry) => send('doc', { seq: e.seq, author: e.author, label: e.label ?? null, touched: e.touched, time: e.time });
  const onSelection = (ids: string[]) => send('selection', ids);
  const onReviews = () => send('reviews', Date.now());
  const onPresence = (list: unknown) => send('presence', list);
  const onMode = (m: AgentMode) => send('mode', m);
  session.on('saved', onSaved);
  session.on('change', onDoc);
  session.on('selection', onSelection);
  session.on('reviews', onReviews);
  session.on('presence', onPresence);
  session.on('mode', onMode);

  const readBody = (req: IncomingMessage, limit = 2e6) =>
    new Promise<string>((res, rej) => {
      let b = '';
      req.on('data', (c: Buffer) => {
        b += c;
        if (b.length > limit) {
          rej(new Error('Request body too large'));
          req.destroy();
        }
      });
      req.on('end', () => res(b));
      req.on('error', rej);
    });

  // ---------------- MCP over HTTP (agents attach to THIS process; no second writer) ----------------
  let baseUrl = '';
  const mcpSessions = new Map<string, StreamableHTTPServerTransport>();
  const handleMcp = async (req: IncomingMessage, res: ServerResponse, body: unknown) => {
    const sid = req.headers['mcp-session-id'];
    let transport = typeof sid === 'string' ? mcpSessions.get(sid) : undefined;
    if (!transport) {
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid MCP session' }, id: null }));
        return;
      }
      const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          mcpSessions.set(id, t);
          session.touchPresence({ clientId: `agent:${id}`, name: 'Agent', role: 'agent', selection: [] });
        },
      });
      t.onclose = () => {
        if (t.sessionId) {
          mcpSessions.delete(t.sessionId);
          session.dropPresence(`agent:${t.sessionId}`);
        }
      };
      await createMcpServer(session, { previewUrl: baseUrl, author: 'agent' }).connect(t);
      transport = t;
    }
    await transport.handleRequest(req as IncomingMessage & { auth?: undefined }, res, body);
  };

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
      const can = (min: Role) => RANK[role!] >= RANK[min];
      const name = cleanName(req.headers['x-rangoli-name']) || (role === 'owner' ? '' : role);
      const author = name ? `human:${name}` : 'human';

      // ---------------- MCP endpoint: owner machine only ----------------
      if (url.pathname === '/mcp') {
        if (role !== 'owner') return deny(403, 'MCP is only available on the machine that runs Rangoli');
        if (req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.origin)) return deny(403, 'Cross-origin MCP rejected');
        const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || 'null') : undefined;
        return void (await handleMcp(req, res, body));
      }

      // ---------------- CSRF: writes must be same-origin JSON ----------------
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        const ctype = req.headers['content-type'] ?? '';
        let originOk = true;
        if (origin) {
          try {
            originOk = new URL(origin).host === req.headers.host;
          } catch {
            originOk = false;
          }
        }
        if (!originOk || !ctype.startsWith('application/json')) return deny(403, 'Cross-origin or non-JSON write rejected');
      }
      const body = async <T>(limit?: number) => JSON.parse((await readBody(req, limit)) || '{}') as T;
      let m0: RegExpExecArray | null;

      // ---------------- assets & images ----------------
      if (req.method === 'GET' && (m0 = /^\/assets\/([a-f0-9]{12}\.(png|webp|jpeg|gif|svg|avif))$/.exec(url.pathname))) {
        const file = join(session.dir, 'assets', m0[1]!);
        if (!existsSync(file)) return deny(404, 'Not found');
        res.writeHead(200, {
          'content-type': MIME_IMG[m0[2]!] ?? 'application/octet-stream',
          'cache-control': 'public, max-age=31536000, immutable', // content-addressed: never changes
          // uploaded SVGs must never run script if opened directly
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          'x-content-type-options': 'nosniff',
        });
        return void res.end(await readFile(file));
      }
      if (url.pathname.startsWith('/api/assets') && req.method === 'POST') {
        if (!can('editor')) return json(403, { error: 'Only editors can change assets' });
        try {
          if (url.pathname === '/api/assets') {
            const b = await body<{ name?: string; dataUrl?: string; alt?: string }>(22e6);
            const mm = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(b.dataUrl ?? '');
            if (!mm) return json(400, { error: 'dataUrl must be a base64 image data URL' });
            const meta = await session.addAsset(Buffer.from(mm[2]!, 'base64'), mm[1]!, cleanFile(b.name) || 'image', { source: 'upload', alt: b.alt }, author);
            return json(200, meta);
          }
          if ((m0 = /^\/api\/assets\/([a-f0-9]{12})\/(edit|meta|delete|placeholder)$/.exec(url.pathname))) {
            const meta = session.doc.data.assets?.[m0[1]!];
            if (!meta) return json(404, { error: 'Asset not found' });
            if (m0[2] === 'delete') {
              session.doc.apply([{ op: 'setAsset', id: meta.id, meta: null }], { author, label: `delete asset ${meta.name}` });
              return json(200, { ok: true });
            }
            if (m0[2] === 'meta') {
              const b = await body<{ name?: string; alt?: string }>();
              session.doc.apply([{ op: 'setAsset', id: meta.id, meta: { ...meta, ...(b.name ? { name: cleanFile(b.name) } : {}), ...(b.alt !== undefined ? { alt: String(b.alt).slice(0, 300) } : {}) } }], { author, label: `asset ${meta.name}` });
              return json(200, session.doc.data.assets![meta.id]);
            }
            if (m0[2] === 'placeholder') {
              const ph = await placeholder(await session.readAsset(meta), meta.mime);
              session.doc.apply([{ op: 'setAsset', id: meta.id, meta: { ...meta, placeholder: ph } }], { author, label: `placeholder ${meta.name}` });
              return json(200, { placeholder: ph });
            }
            const b = await body<{ ops?: EditOp[]; format?: ImageFormat; quality?: number; name?: string }>();
            const format = b.format ?? 'webp';
            const r = await editImage(await session.readAsset(meta), meta.mime, b.ops ?? [], format, b.quality ?? 82);
            const out = await session.addAsset(r.buf, `image/${format}`, cleanFile(b.name) || `${meta.name.replace(/\.\w+$/, '')}-edit.${format}`, { source: 'edit', from: meta.id, ops: b.ops ?? [], format, quality: b.quality ?? 82, alt: meta.alt }, author);
            return json(200, out);
          }
        } catch (e) {
          return json(400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if ((m0 = /^\/api\/compose\/([0-9a-z]+)(\/save)?$/.exec(url.pathname))) {
        const q = url.searchParams;
        const save = !!m0[2];
        if (save && (req.method !== 'POST' || !can('editor'))) return json(403, { error: 'Only editors can save compositions' });
        try {
          const b = save ? await body<{ format?: ImageFormat; scale?: number; name?: string }>() : {};
          const format = (b.format ?? q.get('format') ?? 'png') as ImageFormat;
          const scale = Math.min(3, Math.max(1, Number(b.scale ?? q.get('scale') ?? 2)));
          if (!['png', 'webp', 'jpeg'].includes(format)) return json(400, { error: 'format must be png, webp or jpeg' });
          const r = await composeImage(session.doc, m0[1]!, format, scale, session.assetDataUri);
          const frameName = session.doc.findNode(m0[1]!)?.node.name ?? m0[1]!;
          if (!save) {
            res.writeHead(200, { 'content-type': `image/${format}`, 'content-disposition': `inline; filename="${cleanFile(frameName)}@${scale}x.${format}"`, 'cache-control': 'no-store' });
            return void res.end(r.buf);
          }
          const meta = await session.addAsset(r.buf, `image/${format}`, cleanFile(b.name) || `${cleanFile(frameName)}@${scale}x.${format}`, { source: 'compose', from: m0[1]!, format, scale }, author);
          return json(200, meta);
        } catch (e) {
          return json(400, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // ---------------- read API ----------------
      if (url.pathname === '/api/doc' && req.method === 'GET') {
        const h = session.doc.historyEntries;
        return json(200, {
          data: session.doc.data,
          dir: role === 'owner' ? session.dir : '',
          seq: h.at(-1)?.seq ?? 0,
          history: h.slice(-50).map((e) => ({ seq: e.seq, author: e.author, label: e.label ?? null, time: e.time, touched: e.touched.length })),
          selection: session.selection,
          role,
          agentMode: session.agentMode,
          presence: session.presenceList(),
        });
      }
      if (url.pathname === '/api/reviews' && req.method === 'GET') return json(200, session.reviews);
      if (url.pathname === '/api/lint' && req.method === 'GET') return json(200, lint(session.doc));
      let m: RegExpExecArray | null;
      if ((m = /^\/api\/versions\/(v\d+)$/.exec(url.pathname)) && req.method === 'GET') return json(200, await session.loadVersion(m[1]!));

      // ---------------- presence (everyone) ----------------
      if (url.pathname === '/api/presence' && req.method === 'POST') {
        const b = await body<{ clientId?: string; name?: string; selection?: unknown }>();
        if (typeof b.clientId !== 'string' || b.clientId.length > 64) return json(400, { error: 'clientId required' });
        const sel = Array.isArray(b.selection) ? b.selection.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
        session.touchPresence({ clientId: b.clientId, name: cleanName(b.name) || role, role, selection: sel });
        return json(200, { ok: true });
      }
      if (url.pathname === '/select' && req.method === 'POST') {
        const b = await body<{ ids?: unknown }>();
        session.setSelection(Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string' && !!session.doc.findNode(x)) : []);
        return void res.writeHead(204).end();
      }

      // ---------------- comments (reviewer+) ----------------
      if (url.pathname.startsWith('/api/threads') && req.method === 'POST') {
        if (!can('reviewer')) return json(403, { error: 'Viewers cannot comment' });
        if (url.pathname === '/api/threads') {
          const b = await body<{ node?: string | null; body?: string; kind?: 'comment' | 'review'; severity?: Severity; fix?: string; title?: string }>();
          if (!b.body?.trim()) return json(400, { error: 'body required' });
          return json(200, session.addThread({ node: b.node ?? null, author, body: b.body.trim(), kind: b.kind, severity: b.severity, fix: b.fix, title: b.title }));
        }
        if ((m = /^\/api\/threads\/(t\d+)\/(reply|resolve)$/.exec(url.pathname))) {
          const b = await body<{ body?: string; resolved?: boolean }>();
          if (m[2] === 'reply') {
            if (!b.body?.trim()) return json(400, { error: 'body required' });
            return json(200, session.reply(m[1]!, author, b.body.trim()));
          }
          return json(200, session.resolveThread(m[1]!, b.resolved !== false));
        }
      }

      // ---------------- suggestions: reviewers may propose, editors decide ----------------
      if (url.pathname === '/api/changesets' && req.method === 'POST') {
        if (!can('reviewer')) return json(403, { error: 'Viewers cannot suggest' });
        const b = await body<{ script?: string; label?: string }>();
        if (!b.script?.trim()) return json(400, { error: 'script required' });
        return json(200, session.addChangeset({ author, label: b.label?.slice(0, 120) || 'suggestion', script: b.script }));
      }
      if ((m = /^\/api\/changesets\/(cs\d+)\/(accept|reject)$/.exec(url.pathname)) && req.method === 'POST') {
        if (!can('editor')) return json(403, { error: 'Only editors can accept or reject suggestions' });
        try {
          return json(200, session.decideChangeset(m[1]!, m[2] as 'accept' | 'reject', author));
        } catch (e) {
          return json(409, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // ---------------- editing (editor+) ----------------
      if (req.method === 'POST' && ['/api/rdl', '/api/undo', '/api/redo', '/api/tokens/brand', '/api/versions'].includes(url.pathname) && !can('editor')) {
        return json(403, { error: `Your role (${role}) cannot edit. Suggest a change or comment instead.` });
      }
      if (url.pathname === '/api/rdl' && req.method === 'POST') {
        const b = await body<{ script?: string; label?: string; parent?: string }>();
        if (typeof b.script !== 'string') return json(400, { error: 'script required' });
        try {
          const r = applyRdl(session.doc, b.script, { author, label: b.label, parent: b.parent });
          return json(200, { created: r.created, touched: r.touched });
        } catch (e) {
          return json(400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if ((url.pathname === '/api/undo' || url.pathname === '/api/redo') && req.method === 'POST') {
        const e = url.pathname === '/api/undo' ? session.doc.undo() : session.doc.redo();
        return json(200, { ok: !!e, seq: e?.seq ?? null, label: e?.label ?? null });
      }
      if (url.pathname === '/api/tokens/brand' && req.method === 'POST') {
        const b = await body<{ brand?: string }>();
        if (!b.brand || !/^#[0-9a-fA-F]{6}$/.test(b.brand)) return json(400, { error: 'brand must be #rrggbb' });
        session.doc.apply([{ op: 'setTokens', tokens: defaultTokens({ brand: b.brand }) }], { author, label: `brand ${b.brand}` });
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/versions' && req.method === 'POST') {
        const b = await body<{ name?: string }>();
        return json(200, await session.saveVersion(cleanName(b.name) || `Version ${session.reviews.versions.length + 1}`, author));
      }

      // ---------------- owner only ----------------
      if (url.pathname === '/api/share' && req.method === 'GET') {
        if (!can('owner')) return json(403, { error: 'Only the owner can see invite links' });
        const bases = lan.map((a) => `http://${a}:${(req.headers.host ?? '').split(':')[1] ?? ''}/editor/`);
        const links = [...session.shareTokens].map(([token, r]) => ({ role: r, urls: bases.map((b) => `${b}?t=${token}`) }));
        return json(200, { sharing: !!opts.share, links });
      }
      if (url.pathname === '/api/mode' && req.method === 'POST') {
        if (!can('owner')) return json(403, { error: 'Only the owner can change agent mode' });
        const b = await body<{ mode?: AgentMode }>();
        if (b.mode !== 'direct' && b.mode !== 'suggest') return json(400, { error: 'mode must be direct or suggest' });
        session.setAgentMode(b.mode);
        return json(200, { mode: b.mode });
      }

      // ---------------- live events ----------------
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        const clientId = url.searchParams.get('client');
        if (clientId && clientId.length <= 64) session.touchPresence({ clientId, name: cleanName(url.searchParams.get('name')) || role, role, selection: [] });
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
          if (clientId) session.dropPresence(clientId);
        });
        return;
      }

      // ---------------- static: editor ----------------
      if (url.pathname === '/editor' || url.pathname.startsWith('/editor/')) {
        if (!existsSync(EDITOR_DIR)) return deny(503, 'Editor not built. Run: npm run build -w @rangoli/editor');
        let rel = url.pathname.replace(/^\/editor\/?/, '') || 'index.html';
        const file = normalize(join(EDITOR_DIR, rel));
        if (!file.startsWith(EDITOR_DIR)) return deny(403, 'Forbidden');
        rel = existsSync(file) ? file : join(EDITOR_DIR, 'index.html'); // SPA fallback
        res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream', 'cache-control': rel.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable' });
        return void res.end(await readFile(rel));
      }

      // ---------------- preview ----------------
      if (req.method === 'GET' && url.pathname === '/') {
        const page = renderDocument(session.doc, { editorAttrs: true, mode: url.searchParams.get('mode') ?? 'light', assetBase: '/assets/' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return void res.end(page.replace('</body>', `${PREVIEW_CLIENT}\n</body>`));
      }
      if (req.method === 'GET' && (url.pathname === '/play' || url.pathname === '/play/')) {
        const html = prototypeHtml(session.doc, { start: url.searchParams.get('start') ?? undefined, mode: url.searchParams.get('mode') ?? undefined, liveReload: true, assetBase: '/assets/' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return void res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/rdl') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return void res.end(serializeRdl(session.doc));
      }
      if (req.method === 'GET' && url.pathname === '/lint') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return void res.end(formatLint(lint(session.doc)));
      }
      deny(404, 'Not found');
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
        session.off('saved', onSaved);
        session.off('change', onDoc);
        session.off('selection', onSelection);
        session.off('reviews', onReviews);
        session.off('presence', onPresence);
        session.off('mode', onMode);
        releaseLock();
        for (const t of mcpSessions.values()) void t.close();
        for (const c of clients) c.end();
        server.close(() => r());
      }),
  };
}
