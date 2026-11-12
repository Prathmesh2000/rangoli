/**
 * SVG ↔ shape language. Any SVG (a file someone drew, an icon pack, a pasted snippet) becomes ordinary
 * editable shapes on the set's grid. Paths are normalised to absolute M L C Z, so every tool downstream
 * only has one kind of path to deal with.
 */

export interface PathNode { x: number; y: number; ix: number; iy: number; ox: number; oy: number }
export interface SubPath { closed: boolean; nodes: PathNode[] }

const n3 = (v: number) => String(Math.round(v * 1000) / 1000);

type Seg = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z'];

function arcToCubics(x1: number, y1: number, rx0: number, ry0: number, phiDeg: number, large: number, sweep: number, x2: number, y2: number): number[][] {
  if (!rx0 || !ry0) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
  let rx = Math.abs(rx0), ry = Math.abs(ry0);
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (den || 1)));
  const cxp = (k * rx * yp) / ry, cyp = (-k * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const th1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dth = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  if (sweep && dth < 0) dth += 2 * Math.PI;
  const parts = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9));
  const step = dth / parts, t = (4 / 3) * Math.tan(step / 4);
  const out: number[][] = [];
  const pt = (px: number, py: number) => [cos * px * rx - sin * py * ry + cx, sin * px * rx + cos * py * ry + cy] as const;
  for (let i = 0; i < parts; i++) {
    const a = th1 + i * step, b = a + step;
    const [ax, ay] = [Math.cos(a), Math.sin(a)], [bx, by] = [Math.cos(b), Math.sin(b)];
    const [c1x, c1y] = pt(ax - t * ay, ay + t * ax), [c2x, c2y] = pt(bx + t * by, by - t * bx);
    const [ex, ey] = i === parts - 1 ? [x2, y2] : pt(bx, by);
    out.push([c1x, c1y, c2x, c2y, ex, ey]);
  }
  return out;
}

/** Parse any SVG path data into absolute segments (M L C Z only). */
export function pathSegments(d: string): Seg[] {
  const toks = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: Seg[] = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0, qx = 0, qy = 0;
  let prev = '';
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i]!)) cmd = toks[i++]!;
    if (!cmd) break;
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (C) {
      case 'M': x = num() + ox; y = num() + oy; sx = x; sy = y; out.push(['M', x, y]); cmd = rel ? 'l' : 'L'; break;
      case 'L': x = num() + ox; y = num() + oy; out.push(['L', x, y]); break;
      case 'H': x = num() + ox; out.push(['L', x, y]); break;
      case 'V': y = num() + oy; out.push(['L', x, y]); break;
      case 'C': { const a = num() + ox, b = num() + oy; cx = num() + ox; cy = num() + oy; x = num() + ox; y = num() + oy; out.push(['C', a, b, cx, cy, x, y]); break; }
      case 'S': { const a = /[CS]/.test(prev) ? 2 * x - cx : x, b = /[CS]/.test(prev) ? 2 * y - cy : y; cx = num() + ox; cy = num() + oy; x = num() + ox; y = num() + oy; out.push(['C', a, b, cx, cy, x, y]); break; }
      case 'Q': case 'T': {
        if (C === 'Q') { qx = num() + ox; qy = num() + oy; } else { qx = /[QT]/.test(prev) ? 2 * x - qx : x; qy = /[QT]/.test(prev) ? 2 * y - qy : y; }
        const ex = num() + ox, ey = num() + oy;
        out.push(['C', x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey]);
        x = ex; y = ey;
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
        const ex = num() + ox, ey = num() + oy;
        for (const c of arcToCubics(x, y, rx, ry, rot, large, sweep, ex, ey)) out.push(['C', c[0]!, c[1]!, c[2]!, c[3]!, c[4]!, c[5]!]);
        x = ex; y = ey;
        break;
      }
      case 'Z': out.push(['Z']); x = sx; y = sy; cmd = ''; break;
      default: return out;
    }
    prev = C;
  }
  return out;
}

export const segmentsToD = (segs: Seg[]) => segs.map((s) => s[0] + s.slice(1).map((v) => n3(v as number)).join(' ')).join(' ');
/** Absolute M L C Z form of any path data. */
export const normalizePath = (d: string) => segmentsToD(pathSegments(d));

/** Editable form: subpaths of anchor nodes with handles (absolute coordinates). */
export function toSubpaths(d: string): SubPath[] {
  const out: SubPath[] = [];
  let cur: SubPath | undefined;
  for (const s of pathSegments(d)) {
    if (s[0] === 'M') { cur = { closed: false, nodes: [{ x: s[1], y: s[2], ix: s[1], iy: s[2], ox: s[1], oy: s[2] }] }; out.push(cur); }
    else if (s[0] === 'L') cur?.nodes.push({ x: s[1], y: s[2], ix: s[1], iy: s[2], ox: s[1], oy: s[2] });
    else if (s[0] === 'C' && cur) {
      const last = cur.nodes[cur.nodes.length - 1]!;
      last.ox = s[1]; last.oy = s[2];
      cur.nodes.push({ x: s[5], y: s[6], ix: s[3], iy: s[4], ox: s[5], oy: s[6] });
    } else if (s[0] === 'Z' && cur) {
      cur.closed = true;
      // a final node sitting on the first is the same point
      const a = cur.nodes[0]!, z = cur.nodes[cur.nodes.length - 1]!;
      if (cur.nodes.length > 1 && Math.hypot(a.x - z.x, a.y - z.y) < 1e-3) { a.ix = z.ix; a.iy = z.iy; cur.nodes.pop(); }
    }
  }
  return out;
}

export function fromSubpaths(subs: SubPath[]): string {
  const parts: string[] = [];
  for (const s of subs) {
    if (!s.nodes.length) continue;
    const [a] = s.nodes;
    parts.push(`M${n3(a!.x)} ${n3(a!.y)}`);
    const seg = (p: PathNode, q: PathNode) => {
      const straight = p.ox === p.x && p.oy === p.y && q.ix === q.x && q.iy === q.y;
      parts.push(straight ? `L${n3(q.x)} ${n3(q.y)}` : `C${n3(p.ox)} ${n3(p.oy)} ${n3(q.ix)} ${n3(q.iy)} ${n3(q.x)} ${n3(q.y)}`);
    };
    for (let i = 1; i < s.nodes.length; i++) seg(s.nodes[i - 1]!, s.nodes[i]!);
    if (s.closed) { if (s.nodes.length > 1) seg(s.nodes[s.nodes.length - 1]!, a!); parts.push('Z'); }
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------- import

type M = [number, number, number, number, number, number];
const IDENT: M = [1, 0, 0, 1, 0, 0];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];

function parseTransform(t: string | undefined): M {
  let out = IDENT;
  for (const m of (t ?? '').matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\(([^)]*)\)/g)) {
    const v = m[2]!.split(/[\s,]+/).filter(Boolean).map(Number);
    const a = ((v[0] ?? 0) * Math.PI) / 180;
    let x: M = IDENT;
    if (m[1] === 'matrix' && v.length === 6) x = v as M;
    if (m[1] === 'translate') x = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
    if (m[1] === 'scale') x = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
    if (m[1] === 'skewX') x = [1, 0, Math.tan(a), 1, 0, 0];
    if (m[1] === 'skewY') x = [1, Math.tan(a), 0, 1, 0, 0];
    if (m[1] === 'rotate') {
      x = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
      if (v.length === 3) x = mul(mul([1, 0, 0, 1, v[1]!, v[2]!], x), [1, 0, 0, 1, -v[1]!, -v[2]!]);
    }
    out = mul(out, x);
  }
  return out;
}

/** Apply any point function to path data. */
export function transformPath(d: string, f: (x: number, y: number) => [number, number]): string {
  return segmentsToD(pathSegments(d).map((s): Seg => {
    if (s[0] === 'Z') return s;
    if (s[0] === 'C') return ['C', ...f(s[1], s[2]), ...f(s[3], s[4]), ...f(s[5], s[6])];
    return [s[0], ...f(s[1], s[2])] as Seg;
  }));
}

/** A stroke whose width changes along its length, as a filled outline. widths: evenly spaced along the path. */
export function variableStroke(d: string, widths: number[]): string {
  const parts: string[] = [];
  for (const sub of toSubpaths(d)) {
    const count = sub.closed ? sub.nodes.length : sub.nodes.length - 1;
    const pts: [number, number][] = [];
    for (let k = 0; k < count; k++) {
      const p = sub.nodes[k]!, q = sub.nodes[(k + 1) % sub.nodes.length]!;
      for (let i = 0; i < 24; i++) {
        const t = i / 24, m = 1 - t;
        pts.push([m * m * m * p.x + 3 * m * m * t * p.ox + 3 * m * t * t * q.ix + t * t * t * q.x, m * m * m * p.y + 3 * m * m * t * p.oy + 3 * m * t * t * q.iy + t * t * t * q.y]);
      }
    }
    const end = sub.closed ? sub.nodes[0]! : sub.nodes[sub.nodes.length - 1]!;
    pts.push([end.x, end.y]);
    if (pts.length < 2) continue;
    const lens = [0];
    for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
    const total = lens[lens.length - 1]! || 1;
    const widthAt = (t: number) => {
      if (widths.length === 1) return widths[0]!;
      const x = t * (widths.length - 1), i = Math.min(widths.length - 2, Math.floor(x)), f = x - i;
      return widths[i]! + (widths[i + 1]! - widths[i]!) * f;
    };
    const left: string[] = [], right: string[] = [];
    pts.forEach(([x, y], i) => {
      const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(pts.length - 1, i + 1)]!;
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const h = widthAt(lens[i]! / total) / 2, nx = (-dy / len) * h, ny = (dx / len) * h;
      left.push(`${n3(x + nx)} ${n3(y + ny)}`);
      right.unshift(`${n3(x - nx)} ${n3(y - ny)}`);
    });
    parts.push(`M${[...left, ...right].join(' L')} Z`);
  }
  return parts.join(' ');
}

const applyM = (d: string, m: M) => {
  const p = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  return segmentsToD(pathSegments(d).map((s): Seg => {
    if (s[0] === 'Z') return s;
    if (s[0] === 'C') return ['C', ...p(s[1], s[2]), ...p(s[3], s[4]), ...p(s[5], s[6])];
    return [s[0], ...p(s[1], s[2])] as Seg;
  }));
};

function primitiveToD(tag: string, a: Record<string, string>): string | undefined {
  const n = (k: string, d = 0) => Number(a[k] ?? d) || d;
  switch (tag) {
    case 'path': return a.d;
    case 'line': return `M${n('x1')} ${n('y1')} L${n('x2')} ${n('y2')}`;
    case 'polyline': case 'polygon': {
      const v = (a.points ?? '').trim().split(/[\s,]+/).map(Number);
      if (v.length < 4) return undefined;
      let d = `M${v[0]} ${v[1]}`;
      for (let i = 2; i + 1 < v.length; i += 2) d += ` L${v[i]} ${v[i + 1]}`;
      return tag === 'polygon' ? `${d} Z` : d;
    }
    case 'circle': case 'ellipse': {
      const cx = n('cx'), cy = n('cy'), rx = tag === 'circle' ? n('r') : n('rx'), ry = tag === 'circle' ? n('r') : n('ry');
      return `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
    }
    case 'rect': {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height');
      const rx = Math.min(n('rx', n('ry')), w / 2), ry = Math.min(n('ry', n('rx')), h / 2);
      if (!rx && !ry) return `M${x} ${y} H${x + w} V${y + h} H${x} Z`;
      return `M${x + rx} ${y} H${x + w - rx} A${rx} ${ry} 0 0 1 ${x + w} ${y + ry} V${y + h - ry} A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} H${x + rx} A${rx} ${ry} 0 0 1 ${x} ${y + h - ry} V${y + ry} A${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`;
    }
    default: return undefined;
  }
}

const INHERIT = ['fill', 'stroke', 'stroke-width', 'fill-rule', 'opacity', 'stroke-dasharray'];
const hexColour = (c: string): string | undefined => {
  const v = c.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return /^#[0-9a-f]{6}$/.test(v) ? v : undefined;
};
const isInk = (c: string) => ['currentcolor', '#000', '#000000', 'black'].includes(c.trim().toLowerCase());

/**
 * Turn SVG markup into shape-language source on a square grid. The result is marked `exact` so curves
 * keep their true positions. Throws when the markup has nothing drawable.
 */
export function svgToIconSrc(svg: string, grid = 24): { src: string; warnings: string[]; stroke?: number } {
  const warnings: string[] = [];
  const head = /<svg\b([^>]*)>/i.exec(svg);
  const attrsOf = (s: string) => Object.fromEntries([...s.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1]!.toLowerCase(), m[2] ?? m[3] ?? '']));
  const root = head ? attrsOf(head[1]!) : {};
  const vb = (root.viewbox ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
  const [vx, vy, vw, vh] = vb.length === 4 ? (vb as [number, number, number, number]) : [0, 0, parseFloat(root.width ?? '') || grid, parseFloat(root.height ?? '') || grid];
  const scale = grid / Math.max(vw, vh);
  const base: M = [scale, 0, 0, scale, -vx * scale + (grid - vw * scale) / 2, -vy * scale + (grid - vh * scale) / 2];
  const body = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<(defs|clipPath|mask|title|desc|metadata|style)\b[\s\S]*?<\/\1>/gi, (m, t: string) => { if (/style|clipPath|mask/i.test(t)) warnings.push(`<${t}> was ignored`); return ''; });
  type Frame = { m: M; attrs: Record<string, string> };
  const stack: Frame[] = [{ m: base, attrs: Object.fromEntries(INHERIT.filter((k) => root[k] !== undefined).map((k) => [k, root[k]!])) }];
  const lines: string[] = [];
  let widest = 0;
  for (const m of body.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g)) {
    const [, close, tagRaw, rest, self] = m;
    const tag = tagRaw!.toLowerCase();
    if (tag === 'svg') continue;
    if (close) { if (tag === 'g' && stack.length > 1) stack.pop(); continue; }
    const a = attrsOf(rest!);
    const styleBits = Object.fromEntries((a.style ?? '').split(';').map((x) => x.split(':').map((y) => y.trim())).filter((x) => x.length === 2));
    Object.assign(a, Object.fromEntries(INHERIT.filter((k) => styleBits[k]).map((k) => [k, styleBits[k]])));
    const top = stack[stack.length - 1]!;
    const attrs = { ...top.attrs, ...Object.fromEntries(INHERIT.filter((k) => a[k] !== undefined).map((k) => [k, a[k]!])) };
    const matrix = a.transform ? mul(top.m, parseTransform(a.transform)) : top.m;
    if (tag === 'g') { if (!self) stack.push({ m: matrix, attrs }); continue; }
    const raw = primitiveToD(tag, a);
    if (!raw) { if (['image', 'text', 'use', 'lineargradient', 'radialgradient'].includes(tag)) warnings.push(`<${tag}> was ignored`); continue; }
    const d = applyM(raw, matrix);
    const fill = attrs.fill ?? '#000';
    const stroke = attrs.stroke ?? 'none';
    const common = `${attrs.opacity && Number(attrs.opacity) < 1 ? ` o=${n3(Number(attrs.opacity))}` : ''}`;
    if (fill !== 'none' && !fill.startsWith('url(')) {
      const c = isInk(fill) ? '' : hexColour(fill) ? ` c=${hexColour(fill)}` : '';
      lines.push(`path ${d}${attrs['fill-rule'] === 'evenodd' ? ' rule=evenodd' : ''} fill=true${c}${common}`);
    } else if (fill.startsWith('url(')) warnings.push('a gradient fill was replaced by the icon colour');
    if (stroke !== 'none') {
      const w = (Number(attrs['stroke-width'] ?? 1) || 1) * scale;
      widest = Math.max(widest, w);
      const c = isInk(stroke) ? '' : hexColour(stroke) ? ` c=${hexColour(stroke)}` : '';
      const dash = attrs['stroke-dasharray'] && attrs['stroke-dasharray'] !== 'none' ? ` dash=${attrs['stroke-dasharray'].trim().split(/[\s,]+/).map((v) => n3(Number(v) * scale)).join(',')}` : '';
      lines.push(`path ${d} w=${n3(w)}${c}${dash}${common}`);
    }
  }
  if (!lines.length) throw new Error('This SVG has no shapes that can be used as an icon');
  return { src: ['exact', ...lines].join('\n'), warnings: [...new Set(warnings)], ...(widest ? { stroke: Math.round(widest * 100) / 100 } : {}) };
}
