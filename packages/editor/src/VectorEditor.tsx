import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { compileIcon, fromSubpaths, normalizePath, shapeMarkup, svgToIconSrc, toSubpaths, type IconDef, type IconSet, type PathNode, type SubPath } from '@rangoli/engine';
import { canEdit, rdl, toast } from './store';
import { indent } from './helpers';

/**
 * A real vector editor for icons. Everything stays shape-language text: primitives stay primitives until
 * an edit needs nodes, then they become paths. Each finished action is one undoable document edit.
 */

export type VTool = 'select' | 'node' | 'pen' | 'pencil' | 'line' | 'rect' | 'ellipse' | 'ngon' | 'star' | 'scissors' | 'builder';

const TOOLS: { id: VTool; name: string; key: string; d: string }[] = [
  { id: 'select', name: 'Select, move, scale, rotate', key: 'V', d: 'M5 3l6 16 2.5-6.5L20 10z' },
  { id: 'node', name: 'Edit points and curves', key: 'A', d: 'M5 3l5 16 2-6 6-2zM18 18h3v3h-3z' },
  { id: 'pen', name: 'Pen: click corners, drag curves, Enter to finish', key: 'P', d: 'M12 3l5 9-5 8-5-8zM12 3v9M9 21h6' },
  { id: 'pencil', name: 'Pencil: draw freehand', key: 'N', d: 'M4 20l1-4L16 5l3 3L8 19zM14 7l3 3' },
  { id: 'line', name: 'Line', key: 'L', d: 'M5 19L19 5' },
  { id: 'rect', name: 'Rectangle', key: 'R', d: 'M4 5h16v14H4z' },
  { id: 'ellipse', name: 'Ellipse', key: 'O', d: 'M12 5a8.5 7 0 1 0 .01 0z' },
  { id: 'ngon', name: 'Polygon', key: 'Y', d: 'M12 3l8 6-3 10H7L4 9z' },
  { id: 'star', name: 'Star', key: 'S', d: 'M12 3l2.6 5.8 6.2.7-4.6 4.2 1.3 6.1-5.5-3.1-5.5 3.1 1.3-6.1L3.2 9.5l6.2-.7z' },
  { id: 'scissors', name: 'Scissors: cut a path', key: 'C', d: 'M8 8l12 10M8 16L20 6M7 7a2.5 2.5 0 1 1-.01 0zM7 17a2.5 2.5 0 1 1-.01 0z' },
  { id: 'builder', name: 'Shape builder: select shapes, then drag across regions to merge, Alt-click to remove', key: 'B', d: 'M9 9a6 6 0 1 0 .01 0zM15 3a6 6 0 1 0 .01 0z' },
];

const COORD_PAIRS = new Set(['line', 'polyline', 'polygon', 'check']);
const CENTRE_FIRST = new Set(['rect', 'circle', 'dot', 'ellipse', 'ngon', 'star', 'arc', 'plus']);

export function parseLine(line: string) {
  const [kind = '', ...rest] = line.trim().split(/\s+/);
  const opts: string[] = [], args: string[] = [];
  for (const r of rest) (/^\w+=/.test(r) ? opts : args).push(r);
  return { kind, args, opts };
}
/** The shape's own geometry, before width profiles and symmetry copies are applied. */
const lineD = (line: string) => compileIcon(`exact\n${line.replace(/ (vw|sym)=\S+/g, '')}`).shapes[0]?.d ?? '';
const n3 = (v: number) => String(Math.round(v * 1000) / 1000);
const optsOf = (line: string) => parseLine(line).opts;
const keep = (line: string) => { const o = optsOf(line); return o.length ? ` ${o.join(' ')}` : ''; };
const setOpt = (line: string, key: string, value: string | null) => {
  const { kind, args, opts } = parseLine(line);
  const others = opts.filter((o) => !o.startsWith(`${key}=`));
  return [kind, ...args, ...others, ...(value === null ? [] : [`${key}=${value}`])].join(' ');
};
const getOpt = (line: string, key: string) => optsOf(line).find((o) => o.startsWith(`${key}=`))?.slice(key.length + 1);
export const toPath = (line: string) => (parseLine(line).kind === 'path' ? line : `path ${normalizePath(lineD(line))}${keep(line)}`);
const subsOf = (line: string) => toSubpaths(parseLine(toPath(line)).args.join(' '));
const fromSubs = (subs: SubPath[], line: string) => `path ${fromSubpaths(subs)}${keep(line)}`;

/** Apply a point transform; a plain move keeps primitives as primitives. */
function moveLine(line: string, dx: number, dy: number): string {
  const { kind, args, opts } = parseLine(line);
  const a = args.map(Number);
  if (COORD_PAIRS.has(kind)) return [kind, ...a.map((v, i) => n3(v + (i % 2 ? dy : dx))), ...opts].join(' ');
  if (CENTRE_FIRST.has(kind)) return [kind, n3(a[0]! + dx), n3(a[1]! + dy), ...args.slice(2), ...opts].join(' ');
  return mapLine(line, (x, y) => [x + dx, y + dy]);
}
function mapLine(line: string, f: (x: number, y: number) => [number, number]): string {
  const subs = subsOf(line).map((s) => ({ closed: s.closed, nodes: s.nodes.map((n): PathNode => {
    const [x, y] = f(n.x, n.y), [ix, iy] = f(n.ix, n.iy), [ox, oy] = f(n.ox, n.oy);
    return { x, y, ix, iy, ox, oy };
  }) }));
  return fromSubs(subs, line);
}

type Paper = { paper: any; offset: any };
let paperLib: Promise<Paper> | null = null;
/** Boolean and offset maths load on first use. */
export function loadPaper(): Promise<Paper> {
  return (paperLib ??= Promise.all([import('paper'), import('paperjs-offset')]).then(([p, o]: any[]) => {
    const paper = p.default ?? p;
    paper.setup(new paper.Size(1000, 1000));
    return { paper, offset: o.PaperOffset ?? o.default?.PaperOffset ?? o.default };
  }));
}
/** A bundled chunk only fails to load when the connection drops or a new version has shipped. */
const toolError = (e: unknown, tool: string) => (e instanceof Error && /fetch|import/i.test(e.message) ? `${tool} could not load. Reload the page and try again.` : `That did not work: ${e instanceof Error ? e.message : e}`);

const bboxOf = (lines: string[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lines) for (const s of subsOf(l)) for (const n of s.nodes) for (const [x, y] of [[n.x, n.y], [n.ix, n.iy], [n.ox, n.oy]] as const) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
};

interface NodeRef { s: number; sub: number; n: number }
type Drag =
  | { t: 'move'; sx: number; sy: number; base: string[] }
  | { t: 'scale'; sx: number; sy: number; base: string[]; box: ReturnType<typeof bboxOf>; hx: number; hy: number }
  | { t: 'rotate'; base: string[]; box: ReturnType<typeof bboxOf>; a0: number }
  | { t: 'box'; x: number; y: number; cx: number; cy: number }
  | { t: 'marquee'; x: number; y: number; cx: number; cy: number }
  | { t: 'node'; sx: number; sy: number; base: string[] }
  | { t: 'handle'; ref: NodeRef; which: 'i' | 'o'; base: string[]; alt: boolean }
  | { t: 'pencil'; pts: [number, number][] };

export interface VectorApi {
  lines: string[];
  selected: number[];
  commit: (next: string[], label: string, sel?: number[]) => void;
  setSelected: (s: number[]) => void;
  nodes: NodeRef[];
  setNodes: (n: NodeRef[]) => void;
}

export function useVector(set: IconSet, icon: IconDef) {
  const src = icon.src;
  const fromSrc = useMemo(() => src.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== 'exact' && !l.startsWith('#')), [src]);
  const [lines, setLines] = useState(fromSrc);
  const [selected, setSelected] = useState<number[]>([]);
  const [nodes, setNodes] = useState<NodeRef[]>([]);
  useEffect(() => { setLines(fromSrc); }, [fromSrc]);
  useEffect(() => { setSelected([]); setNodes([]); }, [set.name, icon.name]);
  const ref = `${set.name}/${icon.name}`;
  const commit = useCallback((next: string[], label: string, sel?: number[]) => {
    setLines(next);
    if (sel) setSelected(sel);
    if (!canEdit()) return;
    const body = next.join('\n');
    // keep exact positions only when something is off the half-unit grid
    const exact = compileIcon(body).snapped > 0;
    void rdl(`icon ${ref}${icon.stroke ? ` stroke${icon.stroke}` : ''}\n${indent(exact ? `exact\n${body}` : body || 'dot 12 12')}`, `${icon.name}: ${label}`);
  }, [ref, icon.stroke, icon.name]);
  return { lines, setLines, selected, setSelected, nodes, setNodes, commit };
}

export function VectorBoard({ set, icon, v, tool, setTool, snapStep, symmetry }: { set: IconSet; icon: IconDef; v: ReturnType<typeof useVector>; tool: VTool; setTool: (t: VTool) => void; snapStep: number; symmetry: string }) {
  const { lines, setLines, selected, setSelected, nodes, setNodes, commit } = v;
  const g = set.grid;
  const [size, setSize] = useState(520);
  const u = size / g;
  const ref = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pen, setPen] = useState<{ nodes: PathNode[]; dragging: boolean; mx: number; my: number; base?: number } | null>(null);
  const [atoms, setAtoms] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const merging = useRef(false);
  const withSym = (line: string) => (symmetry ? setOpt(line, 'sym', symmetry) : line);
  const clip = useRef<string[]>([]);
  const sw = icon.stroke ?? set.stroke;
  const compiledAll = useMemo(() => lines.map((l) => compileIcon(`exact\n${l}`).shapes), [lines]);
  const compiled = compiledAll.map((s) => s[0]);
  const artwork = useMemo(() => compiledAll.flat().map((s) => shapeMarkup(s)).join(''), [compiledAll]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize(Math.max(280, Math.min(el.clientWidth - 40, el.clientHeight - 40, 760))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const snap = (v0: number) => (snapStep ? Math.round(v0 / snapStep) * snapStep : Math.round(v0 * 1000) / 1000);
  const toUnit = (e: { clientX: number; clientY: number }): [number, number] => { const r = svgRef.current!.getBoundingClientRect(); return [(e.clientX - r.left) / u, (e.clientY - r.top) / u]; };
  const sel = selected.filter((i) => lines[i] !== undefined);
  const box = sel.length ? bboxOf(sel.map((i) => lines[i]!)) : null;
  const activeShapes = tool === 'node' ? (sel.length ? sel : lines.map((_, i) => i)) : [];

  const finishPen = (closed: boolean) => {
    setPen((p) => {
      if (p && p.nodes.length >= 2) {
        if (p.base !== undefined && lines[p.base]) {
          // a branch: the new stroke joins the shape it started from, sharing that point
          const subs = subsOf(lines[p.base]!);
          commit(lines.map((l, i) => (i === p.base ? fromSubs([...subs, { closed, nodes: p.nodes }], l) : l)), 'branch', [p.base]);
        } else commit([...lines, withSym(`path ${fromSubpaths([{ closed, nodes: p.nodes }])}`)], 'pen', [lines.length]);
      }
      return null;
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Enter' && pen) { e.preventDefault(); finishPen(false); return; }
      if (e.key === 'Escape') { setPen(null); setDrag(null); setNodes([]); setSelected([]); if (tool === 'builder') setTool('select'); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        if (tool === 'node' && nodes.length) {
          const next = lines.slice();
          const by = new Map<number, NodeRef[]>();
          nodes.forEach((n) => by.set(n.s, [...(by.get(n.s) ?? []), n]));
          for (const [s, list] of by) {
            const subs = subsOf(next[s]!);
            for (const n of [...list].sort((a, b) => b.n - a.n)) subs[n.sub]?.nodes.splice(n.n, 1);
            const left = subs.filter((x) => x.nodes.length > 1);
            next[s] = left.length ? fromSubs(left, next[s]!) : '';
          }
          setNodes([]);
          commit(next.filter(Boolean), 'delete points', []);
        } else if (sel.length) commit(lines.filter((_, i) => !sel.includes(i)), 'delete', []);
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelected(lines.map((_, i) => i)); return; }
      if (mod && e.key.toLowerCase() === 'd' && sel.length) { e.preventDefault(); commit([...lines, ...sel.map((i) => moveLine(lines[i]!, 1, 1))], 'duplicate', sel.map((_, k) => lines.length + k)); return; }
      if (mod && e.key.toLowerCase() === 'c' && sel.length) { clip.current = sel.map((i) => lines[i]!); return; }
      if (mod && e.key.toLowerCase() === 'v' && clip.current.length) { e.preventDefault(); commit([...lines, ...clip.current.map((l) => moveLine(l, 1, 1))], 'paste', clip.current.map((_, k) => lines.length + k)); return; }
      if (e.key === ']' && sel.length === 1 && sel[0]! < lines.length - 1) { const n = lines.slice(); [n[sel[0]!], n[sel[0]! + 1]] = [n[sel[0]! + 1]!, n[sel[0]!]!]; commit(n, 'bring forward', [sel[0]! + 1]); return; }
      if (e.key === '[' && sel.length === 1 && sel[0]! > 0) { const n = lines.slice(); [n[sel[0]!], n[sel[0]! - 1]] = [n[sel[0]! - 1]!, n[sel[0]!]!]; commit(n, 'send back', [sel[0]! - 1]); return; }
      if (e.key.startsWith('Arrow') && sel.length) {
        e.preventDefault();
        const d = (e.shiftKey ? 1 : snapStep || 0.25) * (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1);
        const h = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
        commit(lines.map((l, i) => (sel.includes(i) ? moveLine(l, h ? d : 0, h ? 0 : d) : l)), 'nudge');
        return;
      }
      if (!mod) { const hit = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase()); if (hit) setTool(hit.id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const hitShape = (i: number, e: React.PointerEvent) => {
    if (tool !== 'select' && tool !== 'node' && tool !== 'scissors') return false;
    e.stopPropagation();
    const [x, y] = toUnit(e);
    if (tool === 'scissors') { cutAt(i, x, y); return true; }
    if (tool === 'node') {
      if (!sel.includes(i)) { setSelected([i]); setNodes([]); return true; }
      insertNode(i, x, y);
      return true;
    }
    const nextSel = e.shiftKey ? (sel.includes(i) ? sel.filter((s) => s !== i) : [...sel, i]) : sel.includes(i) ? sel : [i];
    setSelected(nextSel);
    svgRef.current?.setPointerCapture(e.pointerId);
    setDrag({ t: 'move', sx: x, sy: y, base: lines });
    return true;
  };

  /** Nearest position on a shape's segments (t along the segment), for adding or cutting points. */
  const nearest = (i: number, x: number, y: number) => {
    const subs = subsOf(lines[i]!);
    let best = { sub: 0, seg: 0, t: 0, d: Infinity };
    const at = (p: PathNode, q: PathNode, t: number): [number, number] => {
      const m = 1 - t;
      return [m * m * m * p.x + 3 * m * m * t * p.ox + 3 * m * t * t * q.ix + t * t * t * q.x, m * m * m * p.y + 3 * m * m * t * p.oy + 3 * m * t * t * q.iy + t * t * t * q.y];
    };
    subs.forEach((s, si) => {
      const count = s.closed ? s.nodes.length : s.nodes.length - 1;
      for (let k = 0; k < count; k++) {
        const p = s.nodes[k]!, q = s.nodes[(k + 1) % s.nodes.length]!;
        for (let t = 0.02; t < 1; t += 0.02) { const [ax, ay] = at(p, q, t); const d = Math.hypot(ax - x, ay - y); if (d < best.d) best = { sub: si, seg: k, t, d }; }
      }
    });
    return { subs, ...best };
  };
  /** Split one cubic segment at t (de Casteljau), returning the new middle node. */
  const splitSeg = (s: SubPath, seg: number, t: number): PathNode => {
    const p = s.nodes[seg]!, q = s.nodes[(seg + 1) % s.nodes.length]!;
    const L = (a: number, b: number) => a + (b - a) * t;
    const ax = L(p.x, p.ox), ay = L(p.y, p.oy), bx = L(p.ox, q.ix), by = L(p.oy, q.iy), cx = L(q.ix, q.x), cy = L(q.iy, q.y);
    const dx = L(ax, bx), dy = L(ay, by), ex = L(bx, cx), ey = L(by, cy);
    const mid = { x: L(dx, ex), y: L(dy, ey), ix: dx, iy: dy, ox: ex, oy: ey };
    p.ox = ax; p.oy = ay; q.ix = cx; q.iy = cy;
    return mid;
  };
  const insertNode = (i: number, x: number, y: number) => {
    const { subs, sub, seg, t } = nearest(i, x, y);
    const s = subs[sub];
    if (!s) return;
    s.nodes.splice(seg + 1, 0, splitSeg(s, seg, t));
    commit(lines.map((l, k) => (k === i ? fromSubs(subs, l) : l)), 'add point', [i]);
  };
  const cutAt = (i: number, x: number, y: number) => {
    const { subs, sub, seg, t } = nearest(i, x, y);
    const s = subs[sub];
    if (!s) return;
    const mid = splitSeg(s, seg, t);
    const cut = { ...mid, ix: mid.x, iy: mid.y }, cut2 = { ...mid, ox: mid.x, oy: mid.y };
    let parts: SubPath[];
    if (s.closed) parts = [{ closed: false, nodes: [cut, ...s.nodes.slice(seg + 1), ...s.nodes.slice(0, seg + 1), cut2] }];
    else parts = [{ closed: false, nodes: [...s.nodes.slice(0, seg + 1), cut2] }, { closed: false, nodes: [cut, ...s.nodes.slice(seg + 1)] }];
    const all = [...subs.slice(0, sub), ...parts, ...subs.slice(sub + 1)];
    commit(lines.map((l, k) => (k === i ? fromSubs(all, l) : l)), 'cut', [i]);
  };

  // shape builder: cut the selected shapes into their overlapping regions
  const linesKey = lines.join('\n');
  useEffect(() => {
    if (tool !== 'builder') { setAtoms(null); return; }
    if (sel.length < 2) { toast('error', 'Select two or more shapes first'); setTool('select'); return; }
    let live = true;
    void loadPaper().then(({ paper }) => {
      if (!live) return;
      const items = sel.map((i) => new paper.CompoundPath({ pathData: lineD(toPath(lines[i]!)), insert: false }));
      let out: any[] = [items[0]];
      for (const it of items.slice(1)) {
        const next: any[] = [];
        let rest = it;
        for (const a of out) {
          const both = a.intersect(it, { insert: false }), only = a.subtract(it, { insert: false });
          if (!both.isEmpty()) next.push(both);
          if (!only.isEmpty()) next.push(only);
          rest = rest.subtract(a, { insert: false });
        }
        if (!rest.isEmpty()) next.push(rest);
        out = next;
      }
      // pieces that do not touch become separate regions; holes stay with their piece
      const regions = out.flatMap((x) => (x.children?.length > 1 && x.children.every((c: any) => c.clockwise === x.children[0].clockwise) ? x.children : [x])).filter((x) => Math.abs(x.area) > 0.02);
      setAtoms(regions.map((x) => normalizePath(x.pathData)));
      setPicked([]);
    }).catch((e) => { toast('error', toolError(e, 'Shape builder')); setTool('select'); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, linesKey, sel.join()]);
  const applyAtoms = async (keep: string[], merged: string[]) => {
    const { paper } = await loadPaper();
    const others = lines.filter((_, i) => !sel.includes(i));
    const out = keep.map((d) => `path ${d} fill=true`);
    if (merged.length) {
      let u = new paper.CompoundPath({ pathData: merged[0], insert: false });
      for (const d of merged.slice(1)) u = u.unite(new paper.CompoundPath({ pathData: d, insert: false }), { insert: false });
      out.push(`path ${normalizePath(u.pathData)} fill=true`);
    }
    commit([...others, ...out], 'shape builder', out.map((_, k) => others.length + k));
  };
  const finishMerge = () => {
    if (!merging.current || !atoms) return;
    merging.current = false;
    const m = picked;
    setPicked([]);
    if (m.length) void applyAtoms(atoms.filter((_, i) => !m.includes(i)), m.map((i) => atoms[i]!));
  };

  /** An existing point near the pointer, for snapping and starting branches. */
  const nearAnchor = (x: number, y: number) => {
    for (let s = 0; s < lines.length; s++) for (const sp of subsOf(lines[s]!)) for (const n of sp.nodes) if (Math.hypot(n.x - x, n.y - y) < 0.5) return { s, x: n.x, y: n.y };
    return null;
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || tool === 'builder') return;
    const [x0, y0] = toUnit(e);
    const x = snap(x0), y = snap(y0);
    svgRef.current!.setPointerCapture(e.pointerId);
    if (tool === 'pen') {
      if (pen && pen.nodes.length > 2 && Math.hypot(x - pen.nodes[0]!.x, y - pen.nodes[0]!.y) < 0.6) return finishPen(true);
      const hit = nearAnchor(x0, y0);
      const px = hit?.x ?? x, py = hit?.y ?? y;
      setPen({ nodes: [...(pen?.nodes ?? []), { x: px, y: py, ix: px, iy: py, ox: px, oy: py }], dragging: true, mx: px, my: py, base: pen ? pen.base : hit?.s });
      return;
    }
    if (tool === 'pencil') return setDrag({ t: 'pencil', pts: [[x0, y0]] });
    if (['line', 'rect', 'ellipse', 'ngon', 'star'].includes(tool)) return setDrag({ t: 'box', x, y, cx: x, cy: y });
    if (tool === 'select' || tool === 'node') { if (!e.shiftKey) { setSelected([]); setNodes([]); } setDrag({ t: 'marquee', x: x0, y: y0, cx: x0, cy: y0 }); }
  };

  const onMove = (e: React.PointerEvent) => {
    const [x0, y0] = toUnit(e);
    const x = snap(x0), y = snap(y0);
    if (pen) {
      if (pen.dragging) {
        const n = pen.nodes.slice();
        const l = { ...n[n.length - 1]! };
        if (Math.hypot(x0 - l.x, y0 - l.y) > 0.25) { l.ox = x; l.oy = y; l.ix = 2 * l.x - x; l.iy = 2 * l.y - y; }
        n[n.length - 1] = l;
        setPen({ ...pen, nodes: n, mx: x, my: y });
      } else setPen({ ...pen, mx: x, my: y });
      return;
    }
    if (!drag) return;
    if (drag.t === 'pencil') return setDrag({ ...drag, pts: [...drag.pts, [x0, y0]] });
    if (drag.t === 'box' || drag.t === 'marquee') return setDrag({ ...drag, cx: drag.t === 'box' ? x : x0, cy: drag.t === 'box' ? y : y0 });
    if (drag.t === 'move') {
      const dx = snap(x0 - drag.sx), dy = snap(y0 - drag.sy);
      setLines(drag.base.map((l, i) => (sel.includes(i) ? moveLine(l, dx, dy) : l)));
    } else if (drag.t === 'scale') {
      const b = drag.box;
      const ax = drag.hx === 0 ? b.x1 : b.x0, ay = drag.hy === 0 ? b.y1 : b.y0;
      let sx = drag.hx === 0.5 ? 1 : (x - ax) / ((drag.hx === 0 ? b.x0 : b.x1) - ax || 1);
      let sy = drag.hy === 0.5 ? 1 : (y - ay) / ((drag.hy === 0 ? b.y0 : b.y1) - ay || 1);
      if (e.shiftKey) { const m = Math.max(Math.abs(sx), Math.abs(sy)); sx = m * Math.sign(sx || 1); sy = m * Math.sign(sy || 1); }
      setLines(drag.base.map((l, i) => (sel.includes(i) ? mapLine(l, (px, py) => [ax + (px - ax) * sx, ay + (py - ay) * sy]) : l)));
    } else if (drag.t === 'rotate') {
      const b = drag.box;
      let a = Math.atan2(y0 - b.cy, x0 - b.cx) - drag.a0;
      if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      const c = Math.cos(a), s = Math.sin(a);
      setLines(drag.base.map((l, i) => (sel.includes(i) ? mapLine(l, (px, py) => [b.cx + (px - b.cx) * c - (py - b.cy) * s, b.cy + (px - b.cx) * s + (py - b.cy) * c]) : l)));
    } else if (drag.t === 'node') {
      const dx = snap(x0 - drag.sx), dy = snap(y0 - drag.sy);
      const next = drag.base.slice();
      const by = new Map<number, NodeRef[]>();
      nodes.forEach((n) => by.set(n.s, [...(by.get(n.s) ?? []), n]));
      for (const [s, list] of by) {
        const subs = subsOf(drag.base[s]!);
        for (const r of list) { const n = subs[r.sub]?.nodes[r.n]; if (n) { n.x += dx; n.y += dy; n.ix += dx; n.iy += dy; n.ox += dx; n.oy += dy; } }
        next[s] = fromSubs(subs, drag.base[s]!);
      }
      setLines(next);
    } else if (drag.t === 'handle') {
      const subs = subsOf(drag.base[drag.ref.s]!);
      const n = subs[drag.ref.sub]?.nodes[drag.ref.n];
      if (n) {
        if (drag.which === 'o') { n.ox = x; n.oy = y; if (!e.altKey) { n.ix = 2 * n.x - x; n.iy = 2 * n.y - y; } }
        else { n.ix = x; n.iy = y; if (!e.altKey) { n.ox = 2 * n.x - x; n.oy = 2 * n.y - y; } }
      }
      setLines(drag.base.map((l, i) => (i === drag.ref.s ? fromSubs(subs, l) : l)));
    }
  };

  const onUp = (e: React.PointerEvent) => {
    finishMerge();
    if (pen?.dragging) { setPen({ ...pen, dragging: false }); return; }
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.t === 'pencil') { void finishPencil(d.pts); return; }
    if (d.t === 'marquee') {
      const [ax, bx] = [Math.min(d.x, d.cx), Math.max(d.x, d.cx)], [ay, by] = [Math.min(d.y, d.cy), Math.max(d.y, d.cy)];
      if (bx - ax < 0.2 && by - ay < 0.2) return;
      if (tool === 'node') {
        const picked: NodeRef[] = [];
        activeShapes.forEach((s) => subsOf(lines[s]!).forEach((sp, si) => sp.nodes.forEach((n, ni) => { if (n.x >= ax && n.x <= bx && n.y >= ay && n.y <= by) picked.push({ s, sub: si, n: ni }); })));
        setNodes(picked);
      } else setSelected(lines.flatMap((l, i) => { const b = bboxOf([l]); return b.x0 >= ax && b.x1 <= bx && b.y0 >= ay && b.y1 <= by ? [i] : []; }));
      return;
    }
    if (d.t === 'box') {
      const shift = e.shiftKey;
      let w = d.cx - d.x, h = d.cy - d.y;
      if (Math.hypot(w, h) < 0.4) return;
      if (shift && tool !== 'line') { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
      const x = Math.min(d.x, d.x + w), y = Math.min(d.y, d.y + h), aw = Math.abs(w), ah = Math.abs(h), cx = x + aw / 2, cy = y + ah / 2;
      const line = tool === 'line' ? `line ${n3(d.x)} ${n3(d.y)} ${n3(d.x + w)} ${n3(d.y + h)}`
        : tool === 'rect' ? `rect ${n3(x)} ${n3(y)} ${n3(aw)} ${n3(ah)}`
        : tool === 'ellipse' ? (aw === ah ? `circle ${n3(cx)} ${n3(cy)} ${n3(aw / 2)}` : `ellipse ${n3(cx)} ${n3(cy)} ${n3(aw / 2)} ${n3(ah / 2)}`)
        : tool === 'ngon' ? `ngon ${n3(cx)} ${n3(cy)} ${n3(Math.max(aw, ah) / 2)} 6`
        : `star ${n3(cx)} ${n3(cy)} ${n3(Math.max(aw, ah) / 2)} ${n3(Math.max(aw, ah) / 4.5)} 5`;
      commit([...lines, withSym(line)], tool, [lines.length]);
      setTool('select');
      return;
    }
    if (d.t === 'move' || d.t === 'scale' || d.t === 'rotate' || d.t === 'node' || d.t === 'handle') {
      if (lines.join('\n') !== d.base.join('\n')) commit(lines, d.t === 'node' || d.t === 'handle' ? 'edit points' : d.t);
    }
  };

  const finishPencil = async (pts: [number, number][]) => {
    if (pts.length < 3) return;
    let d = `M${pts.map(([x, y]) => `${n3(x)} ${n3(y)}`).join(' L')}`;
    try {
      const { paper } = await loadPaper();
      const p = new paper.Path({ segments: pts, insert: false });
      p.simplify(0.08);
      d = normalizePath(p.pathData);
    } catch { /* offline: keep the raw polyline */ }
    commit([...lines, withSym(`path ${d}`)], 'pencil', [lines.length]);
  };

  const toggleSmooth = (r: NodeRef) => {
    const subs = subsOf(lines[r.s]!);
    const s = subs[r.sub]!, n = s.nodes[r.n]!;
    const corner = n.ix === n.x && n.iy === n.y && n.ox === n.x && n.oy === n.y;
    if (corner) {
      const a = s.nodes[(r.n - 1 + s.nodes.length) % s.nodes.length]!, b = s.nodes[(r.n + 1) % s.nodes.length]!;
      const dx = (b.x - a.x) / 4, dy = (b.y - a.y) / 4;
      n.ix = n.x - dx; n.iy = n.y - dy; n.ox = n.x + dx; n.oy = n.y + dy;
    } else { n.ix = n.x; n.iy = n.y; n.ox = n.x; n.oy = n.y; }
    commit(lines.map((l, i) => (i === r.s ? fromSubs(subs, l) : l)), 'convert point');
  };

  const penD = pen ? fromSubpaths([{ closed: false, nodes: pen.dragging ? pen.nodes : [...pen.nodes, { x: pen.mx, y: pen.my, ix: pen.mx, iy: pen.my, ox: pen.mx, oy: pen.my }] }]) : '';
  const startScale = (hx: number, hy: number) => (e: React.PointerEvent) => { e.stopPropagation(); svgRef.current!.setPointerCapture(e.pointerId); const [sx, sy] = toUnit(e); setDrag({ t: 'scale', sx, sy, base: lines, box: box!, hx, hy }); };

  return (
    <div className="vb" ref={ref}>
      <svg ref={svgRef} className={`vb-svg tool-${tool}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="application" aria-label={`${icon.name} vector canvas`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={() => pen && finishPen(false)}>
        <rect width={size} height={size} className="vb-bg" />
        {Array.from({ length: g + 1 }, (_, i) => (
          <g key={i} className={i % 4 === 0 ? 'grid-major' : 'grid-minor'}>
            <line x1={i * u} y1={0} x2={i * u} y2={size} /><line x1={0} y1={i * u} x2={size} y2={i * u} />
          </g>
        ))}
        <g className="keyline">
          <circle cx={size / 2} cy={size / 2} r={(g / 2 - 2) * u} />
          <rect x={3 * u} y={3 * u} width={(g - 6) * u} height={(g - 6) * u} rx={2 * u} />
          <rect x={4 * u} y={2 * u} width={(g - 8) * u} height={(g - 4) * u} rx={2 * u} />
          <rect x={2 * u} y={4 * u} width={(g - 4) * u} height={(g - 8) * u} rx={2 * u} />
        </g>
        <rect className="live-area" x={(g / 16) * u} y={(g / 16) * u} width={(g - g / 8) * u} height={(g - g / 8) * u} />
        <g transform={`scale(${u})`} fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap={set.cap} strokeLinejoin={set.join} className="icon-strokes">
          <g dangerouslySetInnerHTML={{ __html: artwork }} />
        </g>
        {/* generous invisible hit areas */}
        <g transform={`scale(${u})`} fill="none" className="vb-hits">
          {compiled.map((s, i) => s && <path key={i} d={s.d} data-shape={i} stroke="transparent" strokeWidth={Math.max(sw, 1.2)} fill={s.fill ? 'transparent' : 'none'} pointerEvents="all" onPointerDown={(e) => { if (hitShape(i, e)) e.stopPropagation(); }} />)}
        </g>
        {tool === 'select' && box && Number.isFinite(box.x0) && (
          <g className="vb-box">
            <rect x={box.x0 * u} y={box.y0 * u} width={box.w * u} height={box.h * u} />
            {([[0, 0], [0.5, 0], [1, 0], [0, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]] as const).map(([hx, hy]) => (
              <rect key={`${hx}${hy}`} className="vb-h" data-handle={`${hx},${hy}`} x={(box.x0 + box.w * hx) * u - 4} y={(box.y0 + box.h * hy) * u - 4} width={8} height={8} onPointerDown={startScale(hx, hy)} />
            ))}
            <line x1={box.cx * u} y1={box.y0 * u} x2={box.cx * u} y2={box.y0 * u - 22} />
            <circle className="vb-h vb-rot" data-handle="rotate" cx={box.cx * u} cy={box.y0 * u - 22} r={5} onPointerDown={(e) => { e.stopPropagation(); svgRef.current!.setPointerCapture(e.pointerId); const [x, y] = toUnit(e); setDrag({ t: 'rotate', base: lines, box: box!, a0: Math.atan2(y - box!.cy, x - box!.cx) }); }} />
          </g>
        )}
        {activeShapes.map((s) => subsOf(lines[s]!).map((sp, si) => sp.nodes.map((n, ni) => {
          const on = nodes.some((r) => r.s === s && r.sub === si && r.n === ni);
          const start = (e: React.PointerEvent) => {
            e.stopPropagation();
            svgRef.current!.setPointerCapture(e.pointerId);
            // points that coincide move together: that is how strokes branch from one point
            const here: NodeRef[] = [];
            subsOf(lines[s]!).forEach((sp2, sj) => sp2.nodes.forEach((m, mj) => { if (Math.hypot(m.x - n.x, m.y - n.y) < 1e-3) here.push({ s, sub: sj, n: mj }); }));
            if (!on) setNodes(e.shiftKey ? [...nodes, ...here] : here);
            setSelected(sel.includes(s) ? sel : [s]);
            const [x, y] = toUnit(e);
            setDrag({ t: 'node', sx: x, sy: y, base: lines });
          };
          const handle = (which: 'i' | 'o', hx: number, hy: number) => (hx !== n.x || hy !== n.y) && on && (
            <g key={which}>
              <line className="vb-arm" x1={n.x * u} y1={n.y * u} x2={hx * u} y2={hy * u} />
              <circle className="vb-handle" data-handle={which} cx={hx * u} cy={hy * u} r={4} onPointerDown={(e) => { e.stopPropagation(); svgRef.current!.setPointerCapture(e.pointerId); setDrag({ t: 'handle', ref: { s, sub: si, n: ni }, which, base: lines, alt: e.altKey }); }} />
            </g>
          );
          return (
            <g key={`${s}-${si}-${ni}`}>
              {handle('i', n.ix, n.iy)}{handle('o', n.ox, n.oy)}
              <rect className={`vb-node${on ? ' is-on' : ''}`} data-node={`${s},${si},${ni}`} x={n.x * u - 4} y={n.y * u - 4} width={8} height={8} onPointerDown={start} onDoubleClick={(e) => { e.stopPropagation(); toggleSmooth({ s, sub: si, n: ni }); }} />
            </g>
          );
        })))}
        {atoms && <g transform={`scale(${u})`} className="vb-atoms">{atoms.map((d, i) => (
          <path key={i} d={d} data-atom={i} className={picked.includes(i) ? 'is-on' : ''} fillRule="evenodd"
            onPointerDown={(e) => { e.stopPropagation(); if (e.altKey) { void applyAtoms(atoms.filter((_, k) => k !== i), []); return; } merging.current = true; setPicked([i]); (e.currentTarget as SVGPathElement).releasePointerCapture?.(e.pointerId); }}
            onPointerEnter={() => { if (merging.current) setPicked((p) => (p.includes(i) ? p : [...p, i])); }}
            onPointerUp={(e) => { e.stopPropagation(); finishMerge(); }} />
        ))}</g>}
        {pen && (
          <g transform={`scale(${u})`} fill="none" className="vb-pen">
            <path d={penD} strokeWidth={sw} />
          </g>
        )}
        {pen?.nodes.map((n, i) => <rect key={i} className={`vb-node${i === 0 ? ' is-on' : ''}`} x={n.x * u - 4} y={n.y * u - 4} width={8} height={8} />)}
        {drag?.t === 'marquee' && <rect className="vb-marquee" x={Math.min(drag.x, drag.cx) * u} y={Math.min(drag.y, drag.cy) * u} width={Math.abs(drag.cx - drag.x) * u} height={Math.abs(drag.cy - drag.y) * u} />}
        {drag?.t === 'box' && <rect className="vb-marquee" x={Math.min(drag.x, drag.cx) * u} y={Math.min(drag.y, drag.cy) * u} width={Math.abs(drag.cx - drag.x) * u} height={Math.abs(drag.cy - drag.y) * u} />}
        {drag?.t === 'pencil' && <polyline className="vb-free" points={drag.pts.map(([x, y]) => `${x * u},${y * u}`).join(' ')} />}
      </svg>
    </div>
  );
}

export function VectorTools({ tool, setTool }: { tool: VTool; setTool: (t: VTool) => void }) {
  return (
    <div className="v-tools" role="toolbar" aria-label="Vector tools">
      {TOOLS.map((t) => (
        <button key={t.id} className="draw-tool" aria-pressed={tool === t.id} aria-label={t.name} title={`${t.name} (${t.key})`} onClick={() => setTool(t.id)}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={t.d} /></svg>
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ path operations

export type VState = ReturnType<typeof useVector>;

export function usePathOps(v: VState, set: IconSet, icon: IconDef) {
  const { lines, selected, commit } = v;
  const sw = icon.stroke ?? set.stroke;
  const sel = selected.filter((i) => lines[i] !== undefined);
  const replaceSel = (out: string[], label: string) => {
    const kept = lines.filter((_, i) => !sel.includes(i));
    commit([...kept, ...out], label, out.map((_, k) => kept.length + k));
  };
  const needs = (n: number) => { if (sel.length < n) { toast('error', n === 1 ? 'Select a shape first' : `Select ${n} or more shapes`); return false; } return true; };
  const withPaper = async (fn: (p: Paper) => void) => {
    try { fn(await loadPaper()); } catch (e) { toast('error', toolError(e, 'This tool')); }
  };
  const item = (paper: any, line: string) => new paper.CompoundPath({ pathData: lineD(toPath(line)), insert: false });
  const data = (x: any) => normalizePath(x.pathData);

  const boolean = (op: 'unite' | 'subtract' | 'intersect' | 'exclude' | 'divide') => {
    if (!needs(2)) return;
    void withPaper(({ paper }) => {
      const items = sel.map((i) => item(paper, lines[i]!));
      const first = lines[sel[0]!]!;
      const opts = `${getOpt(first, 'c') ? ` c=${getOpt(first, 'c')}` : ''}`;
      let r = items[0];
      for (const it of items.slice(1)) r = r[op](it, { insert: false });
      if (op === 'divide' && r.children?.length) replaceSel(r.children.map((c: any) => `path ${data(c)} fill=true${opts}`), 'divide');
      else replaceSel([`path ${data(r)} fill=true${opts}`], op);
    });
  };
  const eachPaper = (label: string, fn: (it: any, paper: any, off: any, line: string) => any, allowAll = false) => {
    const targets = sel.length ? sel : allowAll ? lines.map((_, i) => i) : [];
    if (!targets.length) return toast('error', 'Select a shape first');
    void withPaper(({ paper, offset }) => {
      commit(lines.map((l, i) => {
        if (!targets.includes(i)) return l;
        const out = fn(item(paper, l), paper, offset, l);
        return out ? `path ${data(out)}${keep(toPath(l))}` : l;
      }), label);
    });
  };
  const outline = () => {
    if (!needs(1)) return;
    void withPaper(({ paper, offset }) => {
      const out = sel.map((i) => {
        const l = lines[i]!;
        const w = Number(getOpt(l, 'w') ?? sw);
        if (getOpt(l, 'fill') === 'true') return l;
        const shapes = item(paper, l).children.map((c: any) => offset.offsetStroke(c, w / 2, { cap: set.cap === 'butt' ? 'butt' : 'round', join: set.join === 'bevel' ? 'bevel' : set.join === 'miter' ? 'miter' : 'round', insert: false }));
        let u = shapes[0];
        for (const s of shapes.slice(1)) u = u.unite(s, { insert: false });
        return `path ${data(u)} fill=true${getOpt(l, 'c') ? ` c=${getOpt(l, 'c')}` : ''}`;
      });
      replaceSel(out, 'outline stroke');
    });
  };
  const offsetPath = (dist: number) => eachPaper(`offset ${dist}`, (it, _p, off) => off.offset(it, dist, { join: 'round', insert: false }));
  const simplify = () => eachPaper('simplify', (it) => { for (const c of it.children) c.simplify(0.05); return it; }, true);
  const smooth = () => eachPaper('smooth', (it) => { it.smooth({ type: 'continuous' }); return it; });
  const flatten = () => eachPaper('flatten curves', (it) => { it.flatten(0.1); return it; });
  const reverse = () => eachPaper('reverse', (it) => { it.reverse(); return it; });

  const roundCorners = (r: number) => {
    if (!needs(1)) return;
    commit(lines.map((l, i) => {
      if (!sel.includes(i)) return l;
      const subs = subsOf(l).map((s) => {
        const out: PathNode[] = [];
        s.nodes.forEach((n, k) => {
          const hasPrev = s.closed || k > 0, hasNext = s.closed || k < s.nodes.length - 1;
          const corner = n.ix === n.x && n.iy === n.y && n.ox === n.x && n.oy === n.y;
          const p = s.nodes[(k - 1 + s.nodes.length) % s.nodes.length]!, q = s.nodes[(k + 1) % s.nodes.length]!;
          if (!hasPrev || !hasNext || !corner) { out.push(n); return; }
          const d1 = Math.hypot(p.x - n.x, p.y - n.y), d2 = Math.hypot(q.x - n.x, q.y - n.y), rad = Math.min(r, d1 / 2, d2 / 2);
          if (rad <= 0) { out.push(n); return; }
          const u1 = [(p.x - n.x) / d1, (p.y - n.y) / d1] as const, u2 = [(q.x - n.x) / d2, (q.y - n.y) / d2] as const;
          const a = { x: n.x + u1[0] * rad, y: n.y + u1[1] * rad }, b = { x: n.x + u2[0] * rad, y: n.y + u2[1] * rad };
          const K = 0.55;
          out.push({ ...a, ix: a.x, iy: a.y, ox: a.x + (n.x - a.x) * K, oy: a.y + (n.y - a.y) * K });
          out.push({ ...b, ix: b.x + (n.x - b.x) * K, iy: b.y + (n.y - b.y) * K, ox: b.x, oy: b.y });
        });
        return { closed: s.closed, nodes: out };
      });
      return fromSubs(subs, l);
    }), 'round corners');
  };
  const closePath = () => { if (needs(1)) commit(lines.map((l, i) => (sel.includes(i) ? fromSubs(subsOf(l).map((s) => ({ ...s, closed: true })), l) : l)), 'close path'); };
  const join = () => {
    if (!needs(2)) return;
    const all = sel.flatMap((i) => subsOf(lines[i]!));
    const nodes = all.flatMap((s) => s.nodes);
    replaceSel([fromSubs([{ closed: false, nodes }], lines[sel[0]!]!)], 'join');
  };
  const combine = () => { if (needs(2)) replaceSel([fromSubs(sel.flatMap((i) => subsOf(lines[i]!)), lines[sel[0]!]!)], 'combine'); };
  const breakApart = () => { if (needs(1)) replaceSel(sel.flatMap((i) => subsOf(lines[i]!).map((s) => fromSubs([s], lines[i]!))), 'break apart'); };
  const bake = () => {
    if (!needs(1)) return;
    replaceSel(sel.flatMap((i) => {
      const l = lines[i]!;
      const rest = optsOf(l).filter((o) => !/^(sym|vw|fill|w)=/.test(o));
      return compileIcon(`exact\n${l}`).shapes.map((s) => `path ${normalizePath(s.d)}${s.fill ? ' fill=true' : ''}${s.w !== undefined ? ` w=${s.w}` : ''}${rest.length ? ` ${rest.join(' ')}` : ''}`);
    }), 'bake');
  };
  const toPaths = () => { if (needs(1)) commit(lines.map((l, i) => (sel.includes(i) ? toPath(l) : l)), 'convert to path'); };

  const transformAround = (fn: (x: number, y: number, c: { cx: number; cy: number }) => [number, number], label: string) => {
    if (!needs(1)) return;
    const b = bboxOf(sel.map((i) => lines[i]!));
    commit(lines.map((l, i) => (sel.includes(i) ? mapLine(l, (x, y) => fn(x, y, b)) : l)), label);
  };
  const flip = (axis: 'h' | 'v') => transformAround((x, y, c) => (axis === 'h' ? [2 * c.cx - x, y] : [x, 2 * c.cy - y]), axis === 'h' ? 'flip horizontal' : 'flip vertical');
  const rotate = (deg: number) => { const a = (deg * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a); transformAround((x, y, c) => [c.cx + (x - c.cx) * co - (y - c.cy) * si, c.cy + (x - c.cx) * si + (y - c.cy) * co], `rotate ${deg}`); };
  const skew = (deg: number) => { const t = Math.tan((deg * Math.PI) / 180); transformAround((x, y, c) => [x + (y - c.cy) * t, y], `skew ${deg}`); };
  const alignTo = (edge: string) => {
    if (!needs(1)) return;
    const g = set.grid;
    const all = sel.length > 1 ? bboxOf(sel.map((i) => lines[i]!)) : { x0: 0, x1: g, y0: 0, y1: g, cx: g / 2, cy: g / 2 };
    commit(lines.map((l, i) => {
      if (!sel.includes(i)) return l;
      const b = bboxOf([l]);
      const dx = edge === 'left' ? all.x0 - b.x0 : edge === 'right' ? all.x1 - b.x1 : edge === 'hcenter' ? all.cx - b.cx : 0;
      const dy = edge === 'top' ? all.y0 - b.y0 : edge === 'bottom' ? all.y1 - b.y1 : edge === 'vcenter' ? all.cy - b.cy : 0;
      return moveLine(l, dx, dy);
    }), `align ${edge}`);
  };
  const distribute = (axis: 'x' | 'y') => {
    if (!needs(3)) return;
    const order = [...sel].sort((a, b) => (axis === 'x' ? bboxOf([lines[a]!]).cx - bboxOf([lines[b]!]).cx : bboxOf([lines[a]!]).cy - bboxOf([lines[b]!]).cy));
    const cs = order.map((i) => (axis === 'x' ? bboxOf([lines[i]!]).cx : bboxOf([lines[i]!]).cy));
    const step = (cs[cs.length - 1]! - cs[0]!) / (cs.length - 1);
    commit(lines.map((l, i) => { const k = order.indexOf(i); if (k < 0) return l; const d = cs[0]! + step * k - cs[k]!; return moveLine(l, axis === 'x' ? d : 0, axis === 'y' ? d : 0); }), 'distribute');
  };
  const mirror = (axis: 'h' | 'v') => {
    if (!needs(1)) return;
    const g = set.grid;
    commit([...lines, ...sel.map((i) => mapLine(lines[i]!, (x, y) => (axis === 'h' ? [g - x, y] : [x, g - y])))], 'mirror copy');
  };
  const rotateCopies = (n: number) => {
    if (!needs(1) || n < 2) return;
    const c = set.grid / 2, out: string[] = [];
    for (let k = 1; k < n; k++) {
      const a = (k * 2 * Math.PI) / n, co = Math.cos(a), si = Math.sin(a);
      for (const i of sel) out.push(mapLine(lines[i]!, (x, y) => [c + (x - c) * co - (y - c) * si, c + (x - c) * si + (y - c) * co]));
    }
    commit([...lines, ...out], `${n} rotated copies`);
  };
  const toSolid = () => {
    const closed = lines.map((l) => (/\bfill=true\b/.test(l) ? l : setOpt(l, 'fill', 'true')));
    commit(closed, 'fill all');
  };
  const duotone = () => { if (needs(1)) commit([...lines.map((l, i) => l), ...sel.map((i) => setOpt(setOpt(lines[i]!, 'fill', 'true'), 'o', '0.25'))], 'duotone'); };
  return { bake, sel, boolean, outline, offsetPath, simplify, smooth, flatten, reverse, roundCorners, closePath, join, combine, breakApart, toPaths, flip, rotate, skew, alignTo, distribute, mirror, rotateCopies, toSolid, duotone };
}

export { setOpt, getOpt, bboxOf, mapLine };

/** Import helpers shared by the studio. */
export function importSvgText(svg: string, grid: number) { return svgToIconSrc(svg, grid); }
