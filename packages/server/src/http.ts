import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRdl, defaultTokens, renderDocument, serializeRdl, lint, formatLint, type ChangeEntry } from '@rangoli/engine';
import type { Session } from './session.js';

/** Built editor bundle (packages/editor/dist), served at /editor/ */
const EDITOR_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../editor/dist');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };

const CLIENT = `
<style>
.rangoli-bar{position:fixed;top:12px;right:12px;z-index:2147483647;display:flex;gap:4px;align-items:center;padding:4px;border-radius:8px;
  background:rgba(20,22,26,.86);color:#e8eaed;font:500 12px/1 ui-sans-serif,system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)}
.rangoli-bar button{all:unset;cursor:pointer;padding:6px 10px;border-radius:6px}
.rangoli-bar button:hover{background:rgba(255,255,255,.12)}
.rangoli-bar button[aria-pressed="true"]{background:rgba(255,255,255,.2)}
.rangoli-bar .sel{padding:0 8px;opacity:.75;font-family:ui-monospace,monospace}
.rangoli-bar .dot{width:8px;height:8px;border-radius:50%;background:#3fb950;margin:0 6px}
.rangoli-bar .dot.off{background:#d29922}
[data-rid].rangoli-selected{outline:2px solid #2f81f7!important;outline-offset:1px}
[data-rid].rangoli-hover{outline:1px dashed #2f81f7!important;outline-offset:1px}
</style>
<div class="rangoli-bar" role="toolbar" aria-label="Rangoli preview">
  <span class="dot" title="live"></span>
  <button data-mode="light">Light</button><button data-mode="dark">Dark</button>
  <span class="sel" aria-live="polite"></span>
</div>
<script>
(() => {
  const html = document.documentElement, bar = document.querySelector('.rangoli-bar');
  const sel = bar.querySelector('.sel'), dot = bar.querySelector('.dot');
  const params = new URLSearchParams(location.search);
  const setMode = (m) => {
    if (m === 'light') html.removeAttribute('data-mode'); else html.setAttribute('data-mode', m);
    bar.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    params.set('mode', m); history.replaceState(null, '', '?' + params);
  };
  setMode(params.get('mode') || 'light');
  bar.addEventListener('click', e => { const m = e.target.dataset && e.target.dataset.mode; if (m) setMode(m); });
  let selected = (params.get('sel') || '').split(',').filter(Boolean);
  const paint = () => {
    document.querySelectorAll('.rangoli-selected').forEach(el => el.classList.remove('rangoli-selected'));
    selected.forEach(id => { const el = document.querySelector('[data-rid="' + id + '"]'); if (el) el.classList.add('rangoli-selected'); });
    sel.textContent = selected.length ? selected.map(s => '#' + s).join(' ') : 'click to select';
  };
  paint();
  document.addEventListener('mouseover', e => { const el = e.target.closest('[data-rid]'); document.querySelectorAll('.rangoli-hover').forEach(x => x.classList.remove('rangoli-hover')); if (el) el.classList.add('rangoli-hover'); });
  document.addEventListener('click', e => {
    if (e.target.closest('.rangoli-bar')) return;
    const el = e.target.closest('[data-rid]');
    e.preventDefault();
    const id = el ? el.dataset.rid : null;
    if (!id) selected = []; else if (e.shiftKey) selected = selected.includes(id) ? selected.filter(s => s !== id) : [...selected, id]; else selected = [id];
    params.set('sel', selected.join(',')); history.replaceState(null, '', '?' + params);
    paint();
    fetch('/select', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: selected }) });
  }, true);
  const es = new EventSource('/events');
  es.onopen = () => dot.classList.remove('off');
  es.onerror = () => dot.classList.add('off');
  es.addEventListener('change', () => location.reload());
})();
</script>`;

export interface PreviewServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

export async function startPreview(session: Session, port = 4400, host = '127.0.0.1'): Promise<PreviewServer> {
  const clients = new Set<ServerResponse>();
  const send = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(payload);
  };
  // preview page reloads after save; editor patches instantly on every change
  const onChange = () => send('change', Date.now());
  const onDoc = (e: ChangeEntry) => send('doc', { seq: e.seq, author: e.author, label: e.label ?? null, touched: e.touched, time: e.time });
  session.on('saved', onChange);
  session.on('change', onDoc);
  session.on('selection', (ids: string[]) => send('selection', ids));

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((res, rej) => {
      let b = '';
      req.on('data', (c: Buffer) => {
        b += c;
        if (b.length > 1e6) req.destroy();
      });
      req.on('end', () => res(b));
      req.on('error', rej);
    });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}`);
      // --- local-server hardening: block DNS rebinding and cross-site writes ---
      const hostHeader = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostHeader)) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden host');
        return;
      }
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        const ctype = req.headers['content-type'] ?? '';
        if ((origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) || !ctype.startsWith('application/json')) {
          res.writeHead(403, { 'content-type': 'text/plain' }).end('Cross-origin or non-JSON write rejected');
          return;
        }
      }
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      // ---------------- editor API ----------------
      if (url.pathname === '/api/doc' && req.method === 'GET') {
        const h = session.doc.historyEntries;
        json(200, {
          data: session.doc.data,
          dir: session.dir,
          seq: h.at(-1)?.seq ?? 0,
          history: h.slice(-50).map((e) => ({ seq: e.seq, author: e.author, label: e.label ?? null, time: e.time, touched: e.touched.length })),
          selection: session.selection,
        });
        return;
      }
      if (url.pathname === '/api/rdl' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { script?: string; label?: string; parent?: string };
        if (typeof body.script !== 'string') return json(400, { error: 'script required' });
        try {
          const r = applyRdl(session.doc, body.script, { author: 'human', label: body.label, parent: body.parent });
          json(200, { created: r.created, touched: r.touched });
        } catch (e) {
          json(400, { error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if ((url.pathname === '/api/undo' || url.pathname === '/api/redo') && req.method === 'POST') {
        const e = url.pathname === '/api/undo' ? session.doc.undo() : session.doc.redo();
        json(200, { ok: !!e, seq: e?.seq ?? null, label: e?.label ?? null });
        return;
      }
      if (url.pathname === '/api/tokens/brand' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { brand?: string };
        if (!body.brand || !/^#[0-9a-fA-F]{6}$/.test(body.brand)) return json(400, { error: 'brand must be #rrggbb' });
        session.doc.apply([{ op: 'setTokens', tokens: defaultTokens({ brand: body.brand }) }], { author: 'human', label: `brand ${body.brand}` });
        json(200, { ok: true });
        return;
      }
      if (url.pathname === '/api/lint' && req.method === 'GET') {
        json(200, lint(session.doc));
        return;
      }
      if (url.pathname === '/editor' || url.pathname.startsWith('/editor/')) {
        if (!existsSync(EDITOR_DIR)) {
          res.writeHead(503, { 'content-type': 'text/plain' }).end('Editor not built. Run: npm run build -w @rangoli/editor');
          return;
        }
        let rel = url.pathname.replace(/^\/editor\/?/, '') || 'index.html';
        const file = normalize(join(EDITOR_DIR, rel));
        if (!file.startsWith(EDITOR_DIR)) return void res.writeHead(403).end();
        rel = existsSync(file) ? file : join(EDITOR_DIR, 'index.html'); // SPA fallback
        res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream', 'cache-control': rel.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable' });
        res.end(await readFile(rel));
        return;
      }
      // ---------------- preview ----------------
      if (req.method === 'GET' && url.pathname === '/') {
        const page = renderDocument(session.doc, { editorAttrs: true, mode: url.searchParams.get('mode') ?? 'light' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(page.replace('</body>', `${CLIENT}\n</body>`));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/select') {
        const body = JSON.parse((await readBody(req)) || '{}') as { ids?: unknown };
        session.setSelection(Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string' && !!session.doc.findNode(x)) : []);
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/rdl') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(serializeRdl(session.doc));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/lint') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(formatLint(lint(session.doc)));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(e instanceof Error ? e.message : String(e));
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
    tryListen(port, 20);
  });

  return {
    url: `http://${host}:${actualPort}/`,
    server,
    close: () =>
      new Promise((r) => {
        session.off('saved', onChange);
        session.off('change', onDoc);
        for (const c of clients) c.end();
        server.close(() => r());
      }),
  };
}
