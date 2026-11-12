/**
 * Static pages of a design: a snapshot for stakeholders and developers, a frame before and after a fix, and the
 * HTML export. No scripts at all: layer scripts are never rendered, anything script-like is stripped, and the CSP
 * sandboxes the page with no permissions, so even a missed script could not run. Images are inlined as data URIs,
 * so the page fetches nothing.
 */
import type { ServerResponse } from 'node:http';
import { kolam, RangoliDocument, renderCss, renderFragment, type AssetMeta, type DocumentData } from '@rangoli/engine';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Snapshot pages: nothing loads from anywhere, nothing runs, and nothing is indexed or leaks its URL. */
export const staticCsp = (embeddable: boolean) =>
  `default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors ${embeddable ? "'self'" : "'none'"}; sandbox`;

export function sendStaticPage(res: ServerResponse, html: string, opts: { embeddable?: boolean; status?: number; filename?: string; approval?: string } = {}): void {
  res.writeHead(opts.status ?? 200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': staticCsp(!!opts.embeddable),
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'referrer-policy': 'no-referrer',
    'x-frame-options': opts.embeddable ? 'SAMEORIGIN' : 'DENY',
    'cross-origin-resource-policy': 'same-origin',
    ...(opts.approval ? { 'x-rangoli-approval': opts.approval } : {}),
    ...(opts.filename ? { 'content-disposition': `attachment; filename="${opts.filename.replace(/[^\w.-]/g, '_')}"` } : {}),
  });
  res.end(html);
}

/**
 * Removes elements that run or load things (the renderer escapes text and attributes, so these only come from
 * the renderer itself, as with 3D scenes). The CSP sandbox, with no allow-scripts, is what guarantees nothing runs.
 */
export function stripActive(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<\/?(script|iframe|object|embed|link|meta|base)\b[^>]*>/gi, '');
}

/** The kolam seal of a content hash, as inline SVG. Decorative: the hash printed beside it is the proof. */
export function sealSvg(hash: string, size = 56): string {
  const k = kolam(hash);
  const dots = k.dots.map((d) => `<circle cx="${d.x}" cy="${d.y}" r="1.6"/>`).join('');
  return `<svg class="seal" width="${size}" height="${size}" viewBox="${k.viewBox}" role="img" aria-label="Seal of ${hash.slice(0, 12)}"><g fill="currentColor" opacity=".45">${dots}</g><path d="${k.path}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
}

export interface StaticOptions {
  title: string;
  /** shown above the design: what this is, and whether it is approved */
  heading: { project: string; label: string; hash?: string; unapproved?: boolean; lines?: string[]; action?: { href: string; text: string } };
  /** only these frames; every page's top-level frames otherwise */
  frames?: string[];
  /** image file name -> data URI */
  assets: Map<string, string>;
}

/** Renders a design (a snapshot's frozen data or the working copy) to one self-contained page. */
export function renderStatic(data: DocumentData, opts: StaticOptions): string {
  const doc = new RangoliDocument(structuredClone(data));
  const assetUrl = (meta: AssetMeta) => opts.assets.get(meta.file) ?? '';
  const parts: string[] = [];
  const css: string[] = [];
  const used = new Set<string>();
  for (const { id: page } of doc.data.manifest.pages) {
    const top = doc.data.pages[page]?.children ?? [];
    const roots = opts.frames ? top.filter((r) => opts.frames!.includes(r)) : top;
    if (!roots.length) continue;
    const frag = renderFragment(doc, { page, roots, assetUrl });
    parts.push(stripActive(frag.html));
    css.push(frag.css);
    for (const c of frag.usedComponents) used.add(c);
  }
  const h = opts.heading;
  const banner = h.unapproved ? `<p class="rangoli-unapproved" role="note">Unapproved: this is the working copy, not an approved version.</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
${h.unapproved ? '<meta name="rangoli-approval" content="unapproved">' : ''}
<title>${esc(opts.title)}</title>
<style>
${renderCss(doc, css.join('\n'), [...used]).replace(/@import[^;]*;/gi, '')}
.rangoli-head{display:flex;gap:16px;align-items:center;padding:16px 24px;border-bottom:1px solid #d9d9de;background:#fafafa;color:#1d1d22;font:14px/1.45 system-ui,sans-serif}
.rangoli-head h1{font-size:16px;margin:0}.rangoli-head p{margin:2px 0 0;color:#55555e}.rangoli-head code{font:12px ui-monospace,monospace}
.rangoli-head .seal{color:#7a3e9d;flex:none}.rangoli-head a{color:#1d4ed8}
.rangoli-unapproved{margin:0;padding:10px 24px;background:#fff4e5;color:#7a4100;font:600 14px system-ui,sans-serif;border-bottom:1px solid #f0c48a}
.rangoli-stage{padding:24px;display:flex;flex-wrap:wrap;gap:48px;align-items:flex-start}
</style>
</head>
<body>
<header class="rangoli-head">
${h.hash ? sealSvg(h.hash) : ''}
<div>
<h1>${esc(h.project)} · ${esc(h.label)}</h1>
${h.hash ? `<p>Content hash <code>${esc(h.hash)}</code></p>` : ''}
${(h.lines ?? []).map((l) => `<p>${esc(l)}</p>`).join('\n')}
${h.action ? `<p><a href="${esc(h.action.href)}">${esc(h.action.text)}</a></p>` : ''}
</div>
</header>
${banner}
<main class="rangoli-stage">
${parts.join('\n')}
</main>
</body>
</html>
`;
}
