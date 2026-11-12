/**
 * Retained canvas (ARCHITECTURE.md section 4: incremental render, retained frames, styles, culling).
 *
 * Every top-level frame lives in its own shadow root, on its own host element placed freely on the page.
 * A frame's root adopts four constructable sheets: the shared head (fonts, tokens, base, component CSS), the
 * frame's own node rules, motion, and editor CSS (skin, grid). Style invalidation stops at a shadow root, so:
 *
 * - an edit replaces one frame's element and, when its rules changed, one frame's sheet: only that frame restyles;
 * - a token edit builds a new head sheet ("generation") and hands it only to frames that read a changed
 *   variable (FrameRenderer.framesReading). Other frames keep the previous generation, which nothing mutates:
 *   the values they read are the same in both. Mode changes and skin changes restyle every frame, as they must.
 *
 * Frames sit where their `position` says; frames without one flow in a row (canvas-layout.ts placeFrames).
 * Frames far outside the viewport are parked: their content is dropped and the host keeps its size and
 * background colour. Coming back, parked frames mount a few per animation frame (time-sliced), nearest first,
 * so a pan never pays for a whole screen of frames at once.
 */
import { FrameRenderer, RectIndex, fontHead, mountScene3D, placeFrames, renderCss, renderFragment, type FrameDelta, type IndexedRect, type RangoliDocument, type Rect, type SceneSpec } from '@rangoli/engine';
import { loadThree } from './three';

/** Scope document-level CSS (:root, body, [data-mode]) to the shadow host. */
export function scopeCss(css: string): string {
  return css
    .replace(/:root\b/g, ':host')
    .replace(/\[data-mode="([^"]+)"\]/g, ':host([data-mode="$1"])')
    .replace(/(^|\n)body\{/g, '$1:host{');
}

/** The single-root stage used by one-shot renders (compare panes, studios). */
export const STAGE_CSS = `:host{display:block;background:transparent!important}
.stage{display:flex;flex-wrap:wrap;gap:64px;align-items:flex-start;padding:64px 64px 64px 128px}
.stage{width:max-content}
.stage>[data-rid]{background-clip:padding-box;flex-shrink:0}
.stage [data-rid]:not([data-play]){animation:none!important}
`;

/** Inside each frame's shadow root: the host is transparent, the frame is the only top-level element. */
export const FRAME_SCOPE = ':host>[data-rid]';
const FRAME_EDITOR_CSS = `:host{background:transparent!important;display:block}
${FRAME_SCOPE}{background-clip:padding-box}
[data-rid]:not([data-play]){animation:none!important}
[contenteditable]{outline:2px solid #BD1560;outline-offset:2px;cursor:text}
`;

/** The outer root: a stage of absolutely placed frame hosts. */
const OUTER_CSS = `:host{display:block}
.stage{position:relative}
.fh{position:absolute;left:0;top:0;contain:layout style}
.fh[data-parked]{box-shadow:inset 0 0 0 1px rgb(0 0 0 / .06)}
`;

/** Space around the frames inside the stage, in design pixels (left leaves room for the tool bar). */
export const STAGE_PAD = { left: 128, top: 64, right: 64, bottom: 64 };

/** Web fonts must be declared on the page itself: @font-face inside a shadow root is ignored. */
export function syncFonts(doc: RangoliDocument): void {
  const { links, css } = fontHead(doc, { proxied: true });
  for (const href of links) {
    if (document.head.querySelector(`link[data-font="${CSS.escape(href)}"]`)) continue;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-font', href);
    document.head.appendChild(l);
  }
  let tag = document.getElementById('rangoli-fonts') as HTMLStyleElement | null;
  if (!tag) { tag = document.createElement('style'); tag.id = 'rangoli-fonts'; document.head.appendChild(tag); }
  if (tag.textContent !== css) tag.textContent = css;
}

export interface RetainedStats {
  /** frames rendered to strings */
  rendered: number;
  /** frame elements replaced in the DOM */
  patched: number;
  /** stylesheets whose text was replaced or created */
  sheets: number;
  /** frames whose style scope was invalidated (sheet replaced or sheet list changed) */
  restyled: number;
  frames: number;
  culled: number;
  full: boolean;
  ms: number;
  /** of which: rendering frames to strings (engine) */
  renderMs: number;
}

interface Host {
  id: string;
  host: HTMLDivElement;
  root: ShadowRoot;
  /** the frame element while mounted (null when parked or when the frame rendered nothing) */
  el: Element | null;
  parked: boolean;
  /** content changed while parked: size unknown until mounted again */
  stale: boolean;
  sheet: CSSStyleSheet;
  sheetText: string;
  /** what the root adopts now (head and motion may be an older generation) */
  adopted: CSSStyleSheet[];
  defs: string | null;
  /** host size and the frame's box inside the host, in design pixels; undefined until measured */
  size?: { w: number; h: number; lx: number; ly: number; fw: number; fh: number };
  /** placed position of the host on the page (design pixels) */
  x: number;
  y: number;
  /** a top-level frame placed by its own CSS (absolute): the host stays at the page origin */
  selfPlaced: boolean;
}

const sheetOf = (css: string) => {
  const s = new CSSStyleSheet();
  s.replaceSync(css);
  return s;
};

export class RetainedCanvas {
  readonly stage: HTMLDivElement;
  private readonly frames: FrameRenderer;
  private readonly outer = new CSSStyleSheet();
  /** current generations of the shared sheets */
  private head = new CSSStyleSheet();
  private motion = new CSSStyleSheet();
  private editor = new CSSStyleSheet();
  private headText = '';
  private motionText = '';
  private editorText = '';
  private defsText = '';
  private readonly hosts = new Map<string, Host>();
  private readonly scenes = new Map<string, (() => void)[]>();
  private index: RectIndex = RectIndex.build([]);
  private doc: RangoliDocument | null = null;
  private mode = 'light';
  private originX = 0;
  private originY = 0;
  private queue = new Set<string>();
  private pumping = 0;
  private view: Rect | null = null;
  /** off for exact comparison with the full render */
  culling = true;
  /** time budget per animation frame for mounting parked frames */
  sliceMs = 6;
  last: RetainedStats | null = null;
  /** called when the page origin moves (a frame went further left or up), with the shift in design pixels */
  onOriginChange: ((dx: number, dy: number) => void) | null = null;
  /** called after parked frames mounted from the queue */
  onMounted: ((ids: string[]) => void) | null = null;
  /** the zoom the stage is shown at (set by the canvas) */
  getZoom: () => number = () => 1;
  private placedOnce = false;

  constructor(readonly root: ShadowRoot, private readonly assetBase: string, readonly page?: string) {
    this.frames = new FrameRenderer({ editorAttrs: true, assetBase, page });
    root.replaceChildren();
    this.outer.replaceSync(OUTER_CSS);
    this.editor.replaceSync(FRAME_EDITOR_CSS);
    this.editorText = FRAME_EDITOR_CSS;
    this.stage = document.createElement('div');
    this.stage.className = 'stage';
    root.append(this.stage);
    root.adoptedStyleSheets = [this.outer];
  }

  // ---------------------------------------------------------------- what the editor asks

  get frameIndex(): RectIndex {
    return this.index;
  }

  get order(): readonly string[] {
    return this.frames.order;
  }

  /** Top-left of the stage in design pixels: stage-local = design - origin. */
  get origin(): { x: number; y: number } {
    return { x: this.originX, y: this.originY };
  }

  /** The frame a layer was last rendered in (top-level frames map to themselves). */
  frameOf(id: string): string | undefined {
    return this.hosts.has(id) ? id : this.frames.frameOf(id);
  }

  /** The element for a layer, wherever its frame's shadow root is; null when not mounted. */
  element(id: string): HTMLElement | null {
    const f = this.frameOf(id);
    const h = f ? this.hosts.get(f) : undefined;
    if (!h?.el) return null;
    if (f === id) return h.el as HTMLElement;
    return h.root.querySelector<HTMLElement>(`[data-rid="${CSS.escape(id)}"]`);
  }

  /** A frame's shadow root (mounted or not). */
  frameRoot(id: string): ShadowRoot | undefined {
    return this.hosts.get(id)?.root;
  }

  /** Every mounted [data-rid] element in these frames, in document order (later paints above earlier). */
  elementsIn(frameIds: Iterable<string>): HTMLElement[] {
    const out: HTMLElement[] = [];
    const want = new Set(frameIds);
    for (const id of this.frames.order) {
      if (!want.has(id)) continue;
      const h = this.hosts.get(id);
      if (h?.el) out.push(...h.root.querySelectorAll<HTMLElement>('[data-rid]'));
    }
    return out;
  }

  /** Mounted [data-rid] elements of the frames under a screen point, in paint order. */
  elementsAt(clientX: number, clientY: number, zoom: number): HTMLElement[] {
    const p = this.toDesign(clientX, clientY, zoom);
    return this.elementsIn(this.index.search(p.x, p.y, p.x, p.y));
  }

  /** Design pixels for a screen point. */
  toDesign(clientX: number, clientY: number, zoom: number): { x: number; y: number } {
    const s = this.stage.getBoundingClientRect();
    return { x: (clientX - s.left) / zoom + this.originX, y: (clientY - s.top) / zoom + this.originY };
  }

  /** A frame's bounds in design pixels (from its last measure). */
  bounds(id: string): Rect | undefined {
    const h = this.hosts.get(id);
    if (!h?.size) return undefined;
    return { x: h.x + h.size.lx, y: h.y + h.size.ly, w: h.size.fw, h: h.size.fh };
  }

  isParked(id: string): boolean {
    return !!this.hosts.get(id)?.parked;
  }

  /** Bring the canvas up to `doc`. `touched` null means "unknown": every frame is re-rendered and diffed. */
  update(doc: RangoliDocument, touched: Iterable<string> | null): RetainedStats {
    const t0 = performance.now();
    this.doc = doc;
    const d = this.frames.sync(doc, touched);
    const renderMs = performance.now() - t0;
    if (d.fontsDirty) syncFonts(doc);
    let sheets = 0;
    const restyle = new Set<string>();
    if (d.headChanged) {
      const text = scopeCss(this.frames.headCss());
      if (text !== this.headText) {
        this.head = sheetOf(text);
        this.headText = text;
        sheets++;
        const reach = d.full || d.tokenVars === null ? this.frames.order : this.frames.framesReading(d.tokenVars);
        for (const id of reach) restyle.add(id);
      }
    }
    if (d.motionChanged) {
      const text = scopeCss(this.frames.motionCss());
      if (text !== this.motionText) {
        this.motion = sheetOf(text);
        this.motionText = text;
        sheets++;
        for (const id of this.frames.order) restyle.add(id);
      }
    }
    for (const id of d.removed) this.drop(id);
    let patched = 0;
    const mounted: Host[] = [];
    for (const id of d.changed) {
      const css = scopeCss(this.frames.frameCss(id));
      let h = this.hosts.get(id);
      if (!h) { h = this.create(id, css); sheets++; }
      else if (h.sheetText !== css) { h.sheet.replaceSync(css); h.sheetText = css; sheets++; restyle.add(id); }
      if (h.parked && h.size) { h.stale = true; this.queue.add(id); continue; }
      this.mount(h);
      mounted.push(h);
      patched++;
    }
    // measure after every write, so the batch costs one layout
    for (const h of mounted) this.measure(h);
    let restyled = 0;
    for (const id of restyle) if (this.adopt(this.hosts.get(id))) restyled++;
    this.placeInOrder(d);
    this.relayout();
    if (this.queue.size) this.schedule();
    const stats: RetainedStats = { rendered: d.rendered, patched, sheets, restyled, frames: d.order.length, culled: this.parkedCount(), full: d.full, ms: performance.now() - t0, renderMs };
    this.last = stats;
    return stats;
  }

  /** Editor-only CSS inside every frame (skin, layout grid) and markup before each frame (skin filters). */
  setEditorCss(extraCss: string, extraHtml: string): void {
    const text = FRAME_EDITOR_CSS + extraCss;
    let changed = false;
    if (text !== this.editorText) { this.editor = sheetOf(text); this.editorText = text; changed = true; }
    if (extraHtml !== this.defsText) { this.defsText = extraHtml; changed = true; }
    if (!changed) return;
    for (const h of this.hosts.values()) {
      this.adopt(h);
      if (h.el) this.syncDefs(h);
    }
    this.measureAll();
  }

  /** Light, dark or a theme id: token blocks are scoped to each frame host. */
  setMode(mode: string): void {
    if (mode === this.mode) return;
    this.mode = mode;
    for (const h of this.hosts.values()) this.applyMode(h.host);
    this.measureAll();
  }

  /** Re-read every mounted frame's size (after something that can change layout everywhere). */
  measureAll(): void {
    for (const h of this.hosts.values()) if (h.el || !h.size) this.measure(h);
    this.relayout();
  }

  /**
   * Mount frames near the viewport and park the rest. `view` is the visible area in design pixels. Frames
   * within one viewport of it mount (time-sliced, nearest first); frames beyond 1.5 viewports park.
   */
  cull(view: Rect): { queued: string[]; parked: string[] } {
    this.view = view;
    const queued: string[] = [], parked: string[] = [];
    if (!this.doc) return { queued, parked };
    const near = new Set(this.index.search(view.x - view.w, view.y - view.h, view.x + 2 * view.w, view.y + 2 * view.h));
    const keep = new Set(this.index.search(view.x - 1.5 * view.w, view.y - 1.5 * view.h, view.x + 2.5 * view.w, view.y + 2.5 * view.h));
    for (const id of this.frames.order) {
      const h = this.hosts.get(id);
      if (!h) continue;
      if (h.parked) {
        if (!this.culling || near.has(id) || !h.size) { if (!this.queue.has(id)) { this.queue.add(id); queued.push(id); } }
      } else if (this.culling && h.size && !h.selfPlaced && !keep.has(id)) {
        this.park(h);
        parked.push(id);
      }
    }
    if (this.queue.size) this.schedule();
    return { queued, parked };
  }

  /** Mount everything queued now, without slicing (checks, and before a full-page export of the view). */
  flush(): string[] {
    window.cancelAnimationFrame(this.pumping);
    this.pumping = 0;
    return this.pump(Infinity);
  }

  /** What the old path wrote with innerHTML for the same document (for checks and benchmarks). */
  fullRender(): { html: string; css: string } {
    if (!this.doc) return { html: '', css: '' };
    const f = renderFragment(this.doc, { editorAttrs: true, assetBase: this.assetBase, page: this.page });
    return { html: f.html, css: scopeCss(renderCss(this.doc, f.css, f.usedComponents)) };
  }

  /**
   * Compare with a full render: every mounted frame's element must equal the full render's element for that
   * frame, and the current head + frame rules + motion must equal the full render's CSS. Frames holding an
   * older head generation are listed in `older` (they read none of the variables that changed since).
   */
  verify(): { htmlEqual: boolean; cssEqual: boolean; frames: number; culled: number; mismatched: string[]; older: string[]; scoped: boolean } {
    const doc = this.doc;
    if (!doc) return { htmlEqual: false, cssEqual: false, frames: 0, culled: 0, mismatched: [], older: [], scoped: false };
    const f = renderFragment(doc, { editorAttrs: true, assetBase: this.assetBase, page: this.page });
    const fullCss = scopeCss(renderCss(doc, f.css, f.usedComponents));
    const text = (s: CSSStyleSheet) => [...s.cssRules].map((r) => r.cssText).join('\n');
    const ownCss = [text(this.head), ...this.frames.order.map((id) => this.hosts.get(id)).filter((h): h is Host => !!h).map((h) => text(h.sheet)), text(this.motion)].filter(Boolean).join('\n');
    const probe = new CSSStyleSheet();
    probe.replaceSync(fullCss);
    const parsedFull = [...probe.cssRules].map((r) => r.cssText).join('\n');
    const tpl = document.createElement('template');
    tpl.innerHTML = f.html;
    const fullEls = [...tpl.content.children];
    const mismatched: string[] = [], older: string[] = [];
    let scoped = true;
    let i = 0;
    for (const id of this.frames.order) {
      const html = this.frames.frame(id)!.html;
      const ref = html ? fullEls[i++] : undefined;
      const h = this.hosts.get(id);
      if (!h || h.parked || !html) continue;
      if (!h.el || !ref || h.el.outerHTML !== ref.outerHTML) mismatched.push(id);
      if (h.adopted[0] !== this.head) older.push(id);
      // each frame's styles live in its own root: its own sheet, no other frame's
      if (h.root.adoptedStyleSheets[1] !== h.sheet || h.root.adoptedStyleSheets.length !== 4) scoped = false;
    }
    return { htmlEqual: this.frames.html() === f.html && !mismatched.length, cssEqual: ownCss === parsedFull, frames: this.frames.order.length, culled: this.parkedCount(), mismatched, older, scoped };
  }

  dispose(): void {
    window.cancelAnimationFrame(this.pumping);
    this.pumping = 0;
    for (const id of [...this.scenes.keys()]) this.stopScenes(id);
  }

  // ---------------------------------------------------------------- internals

  private create(id: string, css: string): Host {
    const host = document.createElement('div');
    host.className = 'fh';
    host.setAttribute('data-fh', id);
    this.applyMode(host);
    const root = host.attachShadow({ mode: 'open' });
    const sheet = sheetOf(css);
    const h: Host = { id, host, root, el: null, parked: false, stale: false, sheet, sheetText: css, adopted: [], defs: null, x: 0, y: 0, selfPlaced: false };
    this.hosts.set(id, h);
    this.adopt(h);
    this.stage.append(host); // placeInOrder puts it in page order
    return h;
  }

  private applyMode(host: HTMLElement): void {
    if (this.mode !== 'light') host.setAttribute('data-mode', this.mode);
    else host.removeAttribute('data-mode');
  }

  /** Give a frame root the current generations; true when its sheet list changed (the frame restyles). */
  private adopt(h: Host | undefined): boolean {
    if (!h) return false;
    const next = [this.head, h.sheet, this.motion, this.editor];
    if (next.every((s, i) => s === h.adopted[i])) return false;
    h.root.adoptedStyleSheets = next;
    h.adopted = next;
    return true;
  }

  private syncDefs(h: Host): void {
    if (h.defs === this.defsText) return;
    h.root.querySelector(':scope > [data-defs]')?.remove();
    if (this.defsText) {
      const d = document.createElement('div');
      d.setAttribute('data-defs', '');
      d.style.display = 'contents';
      d.innerHTML = this.defsText;
      h.root.prepend(d);
    }
    h.defs = this.defsText;
  }

  private mount(h: Host): void {
    const html = this.frames.frame(h.id)?.html ?? '';
    this.stopScenes(h.id);
    let el: Element | null = null;
    if (html) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      el = tpl.content.firstElementChild;
    }
    if (h.el) h.el.remove();
    if (h.parked) { h.parked = false; h.host.removeAttribute('data-parked'); h.host.style.width = h.host.style.height = h.host.style.background = ''; }
    h.defs = null;
    this.syncDefs(h);
    if (el) h.root.append(el);
    h.el = el;
    h.stale = false;
    this.adopt(h);
    h.selfPlaced = !!this.doc?.page(this.page).nodes[h.id]?.absolute;
    if (el) this.startScenes(h.id, el);
  }

  private park(h: Host): void {
    if (!h.size) return;
    const bg = h.el ? getComputedStyle(h.el).backgroundColor : '';
    this.stopScenes(h.id);
    h.el?.remove();
    h.el = null;
    h.parked = true;
    h.host.setAttribute('data-parked', '');
    h.host.style.width = `${h.size.w}px`;
    h.host.style.height = `${h.size.h}px`;
    if (bg && bg !== 'rgba(0, 0, 0, 0)') h.host.style.background = bg;
  }

  private drop(id: string): void {
    this.stopScenes(id);
    this.hosts.get(id)?.host.remove();
    this.hosts.delete(id);
    this.queue.delete(id);
  }

  private parkedCount(): number {
    let n = 0;
    for (const h of this.hosts.values()) if (h.parked) n++;
    return n;
  }

  /** Host size and the frame's box inside it. Forces layout once for the first call after a change. */
  private measure(h: Host): void {
    if (h.parked) return;
    const z = this.zoom();
    const hr = h.host.getBoundingClientRect();
    const er = h.el?.getBoundingClientRect();
    const w = h.host.offsetWidth, ht = h.host.offsetHeight;
    h.size = er
      ? { w, h: ht, lx: (er.left - hr.left) / z, ly: (er.top - hr.top) / z, fw: er.width / z, fh: er.height / z }
      : { w, h: ht, lx: 0, ly: 0, fw: w, fh: ht };
  }

  /** The stage's scale on screen (the canvas zooms with a transform on an ancestor). */
  private zoom(): number {
    return this.getZoom() || 1;
  }

  /** Place every host, size the stage, rebuild the frame index. O(frames log frames). */
  private relayout(): void {
    const page = this.doc?.page(this.page);
    const slots = this.frames.order.map((id) => {
      const h = this.hosts.get(id);
      const n = page?.nodes[id];
      const est = n?.size?.w?.kind === 'fixed' && typeof n.size.w.v === 'number' ? n.size.w.v : 0;
      return { id, at: n?.absolute ? { x: 0, y: 0 } : n?.position, w: h?.size?.w ?? est, h: h?.size?.h ?? 0 };
    });
    const at = placeFrames(slots);
    let minX = 0, minY = 0, maxX = 0, maxY = 0;
    const items: IndexedRect[] = [];
    for (const s of slots) {
      const h = this.hosts.get(s.id);
      const p = at.get(s.id)!;
      if (!h) continue;
      h.x = p.x; h.y = p.y;
      const b = this.bounds(s.id) ?? { x: p.x, y: p.y, w: s.w, h: s.h };
      items.push({ id: s.id, ...b });
      minX = Math.min(minX, b.x, p.x); minY = Math.min(minY, b.y, p.y);
      maxX = Math.max(maxX, b.x + b.w, p.x + s.w); maxY = Math.max(maxY, b.y + b.h, p.y + s.h);
    }
    const ox = minX - STAGE_PAD.left, oy = minY - STAGE_PAD.top;
    const shift = { x: this.originX - ox, y: this.originY - oy };
    this.originX = ox; this.originY = oy;
    for (const h of this.hosts.values()) {
      const t = `translate(${h.x - ox}px, ${h.y - oy}px)`;
      if (h.host.style.transform !== t) h.host.style.transform = t;
    }
    const w = `${Math.ceil(maxX - ox + STAGE_PAD.right)}px`, ht = `${Math.ceil(maxY - oy + STAGE_PAD.bottom)}px`;
    if (this.stage.style.width !== w) this.stage.style.width = w;
    if (this.stage.style.height !== ht) this.stage.style.height = ht;
    this.index = RectIndex.build(items);
    if (this.placedOnce && (shift.x || shift.y) && this.onOriginChange) this.onOriginChange(shift.x, shift.y);
    if (items.length) this.placedOnce = true;
  }

  private schedule(): void {
    if (this.pumping) return;
    this.pumping = window.requestAnimationFrame(() => {
      this.pumping = 0;
      const done = this.pump(this.sliceMs);
      if (this.queue.size) this.schedule();
      if (done.length) this.onMounted?.(done);
    });
  }

  /** Mount queued frames, nearest the view first, until the budget is spent (at least one). */
  private pump(budget: number): string[] {
    const t0 = performance.now();
    const v = this.view;
    const cx = v ? v.x + v.w / 2 : 0, cy = v ? v.y + v.h / 2 : 0;
    const dist = (id: string) => { const b = this.bounds(id); return b ? Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy) : 0; };
    const list = [...this.queue].sort((a, b) => dist(a) - dist(b));
    const done: string[] = [];
    let resized = false;
    for (const id of list) {
      if (done.length && performance.now() - t0 >= budget) break;
      this.queue.delete(id);
      const h = this.hosts.get(id);
      if (!h || !h.parked) continue;
      const before = h.size;
      this.mount(h);
      this.measure(h); // inside the loop, so the budget includes the layout
      if (!before || before.w !== h.size?.w || before.h !== h.size?.h || h.stale) resized = true;
      done.push(id);
    }
    if (resized) this.relayout();
    return done;
  }

  /** Hosts in page order (later frames paint above earlier ones); moves only what is out of place. */
  private placeInOrder(d: FrameDelta): void {
    let cursor: ChildNode | null = this.stage.firstChild;
    for (const id of d.order) {
      const node = this.hosts.get(id)?.host;
      if (!node) continue;
      if (node === cursor) { cursor = cursor.nextSibling; continue; }
      this.stage.insertBefore(node, cursor);
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  }

  private startScenes(id: string, el: Element): void {
    const els = [...(el.matches('.rk-3d') ? [el] : []), ...el.querySelectorAll<HTMLElement>('.rk-3d')] as HTMLElement[];
    if (!els.length) return;
    const list: (() => void)[] = [];
    this.scenes.set(id, list);
    void loadThree().then((L) => {
      if (this.scenes.get(id) !== list) return; // replaced before three loaded
      for (const e of els) {
        if (!e.isConnected) continue;
        try { list.push(mountScene3D(L, e, JSON.parse(e.dataset.scene!) as SceneSpec, { interactive: false })); } catch (err) { console.error(err); }
      }
    }).catch(() => { /* the 3D code did not load: the poster stays */ });
  }

  private stopScenes(id: string): void {
    this.scenes.get(id)?.forEach((d) => d());
    this.scenes.delete(id);
  }
}

/** The live main canvas, for code outside Canvas.tsx that needs layer elements (pickers, drag and drop). */
let live: { canvas: RetainedCanvas; zoom: () => number } | null = null;
export function setLiveCanvas(c: RetainedCanvas | null, zoom: () => number): void {
  live = c ? { canvas: c, zoom } : null;
}
export function liveCanvas(): RetainedCanvas | null {
  return live?.canvas ?? null;
}
/** A layer's element on the main canvas, in whichever frame root holds it. */
export function canvasElement(id: string): HTMLElement | null {
  return live?.canvas.element(id) ?? null;
}
/** Mounted layer elements under a screen point, topmost first. */
export function canvasElementsAt(clientX: number, clientY: number): HTMLElement[] {
  if (!live) return [];
  return live.canvas.elementsAt(clientX, clientY, live.zoom()).reverse();
}
