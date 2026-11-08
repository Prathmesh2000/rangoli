import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { renderCss, renderFragment } from '@rangoli/engine';
import { getState, select, setHover, setZoom, useEditor } from './store';

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

export function Canvas() {
  const version = useEditor((s) => s.version);
  const mode = useEditor((s) => s.mode);
  const zoom = useEditor((s) => s.zoom);
  const selection = useEditor((s) => s.selection);
  const hover = useEditor((s) => s.hover);
  const empty = useEditor((s) => !s.doc || s.doc.page().children.length === 0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [boxes, setBoxes] = useState<{ sel: Box[]; hover: Box | null }>({ sel: [], hover: null });

  // render design into shadow DOM
  useLayoutEffect(() => {
    const host = hostRef.current;
    const doc = getState().doc;
    if (!host || !doc) return;
    const root = (shadowRef.current ??= host.attachShadow({ mode: 'open' }));
    const frag = renderFragment(doc, { editorAttrs: true });
    const css = scopeCss(renderCss(doc, frag.css, frag.usedComponents));
    root.innerHTML = `<style>${css}
:host{display:block;background:transparent!important}
.stage{display:flex;flex-wrap:wrap;gap:64px;align-items:flex-start;padding:64px}
.stage>[data-rid]{background-clip:padding-box}
</style><div class="stage">${frag.html}</div>`;
  }, [version]);

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
    setBoxes({
      sel: selection.map(boxOf).filter((b): b is Box => !!b),
      hover: hover && !selection.includes(hover) ? boxOf(hover) : null,
    });
  };
  useLayoutEffect(measure, [version, selection, hover, zoom, mode]);
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
    </div>
  );
}
