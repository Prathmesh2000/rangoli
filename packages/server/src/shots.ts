/**
 * Let agents SEE: PNG screenshots of the design and animation filmstrips, rendered by the
 * reference renderer in the system's Edge/Chrome (playwright-core, no browser download).
 */
import { applyRdl, cloneDocument, findIcon, iconSvg, renderCss, renderFragment, resolveTiming, timelineDuration, TokenResolver, type AssetMeta, type RangoliDocument } from '@rangoli/engine';

type Browser = { newPage(o: object): Promise<Page>; close(): Promise<void> };
type Page = {
  setContent(html: string, o?: object): Promise<void>;
  evaluate<T, A>(fn: (a: A) => T, arg: A): Promise<T>;
  locator(sel: string): { screenshot(o?: object): Promise<Buffer> };
  close(): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
};

let browserP: Promise<Browser> | null = null;

/** How screenshots embed image assets (data URIs — headless pages cannot read local files). */
let assetUrl: ((m: AssetMeta) => string) | undefined;
export function setAssetResolver(fn: (m: AssetMeta) => string): void {
  assetUrl = fn;
}

export async function browser(): Promise<Browser> {
  browserP ??= (async () => {
    let pw: { chromium: { launch(o: object): Promise<Browser> } };
    try {
      pw = (await import('playwright-core')) as unknown as typeof pw;
    } catch {
      throw new Error('Screenshots need playwright-core (npm i playwright-core) and Microsoft Edge or Google Chrome installed.');
    }
    for (const channel of ['msedge', 'chrome']) {
      try {
        return await pw.chromium.launch({ channel, headless: true });
      } catch {
        /* try next */
      }
    }
    throw new Error('No Edge or Chrome found for screenshots.');
  })();
  browserP.catch(() => (browserP = null));
  return browserP;
}

export async function closeShots(): Promise<void> {
  if (browserP) await (await browserP).close().catch(() => undefined);
  browserP = null;
}

function page(doc: RangoliDocument, roots: string[] | undefined, mode: string, extraHead = '', body?: string): string {
  const frag = renderFragment(doc, { roots, editorAttrs: true, assetUrl });
  const css = renderCss(doc, frag.css, frag.usedComponents);
  return `<!doctype html><html lang="en"${mode === 'dark' ? ' data-mode="dark"' : ''}><head><meta charset="utf-8"><style>${css}
body{margin:0;background:var(--color-bg-canvas)}
#shot{display:inline-flex;flex-wrap:wrap;gap:32px;padding:24px;align-items:flex-start}
${extraHead}</style></head><body>${body ?? `<div id="shot">${frag.html}</div>`}</body></html>`;
}

/** PNG of the given roots (or the whole page). */
export async function renderPng(doc: RangoliDocument, opts: { roots?: string[]; mode?: string; maxWidth?: number } = {}): Promise<Buffer> {
  const b = await browser();
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  try {
    await p.setContent(page(doc, opts.roots, opts.mode ?? 'light', '[data-rid]{animation:none!important}'));
    const max = opts.maxWidth ?? 1280;
    await p.evaluate((m: number) => {
      const el = document.getElementById('shot')!;
      const w = el.scrollWidth;
      if (w > m) (el.style as CSSStyleDeclaration & { zoom: string }).zoom = String(m / w);
    }, max);
    return await p.locator('#shot').screenshot({ animations: 'disabled' });
  } finally {
    await p.close();
  }
}

/**
 * Icon review sheet: each icon at 16/20/24/32 px on light and dark, plus in real context
 * (secondary button, chip, table-row label) rendered by the reference renderer.
 */
export async function renderIcons(doc: RangoliDocument, refs: string[]): Promise<Buffer> {
  const sets = doc.data.icons ?? {};
  const rows: string[] = [];
  const ctxDoc = cloneDocument(doc);
  const ctxRoots: string[] = [];
  // build in-context examples in a throwaway copy (never touches the real document)
  for (const ref of refs) {
    const found = findIcon(sets, ref);
    if (!found) throw new Error(`Unknown icon "${ref}"`);
    const full = `${found.set.name}/${found.icon.name}`;
    const r = applyRdl(ctxDoc, `Ctx row gap4 p3 center fill:surface name:"ctx ${full}"\n  @Button variant=secondary size=sm "Action"\n    Icon icon:${full} w16 h16\n  @Chip variant=info "Status"\n    Icon icon:${full} w12 h12\n  Line row gap2 center\n    Icon icon:${full} w16 h16 color:text.secondary\n    Text body-sm "Row label"`);
    ctxRoots.push(r.created[0]!);
  }
  const frag = renderFragment(ctxDoc, { roots: ctxRoots, editorAttrs: false, assetUrl });
  const ctxHtml = frag.html.split('\n');
  refs.forEach((ref, i) => {
    const { set, icon } = findIcon(sets, ref)!;
    const sizes = [16, 20, 24, 32].map((s) => `<span class="t">${iconSvg(set, icon, { size: s })}</span>`).join('');
    rows.push(`<div class="row"><code>${set.name}/${icon.name}</code><div class="sizes">${sizes}</div><div class="sizes dark">${sizes}</div><div class="ctx">${ctxHtml[i] ?? ''}</div></div>`);
  });
  const css = renderCss(ctxDoc, frag.css, frag.usedComponents);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
body{margin:0;background:#fff}
#sheet{display:inline-flex;flex-direction:column;padding:12px;gap:4px;font:12px ui-sans-serif,system-ui}
.row{display:flex;align-items:center;gap:16px;border-bottom:1px solid #eef0f3;padding:6px 0}
code{width:150px;color:#5b6470;font:12px ui-monospace,monospace}
.sizes{display:flex;gap:12px;align-items:center;padding:8px 12px;border-radius:6px;background:#f6f7f9;color:#1c2026}
.sizes.dark{background:#16191d;color:#e6e8eb}
.t{display:inline-grid;place-items:center;width:34px;height:34px}
.ctx{display:flex}</style></head><body><div id="sheet">${rows.join('')}</div></body></html>`;
  const b = await browser();
  const p = await b.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  try {
    await p.setContent(html);
    return await p.locator('#sheet').screenshot();
  } finally {
    await p.close();
  }
}

/**
 * Filmstrip: N frozen frames of an enter/exit animation of #id, or of a timeline, in one PNG.
 * The node's top-level screen is rendered N times; animations are paused at evenly spaced times.
 */
export async function filmstrip(doc: RangoliDocument, opts: { target: string; trigger?: 'enter' | 'exit'; frames?: number; mode?: string }): Promise<{ png: Buffer; ms: number; times: number[] }> {
  const pageNodes = doc.page().nodes;
  const tokens = new TokenResolver(doc.data.tokens);
  const frames = Math.min(10, Math.max(3, opts.frames ?? 6));
  let ms: number;
  let rootId: string | undefined;
  let tlClass = '';
  let tracks: { id: string; at: number }[] = [];
  if (opts.target.startsWith('timeline:')) {
    const tl = doc.data.timelines?.[opts.target.slice(9)];
    if (!tl) throw new Error(`No timeline "${opts.target.slice(9)}"`);
    ms = timelineDuration(tl, doc.data.tokens);
    tlClass = `tl-${tl.name}`;
    tracks = tl.tracks.map((t) => ({ id: t.target, at: t.at }));
    rootId = tl.tracks[0]?.target;
  } else {
    const id = opts.target.replace(/^#/, '');
    const spec = doc.data.motion?.[`#${id}`]?.specs.find((s) => s.trigger === (opts.trigger ?? 'enter'));
    if (!spec) throw new Error(`#${id} has no ${opts.trigger ?? 'enter'} motion`);
    ms = resolveTiming(spec, tokens).ms;
    tracks = [{ id, at: 0 }];
    rootId = id;
  }
  // climb to the screen so the animation is seen in context
  while (rootId && pageNodes[rootId]?.parent) rootId = pageNodes[rootId]!.parent;
  if (!rootId) throw new Error('Nothing to film');
  const times = Array.from({ length: frames }, (_, i) => Math.round((i / (frames - 1)) * ms));
  const frag = renderFragment(doc, { roots: [rootId], editorAttrs: true, assetUrl });
  const cells = times.map((t, i) => `<figure class="cell" data-i="${i}"><div class="crop"><div class="inner ${tlClass}">${frag.html}</div></div><figcaption>${t} ms</figcaption></figure>`).join('');
  const html = page(doc, [rootId], opts.mode ?? 'light', `
#strip{display:inline-flex;gap:12px;padding:12px;background:#e9ecf0}
.cell{margin:0;background:var(--color-bg-canvas);box-shadow:0 0 0 1px #cfd4da;display:flex;flex-direction:column}
.crop{overflow:hidden;position:relative}
.inner{width:max-content}
figcaption{font:600 13px/24px ui-monospace,monospace;text-align:center;color:#3d4550;background:#fff;border-top:1px solid #e3e6ea}`, `<div id="strip">${cells}</div>`);
  const b = await browser();
  const p = await b.newPage({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 1 });
  try {
    await p.setContent(html);
    await p.evaluate(
      (a: { times: number[]; tracks: { id: string; at: number }[]; exit: boolean }) => {
        // crop every frame to the animated elements (measured at rest, before freezing) + margin
        const first = document.querySelector<HTMLElement>('.cell .inner')!;
        const base = first.getBoundingClientRect();
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const tr of a.tracks) {
          const el = first.querySelector<HTMLElement>(`[data-rid="${tr.id}"]`);
          if (!el) continue;
          el.style.animation = 'none';
          const r = el.getBoundingClientRect();
          el.style.animation = '';
          x0 = Math.min(x0, r.left - base.left); y0 = Math.min(y0, r.top - base.top);
          x1 = Math.max(x1, r.right - base.left); y1 = Math.max(y1, r.bottom - base.top);
        }
        if (Number.isFinite(x0)) {
          const pad = 32;
          const cx = Math.max(0, x0 - pad), cy = Math.max(0, y0 - pad);
          const w = Math.min(base.width - cx, x1 - x0 + pad * 2), h = Math.min(base.height - cy, y1 - y0 + pad * 2);
          document.querySelectorAll<HTMLElement>('.crop').forEach((c) => { c.style.width = `${w}px`; c.style.height = `${h}px`; });
          document.querySelectorAll<HTMLElement>('.inner').forEach((n) => { n.style.transform = `translate(${-cx}px, ${-cy}px)`; });
        }
        document.querySelectorAll<HTMLElement>('.cell').forEach((cell, i) => {
          const t = a.times[i]!;
          for (const tr of a.tracks) {
            const el = cell.querySelector<HTMLElement>(`[data-rid="${tr.id}"]`);
            if (!el) continue;
            if (a.exit) el.setAttribute('data-exiting', '');
            // freeze at time t: negative delay = already elapsed; keep the track's own offset
            el.style.animationDelay = `${tr.at - t}ms`;
            el.style.animationPlayState = 'paused';
          }
        });
        const strip = document.getElementById('strip')!;
        const w = strip.scrollWidth;
        if (w > 1600) (strip.style as CSSStyleDeclaration & { zoom: string }).zoom = String(1600 / w);
      },
      { times, tracks, exit: opts.trigger === 'exit' },
    );
    await p.waitForTimeout(50);
    const png = await p.locator('#strip').screenshot();
    return { png, ms, times };
  } finally {
    await p.close();
  }
}
