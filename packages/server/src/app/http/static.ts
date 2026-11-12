/** The built editor: hashed assets under /editor/, index.html for every other GET. */
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notFound } from './errors.js';
import { APP_CSP } from './headers.js';

// this file sits in dist/app/http/, so packages/ is four levels up
const EDITOR_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../editor/dist');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };

/** file is strictly below dir: a path relative to dir that neither climbs out (..) nor jumps elsewhere. */
export const isInside = (dir: string, file: string): boolean => {
  const rel = relative(dir, file);
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('../') && !isAbsolute(rel);
};

export async function serveEditor(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (req.method !== 'GET') throw notFound();
  if (!existsSync(EDITOR_DIR)) return void res.writeHead(503, { 'content-type': 'text/plain' }).end('App not built. Run: npm run build');
  const rel = path.startsWith('/editor/') ? path.slice('/editor/'.length) : '';
  const file = normalize(join(EDITOR_DIR, rel));
  // the separator matters: without it, a sibling such as editor/dist-private/ would pass as inside
  const isAsset = !!rel && isInside(EDITOR_DIR, file) && existsSync(file) && statSync(file).isFile();
  res.writeHead(200, {
    'content-type': isAsset ? MIME[extname(file)] ?? 'application/octet-stream' : MIME['.html']!,
    'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-store',
    'content-security-policy': APP_CSP,
    'x-frame-options': 'DENY',
  });
  res.end(await readFile(isAsset ? file : join(EDITOR_DIR, 'index.html')));
}
