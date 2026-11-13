import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { applyRdl, applySkin, asSkin, capabilitiesOf, wireframeSpecHtml, type ProjectCapability, formatLint, languageOf, languageTokens, lint, prototypeHtml, renderDocument, serializeRdl, type ChangeEntry, type EditOp, type ImageFormat, type Severity } from '@rangoli/engine';
import { composeImage, editImage, placeholder } from './imaging.js';
import { createMcpServer, type McpOptions } from './mcp.js';
import { handleStateless, isStatelessRequest, serverTarget, type StatelessTarget } from './mcp-stateless.js';
import { INSTRUCTIONS } from './guide.js';
import { statusSentence, type ConnectionView } from './design/agent-platform.js';
import { PREVIEW_CLIENT } from './preview-client.js';
import type { AgentMode, Role, Session } from './session.js';

/**
 * What each local session role may do, as capabilities (packages/engine/src/capabilities.ts). The machine owner
 * leads; share links hand out designer, reviewer or viewer. Hosted projects pass their own capabilities instead.
 */
const LOCAL_CAPABILITIES: Record<Role, readonly ProjectCapability[]> = {
  owner: capabilitiesOf({ projectRole: 'lead' }) as ProjectCapability[],
  editor: capabilitiesOf({ projectRole: 'designer' }) as ProjectCapability[],
  reviewer: capabilitiesOf({ projectRole: 'reviewer' }) as ProjectCapability[],
  viewer: capabilitiesOf({ projectRole: 'viewer' }) as ProjectCapability[],
};

/**
 * A write a browser could have been made to send from another site: cross-site by the browser's own account
 * (Sec-Fetch-Site), from another origin, or not JSON (which a plain form or a no-CORS fetch cannot send).
 * Reads are not writes. Every route of a design that changes something sits behind this.
 */
export const crossSiteWrite = (req: IncomingMessage): boolean => {
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== req.headers.host) return true;
    } catch {
      return true;
    }
  }
  return !(req.headers['content-type'] ?? '').startsWith('application/json');
};
const MIME_IMG: Record<string, string> = { glb: 'model/gltf-binary', png: 'image/png', webp: 'image/webp', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' };
/**
 * Rendered designs are other people's content. A sandboxed page gets an opaque origin,
 * so nothing in it can call the app with the viewer's session.
 */
const HOSTED_PAGE = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': 'sandbox allow-scripts', 'x-content-type-options': 'nosniff', 'x-rangoli-approval': 'Unapproved' };
/**
 * Everything the design plane renders is the working copy, never an approved version, so in a team project it says so:
 * the same header and meta tag as /api/projects/:p/export.html (app/snapshots/render.ts), and a visible line on the
 * printable spec. Approved output comes only from snapshots.
 */
const UNAPPROVED_META = '<meta name="rangoli-approval" content="unapproved">';
const UNAPPROVED_BANNER = '<p class="rangoli-unapproved" role="note" style="margin:0;padding:10px 24px;background:#fff4e5;color:#7a4100;font:600 14px system-ui,sans-serif;border-bottom:1px solid #f0c48a">Unapproved: this is the working copy, not an approved version.</p>';
const markUnapproved = (html: string, banner = false): string => {
  const withMeta = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${UNAPPROVED_META}`) : `${UNAPPROVED_META}${html}`;
  return banner ? withMeta.replace(/<body[^>]*>/i, (m) => `${m}${UNAPPROVED_BANNER}`) : withMeta;
};

/** Safe display/file name: letters, digits, space . _ - only. */
const cleanFile = (s: unknown) => (typeof s === 'string' ? s.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 80) : '');
export const cleanName = (s: unknown) => (typeof s === 'string' ? s.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 32) : '');

/** Who is making this request, already authenticated by whichever server mounted these routes. */
export interface DesignAccess {
  /** for display and presence; decisions use `can` */
  role: Role;
  /** what this person may do here; derived from `role` when absent (local sessions) */
  can?: readonly ProjectCapability[];
  /** display name for attribution */
  name: string;
  /** the account name is authoritative; ignore names sent by the client */
  fixedName?: boolean;
  userId?: string;
  /** authenticated with an API token rather than a browser session */
  viaToken?: boolean;
  /** which API token, when viaToken is set */
  tokenId?: string;
  /** why editing is refused right now, shown in the editor */
  lockReason?: string | null;
  /** re-checked on long-lived connections */
  stillAllowed?: () => Promise<boolean>;
}

export interface DesignRouteOptions {
  /** absolute URL of this document for agents (file mode) */
  baseUrl?: () => string;
  lan?: string[];
  hosted?: boolean;
  mcpOptions?: (access: DesignAccess) => McpOptions;
  /** the project's agent connections, for the connect flow (hosted projects) */
  connections?: (access: DesignAccess) => Promise<ConnectionView[]>;
  /** routes only some deployments have (hosted: agent tokens, page import modes); true when one answered */
  extraRoutes?: (req: IncomingMessage, res: ServerResponse, url: URL, access: DesignAccess, json: (status: number, body: unknown) => void | Promise<void>) => Promise<boolean>;
}

export interface DesignRoutes {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, access: DesignAccess): Promise<boolean>;
  broadcast(event: string, data: unknown): void;
  /** open browser streams and agent sessions */
  connections(): number;
  /** this document's tools for one stateless call by this agent (the organization endpoint forwards here) */
  mcpTarget(access: DesignAccess): Promise<StatelessTarget & { close(): Promise<void> }>;
  close(): void;
}

/** Everything one open document serves: editor API, live events, preview, prototype and MCP. */
export function createDesignRoutes(session: Session, opts: DesignRouteOptions = {}): DesignRoutes {
  const baseUrl = () => opts.baseUrl?.() ?? '';
  // ---------------- server-sent events ----------------
  const clients = new Set<ServerResponse>();
  const send = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(payload);
  };
  const onSaved = () => send('change', Date.now()); // preview page reloads after save
  // with the log on, an edit carries its ops so a client can apply it without refetching the whole document
  const onDoc = (e: ChangeEntry) => send('doc', {
    seq: e.seq, author: e.author, label: e.label ?? null, touched: e.touched, time: e.time,
    ...(session.logEnabled && e.ops.length < 200 ? { ops: e.ops, inverse: e.inverse, undoOf: e.undoOf, redoOf: e.redoOf, noHistory: e.noHistory } : {}),
  });
  const onSelection = (ids: string[]) => send('selection', ids);
  const onReviews = () => send('reviews', Date.now());
  const onPresence = (list: unknown) => send('presence', list);
  const onMode = (m: AgentMode) => send('mode', m);
  const onAgents = () => send('agents', Date.now());
  session.on('agents', onAgents);
  session.on('saved', onSaved);
  session.on('change', onDoc);
  session.on('selection', onSelection);
  session.on('reviews', onReviews);
  session.on('presence', onPresence);
  session.on('mode', onMode);

  const readBody = (req: IncomingMessage, limit = 2e6) =>
    new Promise<string>((res, rej) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          rej(new Error('Request body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      // decoded only once whole: a chunk can end in the middle of a multi-byte character
      req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
      req.on('error', rej);
    });

  // ---------------- MCP over HTTP (agents attach to THIS process; no second writer) ----------------
  const mcpSessions = new Map<string, StreamableHTTPServerTransport>();
  const mcpOwners = new Map<string, string | undefined>();
  /** The tool wrapper every agent connection gets: the host's checks, then durability when the log is on. */
  const mcpFor = (access: DesignAccess): McpOptions => {
    const mcp = opts.mcpOptions?.(access) ?? { previewUrl: baseUrl(), author: 'agent' };
    // with the log on, a tool only reports success once its changes are durable
    const inner = mcp.wrap ?? ((_tool: string, run: () => Promise<unknown>) => run());
    const wrap: McpOptions['wrap'] = session.logEnabled
      ? (tool, run) => inner(tool, async () => {
          const out = await run();
          try {
            await session.durable();
          } catch {
            return { content: [{ type: 'text' as const, text: 'Error: that change could not be saved and was rolled back. Try again.' }], isError: true };
          }
          return out;
        })
      : mcp.wrap;
    return { ...mcp, wrap };
  };

  const mcpTarget = (access: DesignAccess) => serverTarget(() => createMcpServer(session, mcpFor(access)), { name: 'rangoli', version: '0.1.0' }, INSTRUCTIONS);

  const handleMcp = async (req: IncomingMessage, res: ServerResponse, body: unknown, access: DesignAccess) => {
    // 2026-07-28 clients (and any request without a session): every call stands alone
    if (isStatelessRequest(req, body)) {
      const target = await mcpTarget(access);
      try {
        session.touchPresence({ clientId: `agent:${access.tokenId ?? access.userId ?? 'local'}`, name: 'Agent', role: 'agent', selection: [] });
        return await handleStateless(req, res, body, target);
      } finally {
        await target.close();
      }
    }
    const sid = req.headers['mcp-session-id'];
    let transport = typeof sid === 'string' ? mcpSessions.get(sid) : undefined;
    // an MCP session belongs to whoever opened it; a guessed id cannot be reused by someone else
    if (transport && typeof sid === 'string' && mcpOwners.get(sid) !== access.userId) {
      res.writeHead(403).end();
      return;
    }
    if (!transport) {
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid MCP session' }, id: null }));
        return;
      }
      const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          mcpSessions.set(id, t);
          mcpOwners.set(id, access.userId);
          session.touchPresence({ clientId: `agent:${id}`, name: 'Agent', role: 'agent', selection: [] });
        },
      });
      t.onclose = () => {
        if (t.sessionId) {
          mcpSessions.delete(t.sessionId);
          mcpOwners.delete(t.sessionId);
          session.dropPresence(`agent:${t.sessionId}`);
        }
      };
      await createMcpServer(session, mcpFor(access)).connect(t);
      transport = t;
    }
    await transport.handleRequest(req as IncomingMessage & { auth?: undefined }, res, body);
  };


  /** Resolves true when it answered the request, false when the path is not one of its routes. */
  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL, access: DesignAccess): Promise<unknown> => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    // an edit is acknowledged only once it is durable; a commit that fails is rolled back and reported here
    const json = (status: number, body: unknown): void | Promise<void> => {
      if (!session.logEnabled || req.method === 'GET' || status >= 400) return reply(status, body);
      return session.durable().then(
        () => reply(status, body),
        () => reply(503, { error: 'That change could not be saved and was rolled back. Try again.' }),
      );
    };
    const deny = (status: number, msg: string) => res.writeHead(status, { 'content-type': 'text/plain' }).end(msg);
    const role = access.role;
    const granted = new Set<ProjectCapability>(access.can ?? LOCAL_CAPABILITIES[role]);
    const can = (capability: ProjectCapability) => granted.has(capability);
    const name = access.name;
    const author = name ? `human:${name}` : 'human';
      // ---------------- MCP endpoint: owner machine only ----------------
      if (url.pathname === '/mcp') {
        if (!opts.mcpOptions) {
          // 'owner' here is the person at the machine running Rangoli, not a project role
          if (role !== 'owner') return deny(403, 'MCP is only available on the machine that runs Rangoli');
          if (req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.origin)) return deny(403, 'Cross-origin MCP rejected');
        } else if (!access.viaToken) {
          return deny(401, 'MCP needs an access token (Authorization: Bearer)');
        }
        const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || 'null') : undefined;
        return void (await handleMcp(req, res, body, access));
      }

      // ---------------- CSRF: writes must be same-origin JSON ----------------
      if (crossSiteWrite(req)) return deny(403, 'Cross-origin or non-JSON write rejected');
      const body = async <T>(limit?: number) => JSON.parse((await readBody(req, limit)) || '{}') as T;
      let m0: RegExpExecArray | null;

      // ---------------- assets & images ----------------
      if (req.method === 'GET' && (m0 = /^\/assets\/([a-f0-9]{12}\.(png|webp|jpeg|gif|svg|avif|glb))$/.exec(url.pathname))) {
        const bytes = await session.store.readAssetFile(m0[1]!);
        if (!bytes) return deny(404, 'Not found');
        res.writeHead(200, {
          'content-type': MIME_IMG[m0[2]!] ?? 'application/octet-stream',
          // 3D loaders use fetch; the sandboxed Run view has a null origin
          ...(m0[2] === 'glb' && !opts.hosted ? { 'access-control-allow-origin': 'null' } : {}),
          // content-addressed, so it never changes; private when access depends on who is asking
          'cache-control': `${opts.hosted ? 'private' : 'public'}, max-age=31536000, immutable`,
          // uploaded SVGs must never run script if opened directly
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          'x-content-type-options': 'nosniff',
        });
        return void res.end(bytes);
      }
      if (url.pathname.startsWith('/api/assets') && req.method === 'POST') {
        if (!can('design.edit')) return json(403, { error: 'Only people who can edit the design can change assets' });
        try {
          if (url.pathname === '/api/assets') {
            const b = await body<{ name?: string; dataUrl?: string; alt?: string }>(22e6);
            const mm = /^data:(image\/[\w+.-]+|model\/gltf-binary);base64,(.+)$/.exec(b.dataUrl ?? '');
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
        if (save && (req.method !== 'POST' || !can('design.edit'))) return json(403, { error: 'Only people who can edit the design can save compositions' });
        try {
          const b = save ? await body<{ format?: ImageFormat; scale?: number; name?: string }>() : {};
          const format = (b.format ?? q.get('format') ?? 'png') as ImageFormat;
          const scale = Math.min(3, Math.max(1, Number(b.scale ?? q.get('scale') ?? 2)));
          if (!['png', 'webp', 'jpeg'].includes(format)) return json(400, { error: 'format must be png, webp or jpeg' });
          await session.store.warmAssets?.();
          const r = await composeImage(session.doc, m0[1]!, format, scale, session.assetDataUri);
          const frameName = session.doc.findNode(m0[1]!)?.node.name ?? m0[1]!;
          if (!save) {
            res.writeHead(200, { 'content-type': `image/${format}`, 'content-disposition': `inline; filename="${cleanFile(frameName)}@${scale}x.${format}"`, 'cache-control': 'no-store', ...(opts.hosted ? { 'x-rangoli-approval': 'Unapproved' } : {}) });
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
        const pageParam = url.searchParams.get('page');
        let data = session.doc.data;
        let loadedPages: string[] | null = null;
        // per-page loading: other pages travel as empty stubs and are fetched from /api/pages when opened
        if (session.logEnabled && pageParam) {
          const wanted = pageParam === 'active' ? session.doc.defaultPageId : pageParam;
          if (!Object.hasOwn(data.pages, wanted)) return json(404, { error: 'Page not found' });
          loadedPages = [wanted];
          data = { ...data, pages: Object.fromEntries(Object.entries(data.pages).map(([id, p]) => [id, id === wanted ? p : { id: p.id, name: p.name, children: [], nodes: {} }])) };
        }
        return json(200, {
          data,
          loadedPages,
          dir: role === 'owner' ? session.dir : '',
          seq: session.doc.headSeq,
          history: h.slice(-50).map((e) => ({ seq: e.seq, author: e.author, label: e.label ?? null, time: e.time, touched: e.touched.length })),
          selection: session.selection,
          role,
          can: [...granted],
          agentMode: session.agentMode,
          presence: session.presenceList(),
          locked: access.lockReason ?? null,
        });
      }
      if ((m0 = /^\/api\/pages\/([\w-]+)$/.exec(url.pathname)) && req.method === 'GET') {
        const page = Object.hasOwn(session.doc.data.pages, m0[1]!) ? session.doc.data.pages[m0[1]!] : undefined;
        return page ? json(200, { page, seq: session.doc.headSeq }) : json(404, { error: 'Page not found' });
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
        session.touchPresence({ clientId: b.clientId, name: access.fixedName ? name : cleanName(b.name) || role, role, selection: sel });
        return json(200, { ok: true });
      }
      if (url.pathname === '/select' && req.method === 'POST') {
        const b = await body<{ ids?: unknown }>();
        session.setSelection(Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string' && !!session.doc.findNode(x)) : []);
        return void res.writeHead(204).end();
      }

      // ---------------- comments (reviewer+) ----------------
      if (url.pathname.startsWith('/api/threads') && req.method === 'POST') {
        if (!can('comment')) return json(403, { error: 'Your role can view this design but not comment on it' });
        if (url.pathname === '/api/threads') {
          const b = await body<{ node?: string | null; body?: string; kind?: 'comment' | 'review' | 'annotation'; severity?: Severity; fix?: string; title?: string }>();
          if (!b.body?.trim()) return json(400, { error: 'body required' });
          if (b.kind === 'annotation' && !can('design.edit')) return json(403, { error: 'Only people who can edit the design can annotate it' });
          if (b.kind === 'annotation' && !b.node) return json(400, { error: 'An annotation needs a layer' });
          return json(200, session.addThread({ node: b.node ?? null, author, body: b.body.trim(), kind: b.kind, severity: b.severity, fix: b.fix, title: b.title }));
        }
        if ((m = /^\/api\/threads\/(t\d+)\/(reply|resolve)$/.exec(url.pathname))) {
          const b = await body<{ body?: string; resolved?: boolean }>();
          if (session.thread(m[1]!).kind === 'annotation' && !can('design.edit')) return json(403, { error: 'Only people who can edit the design can change annotations' });
          if (m[2] === 'reply') {
            if (!b.body?.trim()) return json(400, { error: 'body required' });
            return json(200, session.reply(m[1]!, author, b.body.trim()));
          }
          return json(200, session.resolveThread(m[1]!, b.resolved !== false));
        }
      }

      // ---------------- live cursors: broadcast only, nothing is stored ----------------
      if (url.pathname === '/api/cursor' && req.method === 'POST') {
        const b = await body<{ clientId?: string; x?: number; y?: number; leave?: boolean }>();
        if (typeof b.clientId !== 'string' || b.clientId.length > 64) return json(400, { error: 'clientId required' });
        if (b.leave) send('cursor', { clientId: b.clientId, leave: true });
        else if (Number.isFinite(b.x) && Number.isFinite(b.y)) send('cursor', { clientId: b.clientId, name: name || role, x: b.x, y: b.y });
        return void res.writeHead(204).end();
      }

      // ---------------- notes and tasks for agents, runs, connections ----------------
      if (url.pathname === '/api/agents' && req.method === 'GET') {
        const [tasks, runs, waiting, connections] = await Promise.all([session.platform.listTasks(), session.platform.listRuns(50), session.platform.waitingCount(), opts.connections?.(access) ?? Promise.resolve([])]);
        const now = Date.now();
        return json(200, {
          tasks: tasks.map((t) => ({ ...t, sentence: statusSentence(t, now) })),
          runs,
          waiting,
          connections,
          // honest about what Rangoli can do: it cannot start an agent
          canStartAgent: false,
          connected: connections.some((c) => c.state === 'connected') || session.presenceList().some((p) => p.role === 'agent'),
        });
      }
      if (url.pathname === '/api/tasks' && req.method === 'POST') {
        if (!can('task.create')) return json(403, { error: 'Your role cannot leave notes or tasks for agents' });
        const b = await body<{ kind?: string; body?: string; node?: string; page?: string }>();
        const text = typeof b.body === 'string' ? b.body.trim().slice(0, 8000) : '';
        if (b.kind !== 'note' && b.kind !== 'task') return json(400, { error: 'kind must be note or task' });
        if (!text) return json(400, { error: 'Write what you want the agent to do or know' });
        const node = typeof b.node === 'string' && b.node ? b.node : undefined;
        if (node && !session.doc.findNode(node)) return json(400, { error: `#${node} not found` });
        if (b.kind === 'note' && !node) return json(400, { error: 'A note is pinned to a frame or layer' });
        try {
          const page = node ? session.doc.findNode(node)!.page.id : typeof b.page === 'string' ? b.page : undefined;
          return json(200, await session.createTask({ kind: b.kind, body: text, target: { ...(page ? { page } : {}), ...(node ? { node } : {}) }, authorId: access.userId ?? null, authorName: name || 'Owner' }));
        } catch (e) {
          return json(400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if ((m0 = /^\/api\/tasks\/([\w-]+)\/(requeue|withdraw)$/.exec(url.pathname)) && req.method === 'POST') {
        if (!can('task.create')) return json(403, { error: 'Your role cannot change notes or tasks for agents' });
        try {
          if (m0[2] === 'withdraw') {
            await session.platform.withdrawTask(m0[1]!);
            return json(200, { ok: true });
          }
          return json(200, await session.platform.requeueTask(m0[1]!, { id: access.userId, name }));
        } catch (e) {
          return json(409, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if ((m0 = /^\/api\/runs\/([\w-]+)\/(undo|changes)$/.exec(url.pathname))) {
        const run = await session.platform.getRun(m0[1]!).catch(() => null);
        if (!run) return json(404, { error: 'Run not found' });
        if (m0[2] === 'changes' && req.method === 'GET') {
          const entries = (await session.entriesSince(run.startSeq)).filter((e) => e.runId === run.id);
          return json(200, { run, changes: entries.map((e) => ({ seq: e.seq, label: e.label ?? null, author: e.author, time: e.time, touched: e.touched })) });
        }
        if (m0[2] === 'undo' && req.method === 'POST') {
          // Undo whole run stays with people: a browser session that may edit the design
          if (access.viaToken || !can('design.edit')) return json(403, { error: 'Only people who can edit the design can undo a run' });
          try {
            return json(200, await session.undoRun(run.id, { id: access.userId, name: name || 'Owner', author }));
          } catch (e) {
            return json(409, { error: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      if (opts.extraRoutes && url.pathname.startsWith('/api/') && (await opts.extraRoutes(req, res, url, access, json))) return;

      // the screenshot request from the editor, kept as a task in the same queue
      if (url.pathname === '/api/agent-requests' && req.method === 'POST') {
        if (!can('task.create')) return json(403, { error: 'Your role cannot leave tasks for agents' });
        const b = await body<{ prompt?: string; asset?: string; device?: string }>();
        const prompt = typeof b.prompt === 'string' ? b.prompt.trim().slice(0, 4000) : '';
        const asset = b.asset ? session.doc.data.assets?.[b.asset] : undefined;
        if (b.asset && !asset) return json(400, { error: 'That image was not found' });
        if (!prompt && !asset) return json(400, { error: 'Describe what to build, or attach an image' });
        if (asset && (asset.bytes > 5 * 1024 * 1024 || !/^image\/(png|jpeg|webp|gif)$/.test(asset.mime))) return json(400, { error: 'Use a PNG, JPEG, WebP or GIF under 5 MB' });
        const device = b.device === 'tablet' || b.device === 'mobile' ? b.device : 'desktop';
        return json(200, session.addRequest({ author, prompt, asset: asset?.id, device }));
      }
      if ((m0 = /^\/api\/agent-requests\/(ar\d+)\/cancel$/.exec(url.pathname)) && req.method === 'POST') {
        if (!can('task.create')) return json(403, { error: 'Your role cannot change tasks for agents' });
        try {
          return json(200, await session.cancelRequest(m0[1]!));
        } catch (e) {
          return json(404, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // ---------------- suggestions: reviewers may propose, editors decide ----------------
      if (url.pathname === '/api/changesets' && req.method === 'POST') {
        if (!can('comment')) return json(403, { error: 'Your role can view this design but not suggest changes' });
        const b = await body<{ script?: string; label?: string }>();
        if (!b.script?.trim()) return json(400, { error: 'script required' });
        return json(200, session.addChangeset({ author, label: b.label?.slice(0, 120) || 'suggestion', script: b.script }));
      }
      if ((m = /^\/api\/changesets\/(cs\d+)\/(accept|reject)$/.exec(url.pathname)) && req.method === 'POST') {
        if (!can('suggestion.accept')) return json(403, { error: 'Only people who can edit the design can accept or reject suggestions' });
        try {
          return json(200, session.decideChangeset(m[1]!, m[2] as 'accept' | 'reject', author));
        } catch (e) {
          return json(409, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // ---------------- editing (editor+) ----------------
      if (req.method === 'POST' && ['/api/rdl', '/api/undo', '/api/redo', '/api/tokens/brand', '/api/versions'].includes(url.pathname) && !can('design.edit')) {
        return json(403, { error: `Your role (${role}) cannot edit. Suggest a change or comment instead.` });
      }
      if (url.pathname === '/api/rdl' && req.method === 'POST') {
        const b = await body<{ script?: string; label?: string; parent?: string; page?: unknown }>();
        if (typeof b.script !== 'string') return json(400, { error: 'script required' });
        // the editor sends its active page; only a page that exists in this document is accepted
        if (b.page !== undefined && (typeof b.page !== 'string' || !Object.hasOwn(session.doc.data.pages, b.page))) return json(400, { error: 'Page not found' });
        try {
          const r = applyRdl(session.doc, b.script, { author, label: b.label, parent: b.parent, page: b.page as string | undefined });
          return json(200, { created: r.created, touched: r.touched });
        } catch (e) {
          return json(400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if ((url.pathname === '/api/undo' || url.pathname === '/api/redo') && req.method === 'POST') {
        const e = url.pathname === '/api/undo' ? session.doc.undo() : session.doc.redo();
        return json(200, { ok: !!e, seq: e?.seq ?? null, label: e?.label ?? null, stayed: e?.stayed ?? 0 });
      }
      if (url.pathname === '/api/tokens/brand' && req.method === 'POST') {
        const b = await body<{ brand?: string }>();
        if (!b.brand || !/^#[0-9a-fA-F]{6}$/.test(b.brand)) return json(400, { error: 'brand must be #rrggbb' });
        const lang = languageOf(session.doc.data.tokens);
        session.doc.apply([{ op: 'setTokens', tokens: languageTokens(lang.id, { ...lang.options, brand: b.brand }) }], { author, label: `brand ${b.brand}` });
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/versions' && req.method === 'POST') {
        const b = await body<{ name?: string }>();
        return json(200, await session.saveVersion(cleanName(b.name) || `Version ${session.reviews.versions.length + 1}`, author));
      }

      // ---------------- who works here, and how agents write: the lead's ----------------
      if (url.pathname === '/api/share' && req.method === 'GET') {
        if (!can('members.manage')) return json(403, { error: 'Only the owner can see invite links' });
        const bases = (opts.lan ?? []).map((a) => `http://${a}:${(req.headers.host ?? '').split(':')[1] ?? ''}/editor/`);
        const links = [...session.shareTokens].map(([token, r]) => ({ role: r, urls: bases.map((b) => `${b}?t=${token}`) }));
        return json(200, { sharing: !!opts.lan?.length, links });
      }
      if (url.pathname === '/api/mode' && req.method === 'POST') {
        if (!can('members.manage')) return json(403, { error: 'Only the project lead can change agent mode' });
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
        if (clientId && clientId.length <= 64) session.touchPresence({ clientId, name: access.fixedName ? name : cleanName(url.searchParams.get('name')) || role, role, selection: [] });
        // a removed member's open stream ends at the next ping
        const ping = setInterval(() => {
          res.write(': ping\n\n');
          void access.stillAllowed?.().then((ok) => { if (!ok) res.end(); });
        }, 25000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
          if (clientId) session.dropPresence(clientId);
        });
        return;
      }

      // ---------------- preview ----------------
      if (req.method === 'GET' && url.pathname === '/') {
        if (opts.hosted) {
          await session.store.warmAssets?.();
          res.writeHead(200, { ...HOSTED_PAGE });
          const roots = url.searchParams.getAll('root').filter((id) => session.doc.findNode(id));
          return void res.end(markUnapproved(applySkin(renderDocument(session.doc, { mode: url.searchParams.get('mode') ?? 'light', assetUrl: session.assetDataUri, ...(roots.length ? { roots, padding: 0 } : {}) }), asSkin(url.searchParams.get('skin')), 'body')));
        }
        const page = renderDocument(session.doc, { editorAttrs: true, mode: url.searchParams.get('mode') ?? 'light', assetBase: '/assets/' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return void res.end(page.replace('</body>', `${PREVIEW_CLIENT}\n</body>`));
      }
      if (req.method === 'GET' && (url.pathname === '/play' || url.pathname === '/play/')) {
        if (opts.hosted) {
          await session.store.warmAssets?.();
          res.writeHead(200, { ...HOSTED_PAGE });
          return void res.end(markUnapproved(applySkin(prototypeHtml(session.doc, { start: url.searchParams.get('start') ?? undefined, mode: url.searchParams.get('mode') ?? undefined, assetUrl: session.assetDataUri }), asSkin(url.searchParams.get('skin')), '.rp-viewport')));
        }
        const html = prototypeHtml(session.doc, { start: url.searchParams.get('start') ?? undefined, mode: url.searchParams.get('mode') ?? undefined, liveReload: true, assetBase: '/assets/' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return void res.end(applySkin(html, asSkin(url.searchParams.get('skin')), '.rp-viewport'));
      }
      if (req.method === 'GET' && url.pathname === '/spec') {
        await session.store.warmAssets?.();
        const page = wireframeSpecHtml(session.doc, session.reviews, { skin: asSkin(url.searchParams.get('skin') ?? 'clean'), ...(opts.hosted ? { assetUrl: session.assetDataUri } : { assetBase: '/assets/' }) });
        // print() needs allow-modals; everything else stays as sandboxed as the other rendered pages
        res.writeHead(200, opts.hosted ? { ...HOSTED_PAGE, 'content-security-policy': 'sandbox allow-scripts allow-modals' } : { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return void res.end(opts.hosted ? markUnapproved(page, true) : page);
      }
      if (req.method === 'GET' && url.pathname === '/rdl') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...(opts.hosted ? { 'x-rangoli-approval': 'Unapproved' } : {}) });
        return void res.end(serializeRdl(session.doc));
      }
      if (req.method === 'GET' && url.pathname === '/lint') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return void res.end(formatLint(lint(session.doc)));
      }
      return false;
  };

  return {
    handle: async (req, res, url, access) => (await handle(req, res, url, access)) !== false,
    broadcast: send,
    connections: () => clients.size + mcpSessions.size,
    mcpTarget,
    close: () => {
      session.off('saved', onSaved);
      session.off('change', onDoc);
      session.off('selection', onSelection);
      session.off('reviews', onReviews);
      session.off('presence', onPresence);
      session.off('mode', onMode);
      session.off('agents', onAgents);
      for (const t of mcpSessions.values()) void t.close();
      for (const c of clients) c.end();
    },
  };
}
