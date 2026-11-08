import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { renderCss, renderFragment, type RangoliDocument } from '@rangoli/engine';
import { clearCompare, getState, select, setHover, setRightTab, setZoom, useEditor } from './store';

/** Render a document into a shadow root (shared by canvas and compare panes). */
function renderInto(root: ShadowRoot, doc: RangoliDocument, extraCss = ''): void {
  const frag = renderFragment(doc, { editorAttrs: true });
  const css = scopeCss(renderCss(doc, frag.css, frag.usedComponents));
  root.innerHTML = `<style>${css}
:host{display:block;background:transparent!important}
.stage{display:flex;flex-wrap:wrap;gap:64px;align-items:flex-start;padding:64px}
.stage{width:max-content}
.stage>[data-rid]{background-clip:padding-box;flex-shrink:0}
.stage [data-rid]:not([data-play]){animation:none!important}
${extraCss}</style><div class="stage">${frag.html}</div>`;
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

/** Scope document-level CSS (:root, body, [data-mode]) to the shadow host. */
function scopeCss(css: string): string {
  return css
    .replace(/:root\b/g, ':host')
    .replace(/\[data-mode="([^"]+)"\]/g, ':host([data-mode="$1"])')
    .replace(/(^|\n)body\{/g, '$1:host{');
}

let liveShadow: ShadowRoot | null = null;

/** Replay a node's enter animation, or play its exit (adds [data-exiting] briefly). */
export function playMotion(id: string, trigger: 'enter' | 'exit', ms = 600): void {
  const el = liveShadow?.querySelector<HTMLElement>(`[data-rid="${id}"]`);
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

/** Play a timeline on the canvas (class .tl-<name> on the stage + unfreeze its targets). */
export function playTimeline(name: string, targets: string[], ms: number): void {
  const stage = liveShadow?.querySelector<HTMLElement>('.stage');
  if (!stage) return;
  const els = targets.map((id) => liveShadow!.querySelector<HTMLElement>(`[data-rid="${id}"]`)).filter((e): e is HTMLElement => !!e);
  stage.classList.remove(`tl-${name}`);
  els.forEach((e) => e.removeAttribute('data-play'));
  void stage.offsetWidth;
  stage.classList.add(`tl-${name}`);
  els.forEach((e) => e.setAttribute('data-play', ''));
  window.setTimeout(() => {
    stage.classList.remove(`tl-${name}`);
    els.forEach((e) => e.removeAttribute('data-play'));
  }, ms + 100);
}

export function Canvas() {
  const version = useEditor((s) => s.version);
  const mode = useEditor((s) => s.mode);
  const zoom = useEditor((s) => s.zoom);
  const selection = useEditor((s) => s.selection);
  const hover = useEditor((s) => s.hover);
  const empty = useEditor((s) => !s.doc || s.doc.page().children.length === 0);
  const threads = useEditor((s) => s.reviews.threads);
  const compare = useEditor((s) => s.compare);

  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [boxes, setBoxes] = useState<{ sel: Box[]; hover: Box | null; pins: Pin[]; start: Box | null }>({ sel: [], hover: null, pins: [], start: null });
  const startId = useEditor((s) => s.doc?.data.prototype?.start ?? null);

  // render design into shadow DOM
  useLayoutEffect(() => {
    const host = hostRef.current;
    const doc = getState().doc;
    if (!host || !doc) return;
    // re-attach when the host element was remounted (e.g. after closing compare view)
    if (!shadowRef.current || shadowRef.current.host !== host) shadowRef.current = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const root = shadowRef.current;
    liveShadow = root;
    renderInto(root, doc);
  }, [version, compare]);

  useLayoutEffect(() => {
    if (mode === 'dark') hostRef.current?.setAttribute('data-mode', 'dark');
    else hostRef.current?.removeAttribute('data-mode');
  }, [mode]);

  // overlay boxes (selection + hover) in scroll-container coordinates
  const measure = () => {
    const root = shadowRef.current;
    const scroll = scrollRef.current;
    const doc = getState().doc;
    if (!root || !scroll || !doc) return;
    const base = scroll.getBoundingClientRect();
    const boxOf = (id: string): Box | null => {
      const el = root.querySelector<HTMLElement>(`[data-rid="${id}"]`);
      const node = doc.findNode(id)?.node;
      if (!el || !node) return null;
      const r = el.getBoundingClientRect();
      return { id, x: r.left - base.left + scroll.scrollLeft, y: r.top - base.top + scroll.scrollTop, w: r.width, h: r.height, label: `${node.name}  ${Math.round(r.width / zoom)}×${Math.round(r.height / zoom)}` };
    };
    // one pin per node with open threads; review findings show their worst severity
    const byNode = new Map<string, { ids: string[]; severity?: string }>();
    for (const t of threads) {
      if (t.resolved || !t.node) continue;
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
    setBoxes({
      sel: selection.map(boxOf).filter((b): b is Box => !!b),
      hover: hover && !selection.includes(hover) ? boxOf(hover) : null,
      pins,
      start: startId ? boxOf(startId) : null,
    });
  };
  useLayoutEffect(measure, [version, selection, hover, zoom, mode, threads, startId]);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(scroll);
    return () => ro.disconnect();
  });

  // zoom to fit: on first content, and whenever requested
  const fitRequest = useEditor((s) => s.fitRequest);
  const fittedOnce = useRef(false);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const stage = shadowRef.current?.querySelector<HTMLElement>('.stage');
    if (!scroll || !stage || empty) return;
    if (fitRequest === 0 && fittedOnce.current) return;
    fittedOnce.current = true;
    const z = getState().zoom;
    const contentW = stage.scrollWidth * z;
    const contentH = stage.scrollHeight * z;
    if (!contentW || !contentH) return;
    const fit = Math.min(scroll.clientWidth / (contentW / z), scroll.clientHeight / (contentH / z));
    // first load: only shrink to fit, never blow small designs up
    setZoom(fitRequest === 0 ? Math.min(1, fit) : Math.min(2, fit));
    scroll.scrollTo(0, 0);
  }, [fitRequest, empty, version]);

  // ctrl/cmd + wheel zoom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(getState().zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [compare]);

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

  return (
    <div className="canvas" ref={scrollRef} onScroll={measure} data-mode={mode}
      onMouseMove={(e) => setHover(idFromEvent(e))}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => {
        e.preventDefault();
        const id = idFromEvent(e);
        if (!id) return select([]);
        const cur = getState().selection;
        select(e.shiftKey ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id]);
      }}
    >
      <div className="canvas-zoom" style={{ transform: `scale(${zoom})` }}>
        <div ref={hostRef} />
      </div>
      {empty && (
        <div className="canvas-empty">
          <p className="canvas-empty-title">This page is empty</p>
          <p>Ask your agent to design a screen, or use <kbd>Insert</kbd> to add a frame.</p>
        </div>
      )}
      {boxes.hover && <div className="ov ov-hover" style={{ left: boxes.hover.x, top: boxes.hover.y, width: boxes.hover.w, height: boxes.hover.h }} />}
      {boxes.sel.map((b) => (
        <div key={b.id} className="ov ov-sel" style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
          <span className="ov-label">{b.label}</span>
        </div>
      ))}
      {boxes.start && (
        <span className="start-badge" style={{ left: boxes.start.x + boxes.start.w, top: boxes.start.y - 24 }} title="Prototype starts on this screen">▶ Start</span>
      )}
      {boxes.pins.map((p) => (
        <button key={p.node} className={`pin${p.severity ? ` pin-${p.severity}` : ''}`} style={{ left: p.x - 10, top: p.y - 10 }}
          aria-label={`${p.count} open ${p.severity ? 'review finding' : 'comment'}${p.count > 1 ? 's' : ''} on #${p.node}`}
          onClick={(e) => {
            e.stopPropagation();
            select([p.node]);
            setRightTab('review', p.id);
          }}>
          {p.count}
        </button>
      ))}
    </div>
  );
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
      if (mode === 'dark') el?.setAttribute('data-mode', 'dark');
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
    <div className="canvas compare" data-mode={mode}>
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
