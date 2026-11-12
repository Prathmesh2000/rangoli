import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { annotationsOf, boundsOf, skinCss, SKIN_DEFS, mountScene3D, renderCss, renderFragment, RectIndex, snapMove, zoomAt, type Gap, type Guide, type IndexedRect, type Rect, type RangoliDocument, type SceneSpec } from '@rangoli/engine';
import { loadThree } from './three';
import { consumeDnd, startLayerDrag } from './dnd';
import { activePageId, canEdit, clearCompare, getState, rdl, select, setActivePage, setHover, setRightTab, setZoom, useEditor, api, sendCursor, leaveCursor } from './store';
import { DrawLayer, consumeDrag, startMove, startResize } from './Draw';
import { FRAME_SCOPE, RetainedCanvas, scopeCss, setLiveCanvas, STAGE_CSS, STAGE_PAD, syncFonts } from './retained';
import { touchedBetween } from './changeFeed';
import { actionFor, canvasHasFocus, isTypingTarget } from './keymap';
import { ShortcutsDialog } from './Shortcuts';

const sceneDisposers = new WeakMap<ShadowRoot, (() => void)[]>();
function mountScenes(root: ShadowRoot): void {
  sceneDisposers.get(root)?.forEach((d) => d());
  sceneDisposers.delete(root);
}
function startScenes(root: ShadowRoot): void {
  const els = [...root.querySelectorAll<HTMLElement>('.rk-3d')];
  if (!els.length) return;
  void loadThree().then((L) => {
    const list: (() => void)[] = [];
    for (const el of els) {
      if (!el.isConnected) continue;
      try { list.push(mountScene3D(L, el, JSON.parse(el.dataset.scene!) as SceneSpec, { interactive: false })); } catch (e) { console.error(e); }
    }
    sceneDisposers.set(root, list);
  }).catch(() => { /* the 3D code did not load: the poster stays */ });
}

/**
 * Render a whole document into a shadow root in one go (compare panes, studios). The main canvas keeps
 * frames retained instead (RetainedCanvas), so an edit there only patches what it touched.
 */
export function renderInto(root: ShadowRoot, doc: RangoliDocument, extraCss = '', extraHtml = ''): void {
  mountScenes(root);
  syncFonts(doc);
  const frag = renderFragment(doc, { editorAttrs: true, assetBase: api('/assets/') });
  const css = scopeCss(renderCss(doc, frag.css, frag.usedComponents));
  root.innerHTML = `<style>${css}
${STAGE_CSS}${extraCss}</style>${extraHtml}<div class="stage">${frag.html}</div>`;
  startScenes(root);
}

interface Pin {
  id: string;
  node: string;
  x: number;
  y: number;
  count: number;
  severity?: string;
}

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

let liveRetained: RetainedCanvas | null = null;

/** Replay a node's enter animation, or play its exit (adds [data-exiting] briefly). */
export function playMotion(id: string, trigger: 'enter' | 'exit', ms = 600): void {
  const el = liveRetained?.element(id);
  if (!el) return;
  // the canvas suppresses enter/exit animations unless [data-play] is set, so editing never replays them
  el.removeAttribute('data-play');
  el.removeAttribute('data-exiting');
  void el.offsetWidth; // reflow so the animation restarts
  el.setAttribute('data-play', '');
  if (trigger === 'exit') el.setAttribute('data-exiting', '');
  window.setTimeout(() => {
    el.removeAttribute('data-play');
    el.removeAttribute('data-exiting');
  }, ms);
}

/** Play a timeline on the canvas: class .tl-<name> on each target's frame element, and unfreeze its targets. */
export function playTimeline(name: string, targets: string[], ms: number): void {
  const c = liveRetained;
  if (!c) return;
  const els = targets.map((id) => c.element(id)).filter((e): e is HTMLElement => !!e);
  const frames = [...new Set(targets.map((id) => c.frameOf(id)).filter((f): f is string => !!f))].map((f) => c.element(f)).filter((e): e is HTMLElement => !!e);
  frames.forEach((f) => f.classList.remove(`tl-${name}`));
  els.forEach((e) => e.removeAttribute('data-play'));
  frames.forEach((f) => void f.offsetWidth);
  frames.forEach((f) => f.classList.add(`tl-${name}`));
  els.forEach((e) => e.setAttribute('data-play', ''));
  window.setTimeout(() => {
    frames.forEach((f) => f.classList.remove(`tl-${name}`));
    els.forEach((e) => e.removeAttribute('data-play'));
  }, ms + 100);
}

const CURSOR_COLORS = ['#2a6fb0', '#b42318', '#1f7a45', '#8a5a00', '#6b3fa0', '#0e7490'];
const colorFor = (id: string) => CURSOR_COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % CURSOR_COLORS.length]!;

/** Teammates' pointers, in design coordinates (drawn in stage space: design minus the stage origin). */
function Cursors({ zoom, origin }: { zoom: number; origin: { x: number; y: number } }) {
  const cursors = useEditor((s) => s.cursors);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 2000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <>
      {Object.entries(cursors).filter(([, c]) => now - c.at < 6000).map(([id, c]) => (
        <div key={id} className="live-cursor" style={{ transform: `translate(${c.x - origin.x}px, ${c.y - origin.y}px) scale(${1 / zoom})`, color: colorFor(id) }} aria-hidden>
          <svg width="16" height="16" viewBox="0 0 16 16"><path d="M1 1l5 14 2-6 6-2z" fill="currentColor" stroke="#fff" strokeWidth="1" /></svg>
          <span style={{ background: colorFor(id) }}>{c.name}</span>
        </div>
      ))}
    </>
  );
}

/** Twelve columns with 24px gutters, drawn over each top-level frame (inside each frame's own root). */
const COL = 'calc((100% - 264px) / 12)';
const GRID_CSS = `${FRAME_SCOPE}{position:relative}${FRAME_SCOPE}::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:50;background:repeating-linear-gradient(90deg,rgba(235,64,52,.1) 0 ${COL},transparent 0 calc(${COL} + 24px))}`;

/** Snap distance on screen, in CSS pixels. */
const SNAP_PX = 6;

/** Frames being moved: hosts follow the pointer, guides and gaps show, one RDL write on release. */
interface FrameDrag { ids: string[]; dx: number; dy: number; guides: Guide[]; gaps: Gap[] }

export function Canvas() {
  const skin = useEditor((s) => s.skin);
  const layoutGrid = useEditor((s) => s.layoutGrid);
  const version = useEditor((s) => s.version);
  const mode = useEditor((s) => s.mode);
  const zoom = useEditor((s) => s.zoom);
  const selection = useEditor((s) => s.selection);
  const hover = useEditor((s) => s.hover);
  const activePage = useEditor((s) => s.activePage);
  const pageId = useEditor(() => activePageId());
  const empty = useEditor((s) => !s.doc || s.doc.page(activePageId()).children.length === 0);
  const threads = useEditor((s) => s.reviews.threads);
  const compare = useEditor((s) => s.compare);
  const tool = useEditor((s) => s.tool);

  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [boxes, setBoxes] = useState<{ sel: Box[]; hover: Box | null; pins: Pin[]; start: Box | null; notes: { n: number; x: number; y: number; node: string }[]; titles: Box[] }>({ sel: [], hover: null, pins: [], start: null, notes: [], titles: [] });
  const [stageSize, setStageSize] = useState({ w: 0, h: 0, ox: 0, oy: 0 });
  const [frameDrag, setFrameDrag] = useState<FrameDrag | null>(null);
  const [panning, setPanning] = useState<'ready' | 'drag' | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [live, setLive] = useState('');
  const startId = useEditor((s) => s.doc?.data.prototype?.start ?? null);

  const retainedRef = useRef<{ canvas: RetainedCanvas; version: number; assetBase: string; page: string | undefined } | null>(null);

  /** Where the stage's top-left sits in the scroll content, in screen pixels. */
  const stageOffset = () => {
    const scroll = scrollRef.current, r = retainedRef.current;
    if (!scroll || !r) return { x: 0, y: 0 };
    const s = r.canvas.stage.getBoundingClientRect(), b = scroll.getBoundingClientRect();
    return { x: s.left - b.left + scroll.scrollLeft, y: s.top - b.top + scroll.scrollTop };
  };
  /** Design pixels to scroll-content pixels (where overlays are drawn). */
  const toScroll = (x: number, y: number, off = stageOffset()) => {
    const o = retainedRef.current?.canvas.origin ?? { x: 0, y: 0 };
    const z = getState().zoom;
    return { x: off.x + (x - o.x) * z, y: off.y + (y - o.y) * z };
  };
  /** The visible area in design pixels. */
  const viewRect = (): Rect | null => {
    const r = retainedRef.current, scroll = scrollRef.current;
    if (!r || !scroll) return null;
    const z = getState().zoom;
    const v = scroll.getBoundingClientRect();
    const p = r.canvas.toDesign(v.left, v.top, z);
    return { x: p.x, y: p.y, w: v.width / z, h: v.height / z };
  };

  /** Mount frames near the viewport, park the rest. */
  const cullNow = () => {
    const r = retainedRef.current;
    const v = viewRect();
    if (r && v) r.canvas.cull(v);
  };

  const syncStageSize = () => {
    const r = retainedRef.current;
    if (!r) return;
    const st = r.canvas.stage.style;
    const next = { w: parseFloat(st.width) || 0, h: parseFloat(st.height) || 0, ox: r.canvas.origin.x, oy: r.canvas.origin.y };
    setStageSize((p) => (p.w === next.w && p.h === next.h && p.ox === next.ox && p.oy === next.oy ? p : next));
  };

  // render design into frame shadow roots: retained frames, patched by what each change touched
  useLayoutEffect(() => {
    const host = hostRef.current;
    const doc = getState().doc;
    if (!host || !doc) return;
    // re-attach when the host element was remounted (e.g. after closing compare view)
    if (!shadowRef.current || shadowRef.current.host !== host) shadowRef.current = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const root = shadowRef.current;
    const assetBase = api('/assets/');
    let r = retainedRef.current;
    if (!r || r.canvas.root !== root || r.assetBase !== assetBase || r.page !== pageId) {
      r?.canvas.dispose();
      const canvas = new RetainedCanvas(root, assetBase, pageId);
      canvas.getZoom = () => getState().zoom;
      // a frame moved further left or up: keep what is on screen where it was
      canvas.onOriginChange = (dx, dy) => {
        const scroll = scrollRef.current;
        if (!scroll) return;
        const z = getState().zoom;
        scroll.scrollLeft += dx * z;
        scroll.scrollTop += dy * z;
      };
      canvas.onMounted = () => { syncStageSize(); measureRef.current(); };
      r = retainedRef.current = { canvas, version: -1, assetBase, page: pageId };
      liveRetained = canvas;
      setLiveCanvas(canvas, () => getState().zoom);
      exposeForChecks(canvas);
    }
    r.canvas.setMode(mode);
    r.canvas.setEditorCss(skinCss(skin, FRAME_SCOPE) + (layoutGrid ? GRID_CSS : ''), skin === 'sketch' ? SKIN_DEFS : '');
    if (r.version !== version) {
      r.canvas.update(doc, r.version < 0 ? null : touchedBetween(r.version, version));
      r.version = version;
    }
    syncStageSize();
  }, [version, compare, skin, layoutGrid, pageId, mode]);

  useEffect(() => () => { retainedRef.current?.canvas.dispose(); setLiveCanvas(null, () => 1); liveRetained = null; }, []);

  // cull after every patch and whenever the view can have changed
  useLayoutEffect(() => { cullNow(); }, [version, compare, skin, layoutGrid, mode, zoom, pageId]);

  // overlay boxes (selection, hover, pins, frame titles) in scroll-content coordinates
  const measure = () => {
    const scroll = scrollRef.current;
    const r = retainedRef.current;
    const doc = getState().doc;
    if (!scroll || !doc || !r) return;
    const base = scroll.getBoundingClientRect();
    const off = stageOffset();
    const z = getState().zoom;
    const boxOf = (id: string): Box | null => {
      const node = doc.findNode(id)?.node;
      if (!node) return null;
      const el = r.canvas.element(id);
      if (el) {
        const b = el.getBoundingClientRect();
        return { id, x: b.left - base.left + scroll.scrollLeft, y: b.top - base.top + scroll.scrollTop, w: b.width, h: b.height, label: `${node.name}  ${Math.round(b.width / z)}×${Math.round(b.height / z)}` };
      }
      const fb = r.canvas.bounds(id); // a parked frame still has its bounds
      if (!fb) return null;
      const p = toScroll(fb.x, fb.y, off);
      return { id, x: p.x, y: p.y, w: fb.w * z, h: fb.h * z, label: `${node.name}  ${Math.round(fb.w)}×${Math.round(fb.h)}` };
    };
    // one pin per node with open threads; review findings show their worst severity
    const byNode = new Map<string, { ids: string[]; severity?: string }>();
    for (const t of threads) {
      if (t.resolved || !t.node || t.kind === 'annotation') continue;
      const e = byNode.get(t.node) ?? { ids: [] };
      e.ids.push(t.id);
      if (t.kind === 'review' && t.severity && (!e.severity || t.severity < e.severity)) e.severity = t.severity;
      byNode.set(t.node, e);
    }
    const pins: Pin[] = [];
    for (const [node, e] of byNode) {
      const b = boxOf(node);
      if (b) pins.push({ id: e.ids[0]!, node, x: b.x + b.w, y: b.y, count: e.ids.length, severity: e.severity });
    }
    // frame titles: only for frames near the view, so a 50k-layer page keeps a small overlay
    const v = viewRect();
    const titles: Box[] = [];
    if (v) {
      const page = doc.page(activePageId());
      for (const id of r.canvas.frameIndex.search(v.x - v.w / 2, v.y - v.h / 2, v.x + 1.5 * v.w, v.y + 1.5 * v.h)) {
        const fb = r.canvas.bounds(id), n = page.nodes[id];
        if (!fb || !n) continue;
        const p = toScroll(fb.x, fb.y, off);
        titles.push({ id, x: p.x, y: p.y, w: fb.w * z, h: fb.h * z, label: n.name });
      }
    }
    setBoxes({
      sel: selection.map(boxOf).filter((b): b is Box => !!b),
      hover: hover && !selection.includes(hover) ? boxOf(hover) : null,
      pins,
      start: startId ? boxOf(startId) : null,
      notes: annotationsOf(getState().reviews).flatMap((a, i, all) => {
        const b = boxOf(a.node);
        const before = all.slice(0, i).filter((x) => x.node === a.node).length;
        return b ? [{ n: a.n, node: a.node, x: b.x + before * 22, y: b.y }] : [];
      }),
      titles,
    });
  };
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useLayoutEffect(measure, [version, selection, hover, zoom, mode, threads, startId, skin, stageSize, pageId]);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const ro = new ResizeObserver(() => { measureRef.current(); cullNow(); });
    ro.observe(scroll);
    return () => ro.disconnect();
  }, [compare]);
  const scrollFrame = useRef(0);
  const onScroll = () => {
    // one overlay pass and one cull per animation frame, however many scroll events arrive
    if (!scrollFrame.current) scrollFrame.current = requestAnimationFrame(() => { scrollFrame.current = 0; cullNow(); measureRef.current(); });
  };

  // ---------------------------------------------------------------- zoom (to cursor) and fit

  const zoomAnchor = useRef<{ x: number; y: number } | null>(null);
  const pendingView = useRef<{ x: number; y: number } | null>(null);
  const prevZoom = useRef(zoom);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const from = prevZoom.current;
    prevZoom.current = zoom;
    if (!scroll) return;
    if (pendingView.current) {
      const p = toScroll(pendingView.current.x, pendingView.current.y);
      pendingView.current = null;
      scroll.scrollTo(Math.max(0, p.x), Math.max(0, p.y));
      return;
    }
    if (from === zoom) return;
    // keep the point under the cursor (or the view's centre, for buttons and keys) where it is
    const cursor = zoomAnchor.current ?? { x: scroll.clientWidth / 2, y: scroll.clientHeight / 2 };
    zoomAnchor.current = null;
    const next = zoomAt({ x: scroll.scrollLeft, y: scroll.scrollTop }, cursor, from, zoom);
    scroll.scrollTo(next.x, next.y);
  }, [zoom]);

  // zoom to fit: on first content, and whenever requested
  const fitRequest = useEditor((s) => s.fitRequest);
  const fittedOnce = useRef(false);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const r = retainedRef.current;
    if (!scroll || !r || empty) return;
    if (fitRequest === 0 && fittedOnce.current) return;
    const items: Rect[] = r.canvas.order.map((id) => r.canvas.bounds(id)).filter((b): b is Rect => !!b);
    const b = boundsOf(items);
    if (!b || !b.w || !b.h) return;
    fittedOnce.current = true;
    const pad = 48;
    const fit = Math.min((scroll.clientWidth - 2 * pad) / b.w, (scroll.clientHeight - 2 * pad) / b.h);
    // first load: only shrink to fit, never blow small designs up
    const z = Math.max(0.1, fitRequest === 0 ? Math.min(1, fit) : Math.min(2, fit));
    pendingView.current = { x: b.x - pad / z, y: b.y - pad / z };
    if (Math.abs(z - getState().zoom) < 0.005) {
      const p = toScroll(pendingView.current.x, pendingView.current.y);
      pendingView.current = null;
      scroll.scrollTo(Math.max(0, p.x), Math.max(0, p.y));
    } else setZoom(z);
  }, [fitRequest, empty, version, pageId]);

  // ctrl/cmd + wheel (and trackpad pinch, which arrives as ctrl + wheel) zooms at the cursor
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain wheel and two-finger scroll pan natively
      e.preventDefault();
      const b = el.getBoundingClientRect();
      zoomAnchor.current = { x: e.clientX - b.left, y: e.clientY - b.top };
      const step = Math.min(0.5, Math.abs(e.deltaY) / 300) || 0.1;
      setZoom(getState().zoom * (e.deltaY < 0 ? 1 + step : 1 / (1 + step)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [compare]);

  // ---------------------------------------------------------------- pan: Space + drag, middle mouse

  const spaceHeld = useRef(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (actionFor(e) !== 'pan' || !canvasHasFocus() || isTypingTarget(e) || e.repeat) return;
      e.preventDefault();
      spaceHeld.current = true;
      setPanning((p) => p ?? 'ready');
    };
    const up = (e: KeyboardEvent) => {
      if (actionFor(e) !== 'pan') return;
      spaceHeld.current = false;
      setPanning((p) => (p === 'ready' ? null : p));
    };
    const blur = () => { spaceHeld.current = false; setPanning(null); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, []);
  const beginPan = (e: React.PointerEvent) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, l0 = scroll.scrollLeft, t0 = scroll.scrollTop;
    setPanning('drag');
    const move = (ev: PointerEvent) => { scroll.scrollLeft = l0 - (ev.clientX - sx); scroll.scrollTop = t0 - (ev.clientY - sy); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      suppressClick.current = true;
      setPanning(spaceHeld.current ? 'ready' : null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---------------------------------------------------------------- marquee

  // a drag on empty canvas selects frames; a drag on a frame's own background selects its layers
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const suppressClick = useRef(false);
  const beginMarquee = (e: React.PointerEvent, frame: string | undefined) => {
    const sx = e.clientX, sy = e.clientY, additive = e.shiftKey;
    let active = false;
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      active = true;
      setMarquee({ x0: sx, y0: sy, x1: ev.clientX, y1: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setMarquee(null);
      const r = retainedRef.current;
      if (!active || !r) return;
      suppressClick.current = true;
      const z = getState().zoom;
      const a = r.canvas.toDesign(sx, sy, z), b = r.canvas.toDesign(ev.clientX, ev.clientY, z);
      const ids = frame ? marqueeLayers(r.canvas, frame, z, a.x, a.y, b.x, b.y) : marqueeFrames(r.canvas, a.x, a.y, b.x, b.y);
      const cur = getState().selection;
      const next = additive ? [...cur, ...ids.filter((id) => !cur.includes(id))] : ids;
      select(next);
      setLive(`${next.length} selected`);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---------------------------------------------------------------- moving frames (free placement)

  /**
   * Drag top-level frames. Hosts move with the pointer (no re-render), snapping to other frames' edges and
   * centres; guides and distances show; one RDL write on release. A page whose frames still flow gets every
   * frame's current place written too, so nothing else shifts when one frame leaves the row.
   */
  const beginFrameMove = (e: React.PointerEvent, ids: string[]) => {
    const r = retainedRef.current;
    if (!r || !canEdit()) return;
    e.stopPropagation();
    const c = r.canvas;
    const start = ids.map((id) => c.bounds(id)).filter((b): b is Rect => !!b);
    const box = boundsOf(start);
    if (!box) return;
    const others: Rect[] = c.order.filter((id) => !ids.includes(id)).map((id) => c.bounds(id)).filter((b): b is Rect => !!b);
    const hosts = ids.map((id) => c.frameRoot(id)?.host as HTMLElement | undefined).filter((h): h is HTMLElement => !!h);
    const sx = e.clientX, sy = e.clientY;
    let moved = false, last = { dx: 0, dy: 0 };
    const move = (ev: PointerEvent) => {
      const z = getState().zoom;
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true;
      const raw = { dx: (ev.clientX - sx) / z, dy: (ev.clientY - sy) / z };
      const s = ev.altKey ? { dx: raw.dx, dy: raw.dy, guides: [], gaps: [] } : snapMove(box, raw.dx, raw.dy, others, SNAP_PX / z);
      last = { dx: s.dx, dy: s.dy };
      for (const h of hosts) h.style.translate = `${s.dx}px ${s.dy}px`;
      setFrameDrag({ ids, dx: s.dx, dy: s.dy, guides: s.guides, gaps: s.gaps });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      for (const h of hosts) h.style.translate = '';
      setFrameDrag(null);
      if (!moved) return;
      suppressClick.current = true;
      void moveFrames(c, ids, Math.round(last.dx), Math.round(last.dy));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---------------------------------------------------------------- double-click: edit text in place

  const editText = (id: string) => {
    const r = retainedRef.current;
    const doc = getState().doc;
    const node = doc?.findNode(id)?.node;
    const el = r?.canvas.element(id);
    if (!el || !node || node.type !== 'text' || !canEdit()) return false;
    const before = el.innerHTML;
    el.setAttribute('contenteditable', 'plaintext-only');
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-label', `Edit text of ${node.name}`);
    el.focus();
    const sel = (el.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() ?? window.getSelection();
    sel?.selectAllChildren(el);
    setLive(`Editing ${node.name}. Enter to save, Shift+Enter for a new line, Escape to cancel.`);
    const finish = (commit: boolean) => {
      el.removeEventListener('keydown', key, true);
      el.removeEventListener('blur', blur);
      const text = el.innerText.replace(/\n$/, '');
      el.removeAttribute('contenteditable');
      el.removeAttribute('role');
      el.removeAttribute('aria-label');
      if (commit && text !== (node.text ?? '')) void rdl(`set #${id} ${JSON.stringify(text)}`, 'edit text');
      else el.innerHTML = before;
      scrollRef.current?.focus({ preventScroll: true });
    };
    const key = (ev: KeyboardEvent) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      else if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); }
    };
    const blur = () => finish(true);
    el.addEventListener('keydown', key, true);
    el.addEventListener('blur', blur);
    return true;
  };
  useEffect(() => {
    // the keyboard path to the same thing: Enter (remappable) on a selected text layer, from App's shortcuts
    const onEdit = (e: Event) => { const id = (e as CustomEvent<string>).detail; if (id) editText(id); };
    window.addEventListener('rangoli:edit-text', onEdit);
    const onKeys = () => setShortcutsOpen(true);
    window.addEventListener('rangoli:shortcuts', onKeys);
    const onPan = (e: Event) => {
      const { dx, dy } = (e as CustomEvent<{ dx: number; dy: number }>).detail;
      scrollRef.current?.scrollBy(dx, dy);
    };
    window.addEventListener('rangoli:pan', onPan);
    return () => { window.removeEventListener('rangoli:edit-text', onEdit); window.removeEventListener('rangoli:shortcuts', onKeys); window.removeEventListener('rangoli:pan', onPan); };
  }, []);

  const idFromEvent = (e: React.MouseEvent): string | null => {
    for (const t of e.nativeEvent.composedPath()) {
      if (t instanceof HTMLElement || t instanceof SVGElement) {
        const id = t.getAttribute('data-rid');
        if (id) return id;
      }
      if (t === hostRef.current) break;
    }
    return null;
  };

  if (compare) return <CompareView />;

  const off = scrollRef.current && retainedRef.current ? stageOffset() : { x: 0, y: 0 };
  const sp = (x: number, y: number) => {
    const o = retainedRef.current?.canvas.origin ?? { x: 0, y: 0 };
    return { x: off.x + (x - o.x) * zoom, y: off.y + (y - o.y) * zoom };
  };
  const dragBox = frameDrag && boundsOf(frameDrag.ids.map((id) => retainedRef.current?.canvas.bounds(id)).filter((b): b is Rect => !!b));
  const editable = canEdit();
  void tool;

  return (
    <div className={`canvas${panning ? ' is-panning' : ''}${panning === 'drag' ? ' is-grabbing' : ''}`} ref={scrollRef} onScroll={onScroll} data-mode={mode}
      data-region="canvas" tabIndex={0} role="region" aria-label="Canvas. Arrow keys move the selection or pan; F6 moves to the next region; ? lists shortcuts."
      aria-describedby="canvas-live"
      onMouseMove={(e) => {
        if (panning) return;
        setHover(idFromEvent(e));
        const r = retainedRef.current;
        if (r) { const p = r.canvas.toDesign(e.clientX, e.clientY, zoom); sendCursor(p.x, p.y); }
      }}
      onMouseLeave={() => { setHover(null); leaveCursor(); }}
      onPointerDown={(e) => {
        if (e.button === 1 || (e.button === 0 && spaceHeld.current)) return beginPan(e);
        // drag a selected free-floating layer to move it
        if (e.button !== 0 || getState().tool !== 'select') return;
        const id = idFromEvent(e as unknown as React.MouseEvent);
        const cur = getState();
        const page = cur.doc?.page(activePageId());
        const node = id ? cur.doc?.findNode(id)?.node : undefined;
        // a selected top-level frame moves when dragged by its body (an unselected one starts a layer marquee)
        if (node && !node.parent && page?.nodes[node.id] && cur.selection.includes(node.id) && canEdit()) {
          return beginFrameMove(e, cur.selection.filter((s) => page.nodes[s] && !page.nodes[s]!.parent));
        }
        const free = !!node && !!(node.absolute || (node.parent && cur.doc!.node(node.parent).layout?.mode === 'none'));
        if (!node || (!node.parent && !free)) return beginMarquee(e, node?.id);
        if (!canEdit()) return;
        const el = retainedRef.current?.canvas.element(node.id);
        if (free && el) startMove(e, el, node.id, node.position?.x ?? 0, node.position?.y ?? 0, zoom);
        else if (el && node.parent) startLayerDrag(e, node, el);
      }}
      onClick={(e) => {
        e.preventDefault();
        if (consumeDrag() || consumeDnd()) return;
        if (suppressClick.current) { suppressClick.current = false; return; }
        const id = idFromEvent(e);
        if (!id) return select([]);
        const cur = getState().selection;
        select(e.shiftKey ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id]);
      }}
      onDoubleClick={(e) => {
        const id = idFromEvent(e);
        if (id && editText(id)) { e.preventDefault(); return; }
        // double-click a layer inside a frame: select it directly (one level per click otherwise)
        if (id) select([id]);
      }}
    >
      <div className="canvas-size" style={{ width: Math.max(stageSize.w * zoom, 1), height: Math.max(stageSize.h * zoom, 1) }}>
        <div className="canvas-zoom" style={{ transform: `scale(${zoom})` }}>
          <Cursors zoom={zoom} origin={{ x: stageSize.ox, y: stageSize.oy }} />
          <div ref={hostRef} />
        </div>
      </div>
      {empty && (
        <div className="canvas-empty">
          <p className="canvas-empty-title">This page is empty</p>
          <p>Ask your agent to design a screen, or use <kbd>Insert</kbd> to add a frame.</p>
        </div>
      )}
      {boxes.titles.map((t) => (
        <div key={t.id} className={`frame-title${selection.includes(t.id) ? ' is-sel' : ''}`} style={{ left: t.x, top: t.y - 26, maxWidth: Math.max(48, t.w) }}
          onPointerDown={(e) => {
            if (e.button !== 0 || spaceHeld.current) return;
            e.stopPropagation();
            const cur = getState().selection;
            const ids = cur.includes(t.id) ? cur.filter((s) => getState().doc?.page(activePageId()).nodes[s] && !getState().doc?.findNode(s)?.node.parent) : [t.id];
            if (!cur.includes(t.id)) select(e.shiftKey ? [...cur, t.id] : [t.id]);
            if (editable) beginFrameMove(e, ids);
          }}
          onClick={(e) => { e.stopPropagation(); if (suppressClick.current) { suppressClick.current = false; } }}
          title={editable ? `${t.label}: drag to move, or select and use arrow keys` : t.label}
          aria-hidden>
          {t.label}{frameDrag?.ids.includes(t.id) ? `  ${Math.round((retainedRef.current?.canvas.bounds(t.id)?.x ?? 0) + frameDrag.dx)}, ${Math.round((retainedRef.current?.canvas.bounds(t.id)?.y ?? 0) + frameDrag.dy)}` : ''}
        </div>
      ))}
      {marquee && scrollRef.current && (
        <div className="ov ov-marquee" style={{
          left: Math.min(marquee.x0, marquee.x1) - scrollRef.current.getBoundingClientRect().left + scrollRef.current.scrollLeft,
          top: Math.min(marquee.y0, marquee.y1) - scrollRef.current.getBoundingClientRect().top + scrollRef.current.scrollTop,
          width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0),
          boxShadow: '0 0 0 1px var(--sel)', background: 'color-mix(in srgb, var(--sel) 10%, transparent)',
        }} />
      )}
      {boxes.hover && !frameDrag && <div className="ov ov-hover" style={{ left: boxes.hover.x, top: boxes.hover.y, width: boxes.hover.w, height: boxes.hover.h }} />}
      {boxes.sel.map((b) => {
        const moving = frameDrag?.ids.includes(b.id);
        return (
          <div key={b.id} className="ov ov-sel" style={{ left: b.x + (moving ? frameDrag!.dx * zoom : 0), top: b.y + (moving ? frameDrag!.dy * zoom : 0), width: b.w, height: b.h }}>
            {!boxes.titles.some((t) => t.id === b.id) && <span className="ov-label">{b.label}</span>}
            {boxes.sel.length === 1 && editable && !moving && (
              <span className="ov-grip" title="Drag to resize, or set W and H in Inspect" onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => {
                  const el = retainedRef.current?.canvas.element(b.id);
                  if (el) startResize(e, el, b.id, zoom, getState().doc?.findNode(b.id)?.node.type === 'text');
                }} />
            )}
          </div>
        );
      })}
      {frameDrag && dragBox && (
        <svg className="guides" aria-hidden style={{ width: scrollRef.current?.scrollWidth, height: scrollRef.current?.scrollHeight }}>
          {frameDrag.guides.map((g, i) => {
            const a = g.axis === 'x' ? sp(g.at, g.from) : sp(g.from, g.at), b = g.axis === 'x' ? sp(g.at, g.to) : sp(g.to, g.at);
            return <line key={`g${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="guide-line" />;
          })}
          {frameDrag.gaps.map((g, i) => {
            const a = g.axis === 'x' ? sp(g.from, g.at) : sp(g.at, g.from), b = g.axis === 'x' ? sp(g.to, g.at) : sp(g.at, g.to);
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            return (
              <g key={`d${i}`}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="gap-line" />
                <rect x={mx - 20} y={my - 9} width={40} height={18} rx={4} className="gap-tag" />
                <text x={mx} y={my + 4} className="gap-text">{Math.round(g.size)}</text>
              </g>
            );
          })}
        </svg>
      )}
      {boxes.start && (
        <span className="start-badge" style={{ left: boxes.start.x + boxes.start.w, top: boxes.start.y - 24 }} title="Prototype starts on this screen">▶ Start</span>
      )}
      <DrawLayer scroll={scrollRef.current} />
      {boxes.notes.map((n) => (
        <button key={n.n} className="note-pin" style={{ left: n.x - 12, top: n.y - 12 }} aria-label={`Note ${n.n} on #${n.node}`} onClick={(e) => { e.stopPropagation(); select([n.node]); setRightTab('notes'); }}>{n.n}</button>
      ))}
      {boxes.pins.map((p) => (
        <button key={p.node} className={`pin${p.severity ? ` pin-${p.severity}` : ''}`} style={{ left: p.x - 12, top: p.y - 12 }}
          aria-label={`${p.count} open ${p.severity ? 'review finding' : 'comment'}${p.count > 1 ? 's' : ''} on #${p.node}`}
          onClick={(e) => {
            e.stopPropagation();
            select([p.node]);
            setRightTab('review', p.id);
          }}>
          {p.count}
        </button>
      ))}
      <PageBar activePage={activePage} />
      <span className="sr-only" id="canvas-live" aria-live="polite">{live}</span>
      {shortcutsOpen && <ShortcutsDialog onClose={() => { setShortcutsOpen(false); scrollRef.current?.focus({ preventScroll: true }); }} />}
    </div>
  );
}

/**
 * Write new positions for moved frames. Frames still flowing in the row get their current place written as
 * well, so the page becomes freely placed in one undoable step and nothing else moves.
 */
export async function moveFrames(c: RetainedCanvas, ids: string[], dx: number, dy: number): Promise<void> {
  const doc = getState().doc;
  if (!doc || (!dx && !dy)) return;
  const page = doc.page(activePageId());
  const lines: string[] = [];
  for (const id of c.order) {
    const n = page.nodes[id];
    const b = c.bounds(id);
    if (!n || !b || n.absolute) continue;
    const at = n.position ?? { x: Math.round(b.x), y: Math.round(b.y) };
    if (ids.includes(id)) lines.push(`set #${id} at:${Math.round(at.x + dx)},${Math.round(at.y + dy)}`);
    else if (!n.position) lines.push(`set #${id} at:${at.x},${at.y}`);
  }
  if (lines.length) await rdl(lines.join('\n'), ids.length === 1 ? `move ${page.nodes[ids[0]!]?.name ?? 'frame'}` : `move ${ids.length} frames`);
}

/** Pages of the document, with the one on the canvas. Other pages load when opened. */
function PageBar({ activePage }: { activePage: string | null }) {
  const pages = useEditor((s) => s.doc?.data.manifest.pages ?? []);
  if (pages.length < 2) return null;
  const current = activePage ?? pages[0]!.id;
  return (
    <div className="page-bar" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <label htmlFor="page-select" className="page-bar-label">Page</label>
      <select id="page-select" className="input" value={current} onChange={(e) => void setActivePage(e.target.value)}>
        {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {activePage && <span className="page-bar-note" role="note">Read only: edits apply to the first page for now</span>}
    </div>
  );
}

/** Top-level frames the marquee touches, in page order. */
function marqueeFrames(canvas: RetainedCanvas, x0: number, y0: number, x1: number, y1: number): string[] {
  const hit = new Set(canvas.frameIndex.search(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)));
  return canvas.order.filter((id) => hit.has(id));
}

/**
 * Layers of one frame the marquee touches. The frame's direct children are indexed from layout when the
 * drag ends (one getBoundingClientRect each, after a single layout), then queried.
 */
function marqueeLayers(canvas: RetainedCanvas, frame: string, zoom: number, x0: number, y0: number, x1: number, y1: number): string[] {
  const doc = getState().doc;
  const root = canvas.frameRoot(frame);
  if (!doc || !root) return [];
  const items: IndexedRect[] = [];
  for (const el of root.querySelectorAll<HTMLElement | SVGElement>('[data-rid]')) {
    const id = el.getAttribute('data-rid')!;
    if (doc.findNode(id)?.node.parent !== frame) continue;
    const r = el.getBoundingClientRect();
    const p = canvas.toDesign(r.left, r.top, zoom);
    items.push({ id, x: p.x, y: p.y, w: r.width / zoom, h: r.height / zoom });
  }
  const hit = new Set(RectIndex.build(items).search(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)));
  return (doc.findNode(frame)?.node.children ?? []).filter((id) => hit.has(id));
}

/** `?debug=canvas` exposes the retained canvas so headless checks can compare it with a full render. */
function exposeForChecks(canvas: RetainedCanvas): void {
  try {
    if (new URLSearchParams(location.search).get('debug') === 'canvas') (window as unknown as { __rangoliCanvas?: RetainedCanvas; __rangoliPad?: typeof STAGE_PAD }).__rangoliCanvas = canvas;
  } catch { /* no location: nothing to expose */ }
}

/** Side-by-side before/after with change highlights. */
function CompareView() {
  const compare = useEditor((s) => s.compare)!;
  const mode = useEditor((s) => s.mode);
  const beforeRef = useRef<HTMLDivElement>(null);
  const afterRef = useRef<HTMLDivElement>(null);
  const roots = useRef<{ b?: ShadowRoot; a?: ShadowRoot }>({});
  const [layout, setLayout] = useState<'side' | 'stacked'>('side');
  useLayoutEffect(() => {
    const hl = (ids: string[], color: string) => ids.map((id) => `[data-rid="${id}"]{outline:2px solid ${color}!important;outline-offset:2px}`).join('');
    const d = compare.diff;
    const pad = '.stage{padding:24px}';
    if (beforeRef.current) {
      const r = (roots.current.b ??= beforeRef.current.shadowRoot ?? beforeRef.current.attachShadow({ mode: 'open' }));
      renderInto(r, compare.before, pad + hl(d.removed, '#d63c3c') + hl(d.changed.map((c) => c.id), '#d9900f'));
    }
    if (afterRef.current) {
      const r = (roots.current.a ??= afterRef.current.shadowRoot ?? afterRef.current.attachShadow({ mode: 'open' }));
      renderInto(r, compare.after, pad + hl(d.added, '#2f9e57') + hl(d.changed.map((c) => c.id), '#d9900f'));
    }
    for (const el of [beforeRef.current, afterRef.current]) {
      if (mode !== 'light') el?.setAttribute('data-mode', mode);
      else el?.removeAttribute('data-mode');
    }
    // fit each pane to its width so every change is visible (both panes share one scale)
    const fit = () => {
      const stages = [roots.current.b, roots.current.a].map((r) => r?.querySelector<HTMLElement>('.stage'));
      const pane = beforeRef.current?.closest('section');
      if (!pane || stages.some((s) => !s)) return;
      const w = Math.max(...stages.map((s) => s!.scrollWidth));
      const s = Math.min(1, (pane.clientWidth - 8) / w);
      for (const [i, ref] of [beforeRef, afterRef].entries()) {
        const wrap = ref.current?.parentElement;
        const stage = stages[i]!;
        if (!wrap) continue;
        wrap.style.transform = `scale(${s})`;
        wrap.style.width = `${stage.scrollWidth}px`;
        wrap.style.height = `${stage.scrollHeight}px`;
        wrap.style.marginBottom = `${-(1 - s) * stage.scrollHeight}px`;
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    const pane = beforeRef.current?.closest('section');
    if (pane) ro.observe(pane);
    return () => ro.disconnect();
  }, [compare, mode, layout]);
  const d = compare.diff;
  const summary = [d.added.length && `${d.added.length} added`, d.removed.length && `${d.removed.length} removed`, d.changed.length && `${d.changed.length} changed`, d.tokens && 'tokens', d.motion.length && `${d.motion.length} motion`].filter(Boolean).join(' · ') || 'no differences';
  return (
    <div className="canvas compare" data-mode={mode} data-region="canvas" tabIndex={0} role="region" aria-label="Compare">
      <div className="compare-bar">
        <strong>{compare.label}</strong>
        <span className="hint">{summary}</span>
        <span className="legend"><i className="lg-add" /> added <i className="lg-chg" /> changed <i className="lg-rem" /> removed</span>
        <div className="seg seg-sm" role="radiogroup" aria-label="Compare layout" style={{ marginLeft: 'auto' }}>
          <button role="radio" aria-checked={layout === 'side'} className="seg-item" onClick={() => setLayout('side')}>Side by side</button>
          <button role="radio" aria-checked={layout === 'stacked'} className="seg-item" onClick={() => setLayout('stacked')}>Stacked</button>
        </div>
        <button className="btn" onClick={clearCompare}>Close compare</button>
      </div>
      <div className={`compare-panes${layout === 'stacked' ? ' is-stacked' : ''}`}>
        <section><h6>Before</h6><div className="compare-scale"><div ref={beforeRef} /></div></section>
        <section><h6>After</h6><div className="compare-scale"><div ref={afterRef} /></div></section>
      </div>
    </div>
  );
}
