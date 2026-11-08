/**
 * Icon system (SPEC §12, Phase 5). Icons are written in a compact shape language on a grid
 * (default 24), compiled to SVG paths, linted for consistency, and used in designs via
 * `Icon icon:search w20`. Agents write shapes, not raw path soup.
 *
 *   iconset ui grid24 stroke1.5 round
 *   icon ui/clock
 *     circle 12 12 8.5
 *     polyline 12 7.5 12 12 15 14
 */
import type { Diagnostic } from './rdl.js';

export interface IconDef {
  name: string;
  /** shape-language source (one shape per line) — the source of truth */
  src: string;
  /** optional per-icon stroke override (linted against the set) */
  stroke?: number;
  tags?: string[];
}

export interface IconSet {
  name: string;
  grid: number;
  stroke: number;
  cap: 'round' | 'butt' | 'square';
  join: 'round' | 'miter' | 'bevel';
  icons: Record<string, IconDef>;
}

export interface CompiledShape {
  d: string;
  fill: boolean;
  /** optional colour token / hex (illustrations); icons normally use currentColor */
  color?: string;
  /** vertices (for lint + editor handles) */
  points: [number, number][];
}

export interface CompiledIcon {
  shapes: CompiledShape[];
  snapped: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

const f = (n: number) => (Math.round(n * 1000) / 1000).toString();
const snap = (n: number) => Math.round(n * 2) / 2;

/** Compile shape-language source → SVG path data. Errors go to diag; coordinates snap to 0.5. */
export function compileIcon(src: string, diag: Diagnostic[] = [], lineOffset = 0): CompiledIcon {
  const shapes: CompiledShape[] = [];
  let snapped = 0;
  const num = (t: string, line: number): number => {
    const v = Number(t);
    if (!Number.isFinite(v)) {
      diag.push({ line, severity: 'error', message: `"${t}" is not a number` });
      return 0;
    }
    const s = snap(v);
    if (Math.abs(s - v) > 1e-9) snapped++;
    return s;
  };
  src.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1 + lineOffset;
    const text = raw.replace(/#.*$/, '').trim();
    if (!text) return;
    const [kind, ...rest] = text.split(/\s+/);
    const opts: Record<string, string> = {};
    const args: string[] = [];
    for (const r of rest) {
      const m = /^(\w+)=(.+)$/.exec(r);
      if (m) opts[m[1]!] = m[2]!;
      else args.push(r);
    }
    const n = (k: number) => {
      if (args.length < k) {
        diag.push({ line, severity: 'error', message: `${kind} needs ${k} numbers, got ${args.length}` });
        return Array(k).fill(0) as number[];
      }
      return args.slice(0, k).map((a) => num(a, line));
    };
    const pts = (min: number) => {
      const v = args.map((a) => num(a, line));
      if (v.length % 2 || v.length < min * 2) diag.push({ line, severity: 'error', message: `${kind} needs pairs of x y (at least ${min} points)` });
      const out: [number, number][] = [];
      for (let k = 0; k + 1 < v.length; k += 2) out.push([v[k]!, v[k + 1]!]);
      return out;
    };
    const poly = (p: [number, number][], close: boolean) => `M${p.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L')}${close ? ' Z' : ''}`;
    switch (kind) {
      case 'line': {
        const [x1, y1, x2, y2] = n(4) as [number, number, number, number];
        shapes.push({ d: `M${f(x1)} ${f(y1)} L${f(x2)} ${f(y2)}`, fill: false, points: [[x1, y1], [x2, y2]] });
        break;
      }
      case 'polyline':
      case 'check': {
        const p = pts(2);
        shapes.push({ d: poly(p, false), fill: false, points: p });
        break;
      }
      case 'polygon': {
        const p = pts(3);
        shapes.push({ d: poly(p, true), fill: false, points: p });
        break;
      }
      case 'rect': {
        const [x, y, w, h] = n(4) as [number, number, number, number];
        const r = Math.min(opts.r ? num(opts.r, line) : 0, w / 2, h / 2);
        const d = r
          ? `M${f(x + r)} ${f(y)} H${f(x + w - r)} A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)} V${f(y + h - r)} A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)} H${f(x + r)} A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)} V${f(y + r)} A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)} Z`
          : `M${f(x)} ${f(y)} H${f(x + w)} V${f(y + h)} H${f(x)} Z`;
        shapes.push({ d, fill: false, points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] });
        break;
      }
      case 'circle':
      case 'dot': {
        const [cx, cy] = n(2) as [number, number];
        const r = kind === 'dot' ? (args[2] ? num(args[2], line) : 1.25) : args[2] ? num(args[2], line) : (diag.push({ line, severity: 'error', message: 'circle needs cx cy r' }), 1);
        shapes.push({ d: `M${f(cx - r)} ${f(cy)} A${f(r)} ${f(r)} 0 1 0 ${f(cx + r)} ${f(cy)} A${f(r)} ${f(r)} 0 1 0 ${f(cx - r)} ${f(cy)} Z`, fill: kind === 'dot', points: [[cx - r, cy], [cx + r, cy], [cx, cy - r], [cx, cy + r]] });
        break;
      }
      case 'arc': {
        // arc cx cy r startDeg endDeg   (0° = 3 o'clock, clockwise)
        const [cx, cy, r] = n(3) as [number, number, number];
        const a0 = Number(args[3] ?? 0), a1 = Number(args[4] ?? 180);
        const pt = (a: number): [number, number] => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
        const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
        const sweep = (((a1 - a0) % 360) + 360) % 360;
        shapes.push({ d: `M${f(x0)} ${f(y0)} A${f(r)} ${f(r)} 0 ${sweep > 180 ? 1 : 0} 1 ${f(x1)} ${f(y1)}`, fill: false, points: [[x0, y0], [x1, y1]] });
        break;
      }
      case 'plus': {
        const [cx, cy, s] = n(3) as [number, number, number];
        const h = s / 2;
        shapes.push({ d: `M${f(cx - h)} ${f(cy)} L${f(cx + h)} ${f(cy)} M${f(cx)} ${f(cy - h)} L${f(cx)} ${f(cy + h)}`, fill: false, points: [[cx - h, cy], [cx + h, cy], [cx, cy - h], [cx, cy + h]] });
        break;
      }
      case 'path': {
        const toks = args.join(' ').match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
        let d = '';
        const points: [number, number][] = [];
        let cmd = '';
        let k = 0;
        let cur: [number, number] = [0, 0];
        const take = () => num(toks[k++] ?? 'NaN', line);
        while (k < toks.length) {
          const t = toks[k]!;
          if (/[A-Za-z]/.test(t)) {
            cmd = t;
            k++;
            if (!/^[MLHVQCZ]$/.test(cmd)) {
              diag.push({ line, severity: 'error', message: `path command "${cmd}" not allowed — use absolute M L H V Q C Z (use arc/circle/rect shapes for curves)` });
              return;
            }
            if (cmd === 'Z') { d += ' Z'; continue; }
          }
          switch (cmd) {
            case 'M':
            case 'L': { const x = take(), y = take(); cur = [x, y]; points.push(cur); d += ` ${cmd}${f(x)} ${f(y)}`; break; }
            case 'H': { const x = take(); cur = [x, cur[1]]; points.push(cur); d += ` H${f(x)}`; break; }
            case 'V': { const y = take(); cur = [cur[0], y]; points.push(cur); d += ` V${f(y)}`; break; }
            case 'Q': { const a = take(), b = take(), x = take(), y = take(); cur = [x, y]; points.push(cur); d += ` Q${f(a)} ${f(b)} ${f(x)} ${f(y)}`; break; }
            case 'C': { const a = take(), b = take(), c = take(), e = take(), x = take(), y = take(); cur = [x, y]; points.push(cur); d += ` C${f(a)} ${f(b)} ${f(c)} ${f(e)} ${f(x)} ${f(y)}`; break; }
            default:
              diag.push({ line, severity: 'error', message: 'path must start with a command (M)' });
              return;
          }
        }
        if (!d.trim().startsWith('M')) diag.push({ line, severity: 'error', message: 'path must start with M' });
        shapes.push({ d: d.trim(), fill: opts.fill === 'true', points });
        break;
      }
      default:
        diag.push({ line, severity: 'error', message: `Unknown shape "${kind}". Use: line polyline polygon rect circle dot arc path check plus` });
    }
    // shape options for illustrations: fill=true (closed shapes), c=<color token|#hex>
    const last = shapes[shapes.length - 1];
    if (last && shapes.length && ['polygon', 'rect', 'circle', 'path'].includes(kind!) && opts.fill === 'true') last.fill = true;
    if (last && opts.c) {
      if (!/^(#[0-9a-fA-F]{3,8}|[\w.-]+)$/.test(opts.c)) diag.push({ line, severity: 'error', message: `c=${opts.c} must be a colour token or #hex` });
      else last.color = opts.c;
    }
  });
  const all = shapes.flatMap((s) => s.points);
  const bbox = all.length
    ? { x0: Math.min(...all.map((p) => p[0])), y0: Math.min(...all.map((p) => p[1])), x1: Math.max(...all.map((p) => p[0])), y1: Math.max(...all.map((p) => p[1])) }
    : { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { shapes, snapped, bbox };
}

// ---------------------------------------------------------------- output

export function iconSvg(set: IconSet, icon: IconDef, opts: { size?: number; title?: string; className?: string } = {}): string {
  const c = compileIcon(icon.src);
  const sw = icon.stroke ?? set.stroke;
  const size = opts.size ?? set.grid;
  const paths = c.shapes
    .map((s) => (s.fill ? `<path d="${s.d}" fill="currentColor" stroke="none"/>` : `<path d="${s.d}"/>`))
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${set.grid} ${set.grid}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="${set.cap}" stroke-linejoin="${set.join}"${opts.className ? ` class="${opts.className}"` : ''}${opts.title ? ` role="img" aria-label="${opts.title}"` : ' aria-hidden="true"'}>${opts.title ? `<title>${opts.title}</title>` : ''}${paths}</svg>`;
}

const pascal = (s: string) => s.replace(/(^|[-_\s]+)(\w)/g, (_, __, c: string) => c.toUpperCase());

/** React (TSX) component for one icon — currentColor, sized by prop, accessible by default. */
export function iconReact(set: IconSet, icon: IconDef): string {
  const c = compileIcon(icon.src);
  const sw = icon.stroke ?? set.stroke;
  const name = `${pascal(icon.name)}Icon`;
  const paths = c.shapes.map((s) => (s.fill ? `      <path d="${s.d}" fill="currentColor" stroke="none" />` : `      <path d="${s.d}" />`)).join('\n');
  return `import type { SVGProps } from 'react';

export function ${name}({ size = ${set.grid === 24 ? 20 : set.grid}, title, ...props }: SVGProps<SVGSVGElement> & { size?: number; title?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 ${set.grid} ${set.grid}" fill="none" stroke="currentColor"
      strokeWidth={${sw}} strokeLinecap="${set.cap}" strokeLinejoin="${set.join}" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} {...props}>
      {title && <title>{title}</title>}
${paths}
    </svg>
  );
}
`;
}

/** One SVG sprite with <symbol id="set-name"> for every icon. */
export function iconSprite(set: IconSet): string {
  const symbols = Object.values(set.icons)
    .map((ic) => {
      const c = compileIcon(ic.src);
      const sw = ic.stroke ?? set.stroke;
      return `<symbol id="${set.name}-${ic.name}" viewBox="0 0 ${set.grid} ${set.grid}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="${set.cap}" stroke-linejoin="${set.join}">${c.shapes.map((s) => (s.fill ? `<path d="${s.d}" fill="currentColor" stroke="none"/>` : `<path d="${s.d}"/>`)).join('')}</symbol>`;
    })
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n${symbols}\n</svg>\n`;
}

// ---------------------------------------------------------------- lint

export interface IconIssue {
  code: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  icon: string;
  message: string;
}

export function lintIcons(sets: Record<string, IconSet> | undefined, only?: string[]): IconIssue[] {
  const issues: IconIssue[] = [];
  for (const set of Object.values(sets ?? {})) {
    const areas: number[] = [];
    const compiled = new Map<string, CompiledIcon>();
    for (const ic of Object.values(set.icons)) {
      const diag: Diagnostic[] = [];
      const c = compileIcon(ic.src, diag);
      compiled.set(ic.name, c);
      if (c.shapes.length) areas.push((c.bbox.x1 - c.bbox.x0) * (c.bbox.y1 - c.bbox.y0));
    }
    const sorted = [...areas].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    for (const ic of Object.values(set.icons)) {
      const key = `${set.name}/${ic.name}`;
      if (only && !only.includes(key)) continue;
      const add = (code: string, severity: IconIssue['severity'], message: string) => issues.push({ code, severity, icon: key, message });
      const diag: Diagnostic[] = [];
      const c = compileIcon(ic.src, diag);
      for (const d of diag.filter((x) => x.severity === 'error')) add('I00', 'P0', `line ${d.line}: ${d.message}`);
      if (c.snapped) add('I01', 'P3', `${c.snapped} coordinate(s) snapped to the 0.5 grid — write them on-grid for crisp rendering`);
      const g = set.grid, safe = g / 16; // 1.5 on a 24 grid
      if (c.shapes.length && (c.bbox.x0 < safe || c.bbox.y0 < safe || c.bbox.x1 > g - safe || c.bbox.y1 > g - safe)) add('I02', 'P2', `extends outside the live area (${safe}–${g - safe}); strokes will clip or look heavier than the set`);
      if (ic.stroke !== undefined && ic.stroke !== set.stroke) add('I03', 'P2', `stroke ${ic.stroke} differs from the set's ${set.stroke} — mixed weights look accidental`);
      const tiny = c.shapes.filter((s) => !s.fill).some((s) => {
        for (let k = 1; k < s.points.length; k++) {
          const [ax, ay] = s.points[k - 1]!, [bx, by] = s.points[k]!;
          const len = Math.hypot(bx - ax, by - ay);
          if (len > 0 && len < 1) return true;
        }
        return false;
      });
      if (tiny) add('I04', 'P3', 'has a segment shorter than 1 unit — it will vanish at 16px');
      if (c.shapes.length > 10) add('I05', 'P3', `${c.shapes.length} shapes — simplify; detailed icons read as noise at small sizes`);
      const area = (c.bbox.x1 - c.bbox.x0) * (c.bbox.y1 - c.bbox.y0);
      if (median && c.shapes.length && Object.keys(set.icons).length >= 4 && (area < median * 0.45 || area > median * 1.9)) add('I06', 'P3', `optical size is ${area < median ? 'smaller' : 'larger'} than the rest of the set — scale it to match`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------- starter set

/** A calm, consistent 24-grid, 1.5-stroke starter set — written in the shape language. */
export function defaultIcons(): Record<string, IconSet> {
  const icons: Record<string, string> = {
    search: 'circle 11 11 6\nline 15.5 15.5 20 20',
    plus: 'line 12 5 12 19\nline 5 12 19 12',
    close: 'line 6 6 18 18\nline 18 6 6 18',
    check: 'polyline 5 12.5 10 17.5 19 7',
    'chevron-right': 'polyline 9 6 15 12 9 18',
    'chevron-left': 'polyline 15 6 9 12 15 18',
    'chevron-down': 'polyline 6 9 12 15 18 9',
    play: 'path M8 5.5 L18.5 12 L8 18.5 Z',
    stop: 'rect 6 6 12 12 r=2',
    more: 'dot 6 12\ndot 12 12\ndot 18 12',
    filter: 'line 4 6.5 20 6.5\nline 7 12 17 12\nline 10 17.5 14 17.5',
    flask: 'line 9.5 3.5 14.5 3.5\npath M10.5 3.5 L10.5 9.5 L5.5 18 Q4.5 20 6.5 20 L17.5 20 Q19.5 20 18.5 18 L13.5 9.5 L13.5 3.5\nline 7.5 15 16.5 15',
    clock: 'circle 12 12 8.5\npolyline 12 7.5 12 12 15 14',
    alert: 'circle 12 12 8.5\nline 12 7.5 12 13\ndot 12 16.5 1',
    info: 'circle 12 12 8.5\nline 12 11 12 16.5\ndot 12 7.5 1',
    trash: 'line 4.5 7 19.5 7\npolyline 9 7 9 4.5 15 4.5 15 7\npath M6.5 7 L7.5 19.5 L16.5 19.5 L17.5 7\nline 10 11 10 16\nline 14 11 14 16',
    edit: 'path M15.5 4.5 L19.5 8.5 L9 19 L4.5 19.5 L5 15 Z\nline 13.5 6.5 17.5 10.5',
    external: 'polyline 14 4.5 19.5 4.5 19.5 10\nline 19.5 4.5 11 13\npolyline 17 13.5 17 19.5 4.5 19.5 4.5 7 10.5 7',
    user: 'circle 12 8.5 3.5\npath M5 19.5 Q5 14.5 12 14.5 Q19 14.5 19 19.5',
    calendar: 'rect 4.5 5.5 15 14 r=2\nline 4.5 10 19.5 10\nline 9 3.5 9 7\nline 15 3.5 15 7',
    retry: 'arc 12 12 7.5 0 315\npolyline 19.5 4 19.5 8.5 15 8.5',
  };
  return {
    ui: {
      name: 'ui',
      grid: 24,
      stroke: 1.5,
      cap: 'round',
      join: 'round',
      icons: Object.fromEntries(Object.entries(icons).map(([name, src]) => [name, { name, src }])),
    },
  };
}

/** Resolve "search" or "ui/search" → [set, icon]. */
export function findIcon(sets: Record<string, IconSet> | undefined, ref: string): { set: IconSet; icon: IconDef } | undefined {
  if (!sets) return undefined;
  const [a, b] = ref.includes('/') ? ref.split('/', 2) : [undefined, ref];
  if (a) {
    const set = sets[a];
    const icon = set?.icons[b!];
    return set && icon ? { set, icon } : undefined;
  }
  for (const set of Object.values(sets)) if (set.icons[b!]) return { set, icon: set.icons[b!]! };
  return undefined;
}
