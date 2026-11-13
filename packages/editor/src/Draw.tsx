import { useEffect, useRef, useState } from 'react';
import type { RangoliDocument } from '@rangoli/engine';
import { canEdit, getState, rdl, select, setTool, useEditor, type Tool } from './store';
import { snapper } from './dnd';
import { canvasElementsAt } from './retained';
import { shortcutLabel, useKeymap, type Action } from './keymap';

/**
 * Drawing tools. Everything drawn becomes ordinary RDL (absolute layers, pen paths via d:"…"), so a
 * shape a human draws is exactly what an agent could have written, and stays editable by both.
 */

const ICONS: Record<Tool, React.ReactNode> = {
  select: <path d="M5 3l6 16 2.5-6.5L20 10z" />,
  frame: <path d="M7 3v18M17 3v18M3 7h18M3 17h18" />,
  rect: <rect x="4" y="5" width="16" height="14" rx="1.5" />,
  ellipse: <ellipse cx="12" cy="12" rx="8.5" ry="7" />,
  line: <path d="M5 19L19 5" />,
  pen: <path d="M12 3l5 9-5 8-5-8zM12 3v9M9 21h6" />,
  text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
};
const TOOLS: { id: Tool; name: string }[] = [
  { id: 'select', name: 'Select and move' },
  { id: 'frame', name: 'Frame: drag, or click for 320 by 240' },
  { id: 'rect', name: 'Rectangle: drag, or click for 120 by 120' },
  { id: 'ellipse', name: 'Ellipse: drag, or click for 120 by 120' },
  { id: 'line', name: 'Line: drag, or click for 120 long' },
  { id: 'pen', name: 'Pen: click for corners, drag for curves, Enter to finish' },
  { id: 'text', name: 'Text: click to place' },
];

export function DrawTools() {
  const tool = useEditor((s) => s.tool);
  const compare = useEditor((s) => s.compare);
  useEditor((s) => s.role);
  useEditor((s) => s.activePage);
  useKeymap();
  if (!canEdit() || compare) return null;
  return (
    <div className="draw-tools" role="toolbar" aria-label="Drawing tools" aria-orientation="vertical">
      {TOOLS.map((t) => (
        <button key={t.id} className="draw-tool" aria-pressed={tool === t.id} aria-label={t.name} aria-keyshortcuts={shortcutLabel(`tool.${t.id}` as Action) || undefined} title={`${t.name}${shortcutLabel(`tool.${t.id}` as Action) ? ` (${shortcutLabel(`tool.${t.id}` as Action)})` : ''}`} onClick={() => setTool(t.id)}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{ICONS[t.id]}</svg>
        </button>
      ))}
    </div>
  );
}

interface Target { id: string | null; left: number; top: number }

/** Deepest frame under a screen point: drawn layers go inside it, in its own coordinates. */
function containerAt(doc: RangoliDocument, cx: number, cy: number): Target {
  // only the frames under the point are searched (frame index), each in its own shadow root
  for (const el of canvasElementsAt(cx, cy)) {
    const r = el.getBoundingClientRect();
    if (!r.width || cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
    const node = doc.findNode(el.getAttribute('data-rid')!)?.node;
    if (node?.type === 'frame' || node?.type === 'group') return { id: node.id, left: r.left, top: r.top };
  }
  return { id: null, left: cx, top: cy };
}

interface Pt { x: number; y: number; hx: number; hy: number }
const n1 = (v: number) => Math.round(v * 10) / 10;

function penPath(pts: Pt[], closed: boolean, dx = 0, dy = 0): string {
  if (!pts.length) return '';
  const X = (v: number) => n1(v + dx), Y = (v: number) => n1(v + dy);
  let d = `M${X(pts[0]!.x)} ${Y(pts[0]!.y)}`;
  const seg = (a: Pt, b: Pt) => {
    d += a.hx || a.hy || b.hx || b.hy
      ? ` C${X(a.x + a.hx)} ${Y(a.y + a.hy)} ${X(b.x - b.hx)} ${Y(b.y - b.hy)} ${X(b.x)} ${Y(b.y)}`
      : ` L${X(b.x)} ${Y(b.y)}`;
  };
  for (let i = 1; i < pts.length; i++) seg(pts[i - 1]!, pts[i]!);
  if (closed && pts.length > 2) { seg(pts[pts.length - 1]!, pts[0]!); d += ' Z'; }
  return d;
}

async function place(target: Target, line: string, at: string, label: string) {
  const script = target.id ? `insert #${target.id} end\n  ${line} abs at:${at}` : line;
  const res = await rdl(script, label);
  if (res?.created[0]) select([res.created[0]]);
  setTool('select');
}

export function DrawLayer({ scroll }: { scroll: HTMLDivElement | null }) {
  const tool = useEditor((s) => s.tool);
  const zoom = useEditor((s) => s.zoom);
  const [drag, setDrag] = useState<{ t: Target; sx: number; sy: number; cx: number; cy: number; shift: boolean } | null>(null);
  const [pen, setPen] = useState<{ t: Target; pts: Pt[]; handle: boolean; mx: number; my: number } | null>(null);
  const penRef = useRef(pen);
  penRef.current = pen;

  const finishPen = (closed: boolean) => {
    const p = penRef.current;
    setPen(null);
    if (!p || p.pts.length < 2) return;
    const xs = p.pts.flatMap((q) => [q.x, q.x + q.hx, q.x - q.hx]), ys = p.pts.flatMap((q) => [q.y, q.y + q.hy, q.y - q.hy]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const w = Math.max(1, Math.ceil(Math.max(...xs) - minX)), h = Math.max(1, Math.ceil(Math.max(...ys) - minY));
    const d = penPath(p.pts, closed, -minX, -minY);
    void place(p.t, `Path vector w${w} h${h} vb:${w},${h} d:${JSON.stringify(d)} stroke:text.primary/2${closed ? ' fill:subtle' : ''}`, `${n1(minX)},${n1(minY)}`, 'pen path');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && penRef.current) { e.preventDefault(); e.stopPropagation(); finishPen(false); }
      if (e.key === 'Escape') { if (penRef.current) setPen(null); else { setDrag(null); setTool('select'); } }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  useEffect(() => { setPen(null); setDrag(null); }, [tool]);

  if (tool === 'select' || !scroll) return null;
  const base = scroll.getBoundingClientRect();
  const toX = (cx: number) => cx - base.left + scroll.scrollLeft;
  const toY = (cy: number) => cy - base.top + scroll.scrollTop;
  const doc = getState().doc;

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0 || !doc) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === 'pen') {
      const p = penRef.current;
      const t = p?.t ?? containerAt(doc, e.clientX, e.clientY);
      const x = (e.clientX - t.left) / zoom, y = (e.clientY - t.top) / zoom;
      if (p && p.pts.length > 2 && Math.hypot(x - p.pts[0]!.x, y - p.pts[0]!.y) * zoom < 8) return finishPen(true);
      const last = p?.pts.at(-1);
      if (last && Math.hypot(x - last.x, y - last.y) * zoom < 3) return; // second click of a double-click
      setPen({ t, pts: [...(p?.pts ?? []), { x, y, hx: 0, hy: 0 }], handle: true, mx: x, my: y });
      return;
    }
    setDrag({ t: containerAt(doc, e.clientX, e.clientY), sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY, shift: e.shiftKey });
  };
  const move = (e: React.PointerEvent) => {
    if (penRef.current) {
      const p = penRef.current;
      const x = (e.clientX - p.t.left) / zoom, y = (e.clientY - p.t.top) / zoom;
      if (p.handle) {
        const pts = p.pts.slice();
        const l = { ...pts[pts.length - 1]! };
        l.hx = x - l.x; l.hy = y - l.y;
        if (Math.hypot(l.hx, l.hy) * zoom < 3) { l.hx = 0; l.hy = 0; }
        pts[pts.length - 1] = l;
        setPen({ ...p, pts, mx: x, my: y });
      } else setPen({ ...p, mx: x, my: y });
    } else if (drag) setDrag({ ...drag, cx: e.clientX, cy: e.clientY, shift: e.shiftKey });
  };
  const up = () => {
    if (penRef.current?.handle) setPen({ ...penRef.current, handle: false });
    if (!drag) return;
    setDrag(null);
    const { t } = drag;
    const ax = n1((drag.sx - t.left) / zoom), ay = n1((drag.sy - t.top) / zoom);
    let dx = (drag.cx - drag.sx) / zoom, dy = (drag.cy - drag.sy) / zoom;
    const clicked = Math.hypot(dx, dy) * zoom < 4;
    if (drag.shift && tool !== 'line') { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s; }
    if (drag.shift && tool === 'line') { if (Math.abs(dx) > Math.abs(dy) * 2) dy = 0; else if (Math.abs(dy) > Math.abs(dx) * 2) dx = 0; else { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s; } }
    if (tool === 'text') return void place(t, 'Text body "Text"', `${ax},${ay}`, 'text');
    if (tool === 'line') {
      if (clicked) { dx = 120; dy = 0; }
      const w = Math.max(1, Math.round(Math.abs(dx))), h = Math.max(1, Math.round(Math.abs(dy)));
      const x1 = dx >= 0 ? 0 : w, y1 = dy >= 0 ? 0 : h, x2 = w - x1, y2 = h - y1;
      return void place(t, `Line vector w${w} h${h} vb:${w},${h} d:"M${x1} ${y1} L${x2} ${y2}" stroke:text.primary/2`, `${n1(Math.min(ax, ax + dx))},${n1(Math.min(ay, ay + dy))}`, 'line');
    }
    const w = clicked ? (tool === 'frame' ? 320 : 120) : Math.max(1, Math.round(Math.abs(dx)));
    const h = clicked ? (tool === 'frame' ? 240 : 120) : Math.max(1, Math.round(Math.abs(dy)));
    const at = `${clicked ? ax : n1(Math.min(ax, ax + dx))},${clicked ? ay : n1(Math.min(ay, ay + dy))}`;
    if (tool === 'frame') return void place(t, `Frame col w${w} h${h} fill:surface stroke:border`, at, 'frame');
    return void place(t, `${tool === 'rect' ? 'Rectangle' : 'Ellipse'} w${w} h${h} fill:subtle stroke:border.strong${tool === 'ellipse' ? ' rfull css:"border-radius:50%"' : ''}`, at, tool === 'rect' ? 'rectangle' : 'ellipse');
  };

  const box = drag && { left: Math.min(toX(drag.sx), toX(drag.cx)), top: Math.min(toY(drag.sy), toY(drag.cy)), width: Math.abs(drag.cx - drag.sx), height: Math.abs(drag.cy - drag.sy) };
  const penPreview = pen && (() => {
    const ox = toX(pen.t.left), oy = toY(pen.t.top);
    const ghost: Pt = { x: pen.mx, y: pen.my, hx: 0, hy: 0 };
    return (
      <svg className="draw-svg" aria-hidden>
        <g transform={`translate(${ox} ${oy}) scale(${zoom})`}>
          <path d={penPath(pen.handle ? pen.pts : [...pen.pts, ghost], false)} fill="none" stroke="var(--sel)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          {pen.pts.map((p, i) => (
            <g key={i}>
              {(p.hx || p.hy) ? <line x1={p.x - p.hx} y1={p.y - p.hy} x2={p.x + p.hx} y2={p.y + p.hy} stroke="var(--sel)" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity=".6" /> : null}
              <circle cx={p.x} cy={p.y} r={4 / zoom} fill={i === 0 ? 'var(--sel)' : '#fff'} stroke="var(--sel)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </g>
          ))}
        </g>
      </svg>
    );
  })();

  return (
    <div className="draw-layer" style={{ width: scroll.scrollWidth, height: scroll.scrollHeight }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onDoubleClick={() => tool === 'pen' && finishPen(false)}
      onClick={(e) => e.stopPropagation()}>
      {box && tool !== 'text' && (tool === 'line'
        ? <svg className="draw-svg" aria-hidden><line x1={toX(drag.sx)} y1={toY(drag.sy)} x2={toX(drag.cx)} y2={toY(drag.cy)} stroke="var(--sel)" strokeWidth="1.5" /></svg>
        : <div className="draw-box" style={{ ...box, borderRadius: tool === 'ellipse' ? '50%' : 0 }} />)}
      {penPreview}
      {tool === 'pen' && <div className="draw-hint" style={{ left: scroll.scrollLeft + scroll.clientWidth / 2, top: scroll.scrollTop + 12 }}>{pen ? 'Enter to finish · click the first point to close · Esc to cancel' : 'Click to place points, drag to bend'}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ move & resize on the canvas

let dragged = false;
/** true once after a drag, so the click that ends it does not change the selection */
export function consumeDrag(): boolean {
  const d = dragged;
  dragged = false;
  return d;
}

function track(e: React.PointerEvent, onMove: (dx: number, dy: number) => void, onEnd: (dx: number, dy: number, moved: boolean) => void) {
  const sx = e.clientX, sy = e.clientY;
  let moved = false;
  const mv = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 3) moved = true;
    if (moved) onMove(ev.clientX - sx, ev.clientY - sy);
  };
  const end = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', end);
    if (moved) dragged = true;
    onEnd(ev.clientX - sx, ev.clientY - sy, moved);
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', end);
}

export function startMove(e: React.PointerEvent, el: HTMLElement, id: string, x: number, y: number, zoom: number) {
  const doc = getState().doc!;
  const snap = snapper(el, doc.findNode(id)!.node, doc);
  let last = { dx: 0, dy: 0 };
  track(e, (dx, dy) => {
    last = e.altKey ? { dx, dy } : snap.apply(dx, dy);
    el.style.translate = `${last.dx / zoom}px ${last.dy / zoom}px`;
  }, (_dx, _dy, moved) => {
    el.style.translate = '';
    snap.done();
    if (moved) { void rdl(`set #${id} at:${Math.round(x + last.dx / zoom)},${Math.round(y + last.dy / zoom)}`, 'move').then(() => select([id])); }
  });
}

export function startResize(e: React.PointerEvent, el: HTMLElement, id: string, zoom: number, widthOnly: boolean) {
  e.stopPropagation();
  e.preventDefault();
  const r = el.getBoundingClientRect();
  const w0 = r.width / zoom, h0 = r.height / zoom;
  const size = (dx: number, dy: number) => [Math.max(1, Math.round(w0 + dx / zoom)), Math.max(1, Math.round(h0 + dy / zoom))] as const;
  track(e, (dx, dy) => {
    const [w, h] = size(dx, dy);
    el.style.width = `${w}px`;
    if (!widthOnly) el.style.height = `${h}px`;
  }, (dx, dy, moved) => {
    el.style.width = '';
    el.style.height = '';
    if (!moved) return;
    const [w, h] = size(dx, dy);
    void rdl(`set #${id} w${w}${widthOnly ? '' : ` h${h}`}`, 'resize');
  });
}
