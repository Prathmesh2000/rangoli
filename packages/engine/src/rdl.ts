/**
 * RDL — Rangoli Description Language. Compact, indentation-based, token-aware.
 * See docs/SPEC.md §5.
 *
 *   Card#n1 col gap3 p4 w320 fill:surface stroke:border r2
 *     Text#n3 title-sm "Login smoke test"
 *     @Button#n6 variant=primary size=sm "Run again"
 *
 * Edit commands:  set #id <flags> | insert #id [start|end|before #x|after #x] + block
 *                 move #id (into #p [start|end] | before #x | after #x) | delete #id | replace #id + block
 */
import { RangoliDocument, RangoliError, type Op } from './document.js';
import { isTokenRef, type ComponentDef, type Dim, type Layout, type Len, type Page, type Paint, type RNode, type Sizing, type Style, type TokenRef } from './model.js';
import { TokenResolver } from './tokens.js';
import { parseMotionLines, targetKey } from './motion.js';
import { parseProtoLines, parseTimelineLines } from './prototype.js';
import { compileIcon, findIcon, type IconDef, type IconSet } from './icons.js';
import { findAsset } from './images.js';
import { expandPatterns } from './patterns.js';
import { libraryComponents } from './library.js';
import { LANGUAGES, languageOf, languageTokens } from './languages.js';
import { expandTemplate, slotName } from './components.js';

export interface Diagnostic {
  line: number;
  severity: 'error' | 'warning';
  message: string;
}

// ---------------------------------------------------------------- tokenizer

interface Line {
  no: number;
  indent: number;
  toks: string[];
}

export function tokenizeLine(src: string): string[] {
  const toks: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '#' && (src[i + 1] === ' ' || i + 1 === src.length)) break; // comment
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      toks.push(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && src[j] !== ' ' && src[j] !== '\t') {
      if (src[j] === '"') { // key="quoted value"
        j++;
        while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      }
      j++;
    }
    toks.push(src.slice(i, j));
    i = j;
  }
  return toks;
}

function lex(src: string): Line[] {
  const out: Line[] = [];
  src.replace(/\r\n?/g, '\n').split('\n').forEach((raw, idx) => {
    const expanded = raw.replace(/\t/g, '  ');
    const indent = expanded.length - expanded.trimStart().length;
    const toks = tokenizeLine(expanded.trim());
    if (toks.length) out.push({ no: idx + 1, indent, toks });
  });
  return out;
}

const unquote = (t: string): string => {
  try { return JSON.parse(t) as string; } catch { return t.slice(1, -1); }
};

// ---------------------------------------------------------------- parse tree

export interface PNode {
  line: number;
  head: string; // Name[#id] or @Comp[#id]
  flags: string[];
  text?: string;
  children: PNode[];
}

export type Command =
  | { kind: 'create'; nodes: PNode[] }
  | { kind: 'set'; line: number; id: string; flags: string[]; text?: string }
  | { kind: 'insert'; line: number; target: string; where: Where; nodes: PNode[] }
  | { kind: 'move'; line: number; id: string; where: Where }
  | { kind: 'delete'; line: number; id: string }
  | { kind: 'replace'; line: number; id: string; nodes: PNode[] }
  | { kind: 'motion'; line: number; base: string; filters: Record<string, string>; clear: boolean; lines: { no: number; toks: string[] }[] }
  | { kind: 'proto'; line: number; node: string | null; start?: string; clear: boolean; lines: { no: number; toks: string[] }[] }
  | { kind: 'timeline'; line: number; name: string; clear: boolean; lines: { no: number; toks: string[] }[] }
  | { kind: 'iconset'; line: number; name: string; opts: string[] }
  | { kind: 'icon'; line: number; set: string; name: string; opts: string[]; lines: { no: number; toks: string[] }[] }
  | { kind: 'token'; line: number; path: string; value: string; modes: Record<string, string> }
  | { kind: 'language'; line: number; id: string; opts: Record<string, string> }
  | { kind: 'component'; line: number; name: string; from?: string; detach?: string; opts: string[]; description?: string; lines: { no: number; toks: string[] }[] };

export type Where = { pos: 'start' | 'end' } | { pos: 'before' | 'after'; ref: string } | { pos: 'index'; index: number };

const COMMANDS = new Set(['set', 'insert', 'move', 'delete', 'replace']);
const isCommandLine = (ln: Line) =>
  (COMMANDS.has(ln.toks[0]!) && !!ln.toks[1]?.startsWith('#')) ||
  (ln.toks[0] === 'motion' && /^[@#]/.test(ln.toks[1] ?? '')) ||
  (ln.toks[0] === 'proto' && /^(#|start$)/.test(ln.toks[1] ?? '')) ||
  (ln.toks[0] === 'timeline' && /^[\w-]+$/.test(ln.toks[1] ?? '') && ln.toks.length <= 4) ||
  (ln.toks[0] === 'icon' && /^[\w-]+\/[\w~.-]+$/.test(ln.toks[1] ?? '')) ||
  (ln.toks[0] === 'iconset' && /^[\w-]+$/.test(ln.toks[1] ?? '')) ||
  (ln.toks[0] === 'component' && /^@[A-Za-z][\w-]*$/.test(ln.toks[1] ?? '')) ||
  (ln.toks[0] === 'token' && /^[A-Za-z][\w-]*(\.[\w-]+)+$/.test(ln.toks[1] ?? '') && ln.toks.length >= 3) ||
  (ln.toks[0] === 'language' && /^[a-z][\w-]*$/.test(ln.toks[1] ?? '') && ln.toks.slice(2).every((t) => /^[\w-]+=/.test(t)));

export function parseRdl(src: string): { commands: Command[]; errors: Diagnostic[] } {
  const lines = lex(expandPatterns(src));
  const errors: Diagnostic[] = [];
  const commands: Command[] = [];
  let i = 0;

  const block = (baseIndent: number): PNode[] => {
    // collect lines with indent > baseIndent into a node forest
    const roots: PNode[] = [];
    const stack: { indent: number; node: PNode }[] = [];
    while (i < lines.length && lines[i]!.indent > baseIndent && !isCommandLine(lines[i]!)) {
      const ln = lines[i++]!;
      const node = lineToPNode(ln);
      while (stack.length && stack[stack.length - 1]!.indent >= ln.indent) stack.pop();
      if (stack.length) stack[stack.length - 1]!.node.children.push(node);
      else roots.push(node);
      stack.push({ indent: ln.indent, node });
    }
    return roots;
  };

  while (i < lines.length) {
    const ln = lines[i]!;
    const kw = ln.toks[0]!;
    if (kw === 'motion' && /^[@#]/.test(ln.toks[1] ?? '')) {
      i++;
      const filters: Record<string, string> = {};
      let clear = false;
      for (const t of ln.toks.slice(2)) {
        const m = /^([\w-]+)=(.+)$/.exec(t);
        if (m) filters[m[1]!] = m[2]!;
        else if (t === 'none') clear = true;
        else errors.push({ line: ln.no, severity: 'error', message: `Unexpected "${t}" in motion header (use: motion @Comp [axis=value] | motion #id | … none)` });
      }
      const body: { no: number; toks: string[] }[] = [];
      while (i < lines.length && lines[i]!.indent > ln.indent) {
        body.push({ no: lines[i]!.no, toks: lines[i]!.toks });
        i++;
      }
      commands.push({ kind: 'motion', line: ln.no, base: ln.toks[1]!, filters, clear, lines: body });
      continue;
    }
    if ((kw === 'token' || kw === 'language') && isCommandLine(ln)) {
      i++;
      const kv: Record<string, string> = {};
      const rest = ln.toks.slice(kw === 'token' ? 3 : 2);
      for (const t of rest) {
        const m = /^([\w-]+)=(.+)$/.exec(t);
        if (m) kv[m[1]!] = m[2]!.startsWith('"') ? unquote(m[2]!) : m[2]!;
        else errors.push({ line: ln.no, severity: 'error', message: `Unexpected "${t}" — use key=value (e.g. dark=#60a5fa)` });
      }
      if (kw === 'token') commands.push({ kind: 'token', line: ln.no, path: ln.toks[1]!, value: ln.toks[2]!.startsWith('"') ? unquote(ln.toks[2]!) : ln.toks[2]!, modes: kv });
      else commands.push({ kind: 'language', line: ln.no, id: ln.toks[1]!, opts: kv });
      continue;
    }
    if (kw === 'component' && isCommandLine(ln)) {
      i++;
      const body: { no: number; toks: string[] }[] = [];
      while (i < lines.length && lines[i]!.indent > ln.indent) {
        body.push({ no: lines[i]!.no, toks: lines[i]!.toks });
        i++;
      }
      const head = ln.toks.slice(2);
      let from: string | undefined;
      let detach: string | undefined;
      let description: string | undefined;
      const opts: string[] = [];
      for (let k = 0; k < head.length; k++) {
        const t = head[k]!;
        if (t === 'from') from = head[++k]?.replace(/^#/, '');
        else if (t === 'detach') detach = head[++k]?.replace(/^#/, '');
        else if (t.startsWith('"')) description = unquote(t);
        else opts.push(t);
      }
      commands.push({ kind: 'component', line: ln.no, name: ln.toks[1]!.slice(1), from, detach, opts, description, lines: body });
      continue;
    }
    if ((kw === 'icon' || kw === 'iconset') && isCommandLine(ln)) {
      i++;
      const body: { no: number; toks: string[] }[] = [];
      while (i < lines.length && lines[i]!.indent > ln.indent) {
        body.push({ no: lines[i]!.no, toks: lines[i]!.toks });
        i++;
      }
      if (kw === 'iconset') commands.push({ kind: 'iconset', line: ln.no, name: ln.toks[1]!, opts: ln.toks.slice(2) });
      else {
        const [set, name] = ln.toks[1]!.split('/') as [string, string];
        commands.push({ kind: 'icon', line: ln.no, set, name, opts: ln.toks.slice(2), lines: body });
      }
      continue;
    }
    if ((kw === 'proto' || kw === 'timeline') && isCommandLine(ln)) {
      i++;
      const body: { no: number; toks: string[] }[] = [];
      while (i < lines.length && lines[i]!.indent > ln.indent) {
        body.push({ no: lines[i]!.no, toks: lines[i]!.toks });
        i++;
      }
      const clear = ln.toks.includes('none');
      if (kw === 'proto') {
        if (ln.toks[1] === 'start') {
          const f = ln.toks[2];
          if (!f?.startsWith('#') && f !== 'none') errors.push({ line: ln.no, severity: 'error', message: 'Use: proto start #frameId' });
          commands.push({ kind: 'proto', line: ln.no, node: null, start: f === 'none' ? '' : f?.slice(1), clear: false, lines: [] });
        } else commands.push({ kind: 'proto', line: ln.no, node: ln.toks[1]!.slice(1), clear, lines: body });
      } else commands.push({ kind: 'timeline', line: ln.no, name: ln.toks[1]!, clear, lines: body });
      continue;
    }
    if (COMMANDS.has(kw) && ln.toks[1]?.startsWith('#')) {
      i++;
      const id = ln.toks[1].slice(1);
      const rest = ln.toks.slice(2);
      switch (kw) {
        case 'set': {
          const text = rest.find((t) => t.startsWith('"'));
          commands.push({ kind: 'set', line: ln.no, id, flags: rest.filter((t) => !t.startsWith('"')), text: text ? unquote(text) : undefined });
          break;
        }
        case 'delete':
          commands.push({ kind: 'delete', line: ln.no, id });
          break;
        case 'insert':
          commands.push({ kind: 'insert', line: ln.no, target: id, where: parseWhere(rest, ln.no, errors) ?? { pos: 'end' }, nodes: block(ln.indent) });
          break;
        case 'replace':
          commands.push({ kind: 'replace', line: ln.no, id, nodes: block(ln.indent) });
          break;
        case 'move': {
          const where = parseWhere(rest, ln.no, errors);
          if (!where) errors.push({ line: ln.no, severity: 'error', message: 'move needs "into #parent [start|end]", "before #x" or "after #x"' });
          else commands.push({ kind: 'move', line: ln.no, id, where });
          break;
        }
      }
      continue;
    }
    // plain node block at this indent level → create
    const nodes = block(ln.indent - 1);
    commands.push({ kind: 'create', nodes });
  }
  return { commands, errors };
}

function parseWhere(toks: string[], line: number, errors: Diagnostic[]): Where | undefined {
  const [a, b, c] = toks;
  if (!a) return undefined;
  if (a === 'start' || a === 'end') return { pos: a };
  if (a === 'before' || a === 'after') return { pos: a, ref: b?.startsWith('#') ? b.slice(1) : '' };
  if (a === 'index' && b && /^\d+$/.test(b)) return { pos: 'index', index: Number(b) };
  if (a === 'into' && b?.startsWith('#')) {
    // encoded as target change: handled by caller via ref with special marker
    return { pos: c === 'start' ? 'start' : 'end', ...({ into: b.slice(1) } as object) } as Where;
  }
  errors.push({ line, severity: 'error', message: `Unknown position "${toks.join(' ')}"` });
  return undefined;
}

function lineToPNode(ln: Line): PNode {
  const [head, ...rest] = ln.toks;
  const flags: string[] = [];
  let text: string | undefined;
  for (const t of rest) {
    if (t.startsWith('"')) text = unquote(t);
    else flags.push(t);
  }
  // a line that is only a quoted string → anonymous text
  if (head!.startsWith('"')) return { line: ln.no, head: 'Text', flags, text: unquote(head!), children: [] };
  return { line: ln.no, head: head!, flags, text, children: [] };
}

// ---------------------------------------------------------------- flag interpretation

export interface RdlContext {
  tokens: TokenResolver;
  components: RangoliDocument['data']['components'];
  icons?: RangoliDocument['data']['icons'];
  assets?: RangoliDocument['data']['assets'];
}

function lenFrom(group: 'space' | 'radius', v: string, ctx: RdlContext, line: number, diag: Diagnostic[]): Len | undefined {
  if (/^\d+(\.\d+)?px$/.test(v)) return parseFloat(v);
  const path = `${group}.${v}`;
  if (ctx.tokens.has(path)) return { token: path };
  diag.push({ line, severity: 'error', message: `Unknown ${group} step "${v}". Use a scale step (${ctx.tokens.group(group).map((t) => t.path.split('.').pop()).join(', ')}) or "<n>px".` });
  return undefined;
}

/** Solid colour: #hex(+alpha), token, token~alpha (0–100). */
function colorFrom(v: string, ctx: RdlContext, line: number, diag: Diagnostic[]): TokenRef | { hex: string } | undefined {
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return { hex: v.toLowerCase() };
  const m = /^(.+?)~(\d{1,3})$/.exec(v);
  const name = m ? m[1]! : v;
  if (/^#[0-9a-fA-F]{3,8}$/.test(name) && m) {
    const a = Math.round((Math.min(100, Number(m[2])) / 100) * 255).toString(16).padStart(2, '0');
    return { hex: `${name.slice(0, 7).toLowerCase()}${a}` };
  }
  const found = ctx.tokens.find(name, 'color');
  if (found) return m ? { token: found, alpha: Math.min(100, Number(m[2])) } : { token: found };
  diag.push({ line, severity: 'error', message: `Unknown color "${v}". Use a color token (surface, text.secondary, primary.600), token~40 for opacity, or #hex.` });
  return undefined;
}

/** Any paint: solid colour or linear(angle, c1[@pos], c2…) / radial(c1, c2…). */
function paintFrom(v: string, ctx: RdlContext, line: number, diag: Diagnostic[]): Paint | undefined {
  const g = /^(linear|radial)\((.+)\)$/.exec(v);
  if (!g) return colorFrom(v, ctx, line, diag);
  const args = g[2]!.split(',').map((s) => s.trim());
  let angle: number | undefined;
  if (g[1] === 'linear' && /^-?\d+(deg)?$/.test(args[0] ?? '')) angle = parseInt(args.shift()!, 10);
  if (args.length < 2) { diag.push({ line, severity: 'error', message: `${g[1]}() needs at least two colours` }); return undefined; }
  const stops: { at: number; color: TokenRef | { hex: string } }[] = [];
  args.forEach((a, i) => {
    const [c, at] = a.split('@');
    const color = colorFrom(c!, ctx, line, diag);
    if (color) stops.push({ at: at !== undefined ? Number(at) / 100 : i / (args.length - 1), color });
  });
  return { gradient: { type: g[1] as 'linear' | 'radial', angle: angle ?? 180, stops } };
}

/** Sanitise raw CSS declarations: no urls, imports, expressions, or block syntax. */
export function sanitizeCss(css: string): string | undefined {
  const decls = css.split(';').map((d) => d.trim()).filter(Boolean);
  for (const d of decls) {
    if (!/^-?[a-z][a-z-]*\s*:\s*[^;{}<>]+$/i.test(d) || /url\(|expression|@import|javascript:|behavior/i.test(d)) return undefined;
  }
  return decls.join(';');
}

const fixed = (v: number): Dim => ({ kind: 'fixed', v });

/** Apply flags onto a mutable node. Returns nothing; reports diagnostics. */
/** Property names accepted by unset: → how to remove them from a node. */
const UNSET: Record<string, (n: RNode) => void> = {
  fill: (n) => { if (n.style) delete n.style.fill; },
  stroke: (n) => { if (n.style) delete n.style.stroke; },
  radius: (n) => { if (n.style) delete n.style.radius; },
  shadow: (n) => { if (n.style) delete n.style.shadow; },
  opacity: (n) => { if (n.style) delete n.style.opacity; },
  blur: (n) => { if (n.style) delete n.style.blur; },
  bgblur: (n) => { if (n.style) delete n.style.backdropBlur; },
  blend: (n) => { if (n.style) delete n.style.blend; },
  rotate: (n) => { if (n.style) delete n.style.rotate; },
  z: (n) => { if (n.style) delete n.style.z; },
  overflow: (n) => { if (n.style) { delete n.style.overflow; delete n.style.clip; } },
  cursor: (n) => { if (n.style) delete n.style.cursor; },
  ratio: (n) => { if (n.style) delete n.style.aspect; },
  css: (n) => { if (n.style) delete n.style.css; },
  color: (n) => { if (n.style) delete n.style.color; },
  textstyle: (n) => { if (n.style) delete n.style.textStyle; },
  italic: (n) => { if (n.style) delete n.style.italic; },
  decoration: (n) => { if (n.style) delete n.style.decoration; },
  case: (n) => { if (n.style) delete n.style.textTransform; },
  align: (n) => { if (n.style) delete n.style.textAlign; },
  font: (n) => { if (n.style) delete n.style.font; },
  family: (n) => { if (n.style?.font) delete n.style.font.family; },
  size: (n) => { if (n.style?.font) delete n.style.font.size; },
  weight: (n) => { if (n.style?.font) delete n.style.font.weight; },
  lh: (n) => { if (n.style?.font) delete n.style.font.lineHeight; },
  ls: (n) => { if (n.style?.font) delete n.style.font.letterSpacing; },
  abs: (n) => { delete n.absolute; delete n.position; },
  paths: (n) => { if (n.vector) n.vector.paths = n.vector.paths.filter((p) => p.fromShapes); },
  w: (n) => { if (n.size) delete n.size.w; },
  h: (n) => { if (n.size) delete n.size.h; },
  minw: (n) => { if (n.size) delete n.size.minW; },
  maxw: (n) => { if (n.size) delete n.size.maxW; },
  minh: (n) => { if (n.size) delete n.size.minH; },
  maxh: (n) => { if (n.size) delete n.size.maxH; },
  gap: (n) => { if (n.layout) delete n.layout.gap; },
  padding: (n) => { if (n.layout) delete n.layout.padding; },
  wrap: (n) => { if (n.layout) delete n.layout.wrap; },
  justify: (n) => { if (n.layout) delete n.layout.justify; },
  items: (n) => { if (n.layout) delete n.layout.align; },
};
function unsetProp(n: RNode, key: string): boolean {
  const fn = UNSET[key];
  if (!fn) return false;
  fn(n);
  if (n.style && !Object.keys(n.style).length) delete n.style;
  if (n.style?.font && !Object.keys(n.style.font).length) delete n.style.font;
  if (n.size && !Object.keys(n.size).length) delete n.size;
  return true;
}

export function applyFlags(node: RNode, flags: string[], text: string | undefined, ctx: RdlContext, line: number, diag: Diagnostic[], hasChildren = false): void {
  const layout = (): Layout => (node.layout ??= { mode: 'col' });
  const size = (): Sizing => (node.size ??= {});
  const style = (): Style => (node.style ??= {});
  const comp = node.component ? ctx.components[node.component] : undefined;
  const setPad = (sides: number[], v: Len) => {
    const l = layout();
    const p = (l.padding ??= [0, 0, 0, 0]);
    for (const s of sides) p[s] = v;
  };

  for (const f of flags) {
    let m: RegExpExecArray | null;
    if (f === 'row' || f === 'col' || f === 'grid' || f === 'none') { layout().mode = f; continue; }
    if (f === 'wrap') { layout().wrap = true; continue; }
    if ((m = /^gap(\d+(?:\.\d+)?(?:px)?)$/.exec(f))) { const v = lenFrom('space', m[1]!, ctx, line, diag); if (v !== undefined) layout().gap = v; continue; }
    if ((m = /^p([xytrbl]?)(\d+(?:\.\d+)?(?:px)?)$/.exec(f))) {
      const v = lenFrom('space', m[2]!, ctx, line, diag);
      if (v === undefined) continue;
      const sides = { '': [0, 1, 2, 3], x: [1, 3], y: [0, 2], t: [0], r: [1], b: [2], l: [3] }[m[1] as '' | 'x'];
      setPad(sides, v);
      continue;
    }
    if ((m = /^([wh])(\d+(?:\.\d+)?)$/.exec(f))) { size()[m[1] as 'w' | 'h'] = fixed(parseFloat(m[2]!)); continue; }
    if ((m = /^([wh])(fill|hug)$/.exec(f))) { size()[m[1] as 'w' | 'h'] = { kind: m[2] as 'fill' | 'hug' }; continue; }
    if ((m = /^(min|max)([wh])(\d+(?:\.\d+)?)$/.exec(f))) {
      const key = `${m[1]}${m[2]!.toUpperCase()}` as 'minW' | 'maxW' | 'minH' | 'maxH';
      size()[key] = parseFloat(m[3]!);
      continue;
    }
    if (f === 'between' || f === 'around') { layout().justify = f; continue; }
    if ((m = /^j(start|center|end)$/.exec(f))) { layout().justify = m[1] as 'start'; continue; }
    if (f === 'start' || f === 'center' || f === 'end' || f === 'stretch' || f === 'baseline') { layout().align = f; continue; }
    if (f === 'middle') { layout().align = 'center'; layout().justify = 'center'; continue; }
    if ((m = /^cols(\d+)$/.exec(f))) { layout().mode = 'grid'; layout().columns = Number(m[1]); continue; }
    if ((m = /^r(\d+(?:\.\d+)?(?:px)?|full|card|control)$/.exec(f))) { const v = lenFrom('radius', m[1]!, ctx, line, diag); if (v !== undefined) style().radius = v; continue; }
    if ((m = /^(fill|bg):(.+)$/.exec(f))) {
      if (m[2] === 'none') { style().fill = []; continue; }
      const p = paintFrom(m[2]!, ctx, line, diag);
      if (p) style().fill = [p];
      continue;
    }
    // stroke:<color>[/<width>][/solid|dashed|dotted][/<sides tblr>]
    if ((m = /^stroke:([^/]+)(?:\/(\d+(?:\.\d+)?))?(?:\/(solid|dashed|dotted))?(?:\/([tblr]{1,4}))?$/.exec(f))) {
      if (m[1] === 'none') { delete style().stroke; continue; }
      const p = paintFrom(m[1]!, ctx, line, diag);
      if (p) style().stroke = { paint: p, width: m[2] ? parseFloat(m[2]) : 1, align: 'inside', ...(m[3] && m[3] !== 'solid' ? { style: m[3] as 'dashed' } : {}), ...(m[4] ? { sides: m[4] } : {}) };
      continue;
    }
    if ((m = /^color:(.+)$/.exec(f))) { const p = colorFrom(m[1]!, ctx, line, diag); if (p) style().color = p; continue; }
    // shadow:<token> | shadow:x,y,blur,spread,color[,inset] | shadow+:… appends | shadow:none
    if ((m = /^shadow(\+?):(.+)$/.exec(f))) {
      if (m[2] === 'none') { delete style().shadow; continue; }
      const parts = m[2]!.split(',');
      if (parts.length >= 4) {
        const [x, y, blur, spread, color = 'neutral.900~16', inset] = parts;
        const c = colorFrom(color, ctx, line, diag);
        if (!c || [x, y, blur, spread].some((n) => !/^-?\d+(\.\d+)?$/.test(n!))) { diag.push({ line, severity: 'error', message: 'shadow:x,y,blur,spread,color[,inset] — numbers in px, e.g. shadow:0,8,24,-4,neutral.900~20' }); continue; }
        const sh = { x: +x!, y: +y!, blur: +blur!, spread: +spread!, color: c, ...(inset === 'inset' ? { inset: true } : {}) };
        const prev = style().shadow;
        style().shadow = m[1] && Array.isArray(prev) ? [...prev, sh] : [sh];
        continue;
      }
      const path = ctx.tokens.find(m[2]!, 'shadow');
      if (path) style().shadow = { token: path };
      else diag.push({ line, severity: 'error', message: `Unknown shadow "${m[2]}" (try ${ctx.tokens.group('shadow').map((t) => t.path.split('.').pop()).join(', ')} or x,y,blur,spread,color)` });
      continue;
    }
    if ((m = /^opacity:(\d*\.?\d+)$/.exec(f))) { style().opacity = parseFloat(m[1]!); continue; }
    // per-corner radius r:tl,tr,br,bl (px or radius steps)
    if ((m = /^r:([\w.]+),([\w.]+),([\w.]+),([\w.]+)$/.exec(f))) {
      const vals = [m[1], m[2], m[3], m[4]].map((x) => (/^\d+(\.\d+)?$/.test(x!) ? Number(x) : lenFrom('radius', x!, ctx, line, diag)));
      if (vals.every((x) => x !== undefined)) style().radius = vals as [Len, Len, Len, Len];
      continue;
    }
    // typography
    if ((m = /^font:(.+)$/.exec(f))) {
      const v = m[1]!.startsWith('"') ? unquote(m[1]!) : m[1]!;
      const tok = ctx.tokens.find(v, 'font.family');
      style().font = { ...(style().font ?? {}), family: tok ? `var(--${tok.replace(/\./g, '-')})` : /^[\w\s,'-]+$/.test(v) ? v : 'inherit' };
      continue;
    }
    if ((m = /^lh:(\d+(?:\.\d+)?)$/.exec(f))) { style().font = { ...(style().font ?? {}), lineHeight: Number(m[1]) }; continue; }
    if ((m = /^ls:(-?\d*\.?\d+)(em|px)?$/.exec(f))) { style().font = { ...(style().font ?? {}), letterSpacing: `${m[1]}${m[2] ?? 'px'}` }; continue; }
    if (f === 'italic') { style().italic = true; continue; }
    // unset:rotate,italic,css — remove properties (back to inherited / component default)
    if ((m = /^unset:([\w,-]+)$/.exec(f))) {
      for (const key of m[1]!.split(',')) if (!unsetProp(node, key)) diag.push({ line, severity: 'error', message: `unset: unknown property "${key}" — e.g. ${Object.keys(UNSET).join(', ')}` });
      continue;
    }
    if (f === 'underline' || f === 'strike' || f === 'nodecoration') { style().decoration = f === 'underline' ? 'underline' : f === 'strike' ? 'line-through' : 'none'; continue; }
    if (f === 'upper' || f === 'lower' || f === 'capitalize') { style().textTransform = f === 'upper' ? 'uppercase' : f === 'lower' ? 'lowercase' : 'capitalize'; continue; }
    // effects & placement
    if ((m = /^blur:(\d+(?:\.\d+)?)$/.exec(f))) { style().blur = Number(m[1]); continue; }
    if ((m = /^bgblur:(\d+(?:\.\d+)?)$/.exec(f))) { style().backdropBlur = Number(m[1]); continue; }
    if ((m = /^blend:(multiply|screen|overlay|darken|lighten|color-dodge|color-burn|soft-light|hard-light|difference|exclusion|luminosity|color|hue|saturation)$/.exec(f))) { style().blend = m[1]; continue; }
    if ((m = /^rotate:(-?\d+(?:\.\d+)?)$/.exec(f))) { style().rotate = Number(m[1]); continue; }
    if ((m = /^z:(-?\d+)$/.exec(f))) { style().z = Number(m[1]); continue; }
    if ((m = /^overflow:(hidden|auto|scroll|visible)$/.exec(f))) { style().overflow = m[1] as 'hidden'; continue; }
    if ((m = /^cursor:(pointer|default|text|move|grab|not-allowed|help)$/.exec(f))) { style().cursor = m[1]; continue; }
    if ((m = /^ratio:(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(f))) { style().aspect = `${m[1]}/${m[2]}`; continue; }
    if (f === 'abs') { node.absolute = true; node.position ??= { x: 0, y: 0 }; continue; }
    if ((m = /^css:(.+)$/.exec(f))) {
      const raw = m[1]!.startsWith('"') ? unquote(m[1]!) : m[1]!;
      const clean = sanitizeCss(raw);
      if (clean === undefined) diag.push({ line, severity: 'error', message: 'css: only plain declarations are allowed (no url(), @import, expressions or braces)' });
      else style().css = clean;
      continue;
    }
    // drawing: d:"<svg path>" (pen tool output) or shapes:"<shape language, | separated>"
    if ((m = /^(d|shapes):(.+)$/.exec(f))) {
      const raw = m[2]!.startsWith('"') ? unquote(m[2]!) : m[2]!;
      node.type = 'vector';
      // coordinate box: explicit vb:, else the node's fixed size, else 24
      const fixedPx = (dm?: Dim) => (dm?.kind === 'fixed' && typeof dm.v === 'number' ? dm.v : undefined);
      const vw = node.vector?.vw ?? fixedPx(node.size?.w) ?? 24, vh = node.vector?.vh ?? fixedPx(node.size?.h) ?? 24;
      if (m[1] === 'd') {
        if (!/^[MLHVCSQTAZmlhvcsqtaz0-9.,\s-]+$/.test(raw) || !/^\s*[Mm]/.test(raw)) { diag.push({ line, severity: 'error', message: 'd: must be SVG path data starting with M (commands M L H V C S Q T A Z)' }); continue; }
        node.vector = { ...(node.vector ?? {}), vw, vh, paths: [...(node.vector?.paths ?? []), { d: raw.trim() }] };
      } else {
        const sd: Diagnostic[] = [];
        const c = compileIcon(raw.split('|').join('\n'), sd);
        for (const d of sd) diag.push({ ...d, line });
        node.vector = { vw, vh, shapes: node.vector?.shapes ? `${node.vector.shapes}|${raw}` : raw, paths: [...(node.vector?.paths ?? []), ...c.shapes.map((s) => ({ d: s.d, fromShapes: true, ...(s.fill ? { filled: true } : {}), ...(s.color ? { color: s.color } : {}) }))] };
      }
      continue;
    }
    if ((m = /^vb:(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(f))) { node.type = 'vector'; node.vector = { ...(node.vector ?? { paths: [] }), vw: Number(m[1]), vh: Number(m[2]) }; continue; }
    if ((m = /^role:(.+)$/.exec(f))) { node.role = m[1]; continue; }
    if ((m = /^name:(.+)$/.exec(f))) { node.name = m[1]!.startsWith('"') ? unquote(m[1]!) : m[1]!; continue; }
    if ((m = /^icon:([\w-]+(?:\/[\w~.-]+)?)$/.exec(f))) {
      const found = findIcon(ctx.icons, m[1]!);
      if (!found) {
        const all = Object.values(ctx.icons ?? {}).flatMap((s) => Object.keys(s.icons).map((n) => `${s.name}/${n}`));
        diag.push({ line, severity: 'error', message: `Unknown icon "${m[1]}". Available: ${all.slice(0, 30).join(' ')}${all.length > 30 ? ' …' : ''}` });
      } else {
        node.icon = `${found.set.name}/${found.icon.name}`;
        node.type = 'vector';
      }
      continue;
    }
    // images: asset:<id|name> fit:cover|contain|fill alt:"…" decorative
    if ((m = /^asset:(.+)$/.exec(f))) {
      const a = findAsset(ctx.assets, m[1]!);
      if (!a) diag.push({ line, severity: 'error', message: `Unknown asset "${m[1]}". ${Object.keys(ctx.assets ?? {}).length ? `Known: ${Object.values(ctx.assets ?? {}).slice(0, 20).map((x) => `${x.id} (${x.name})`).join(', ')}` : 'Upload one first (asset_upload).'}` });
      else {
        node.type = 'image';
        node.image = { ...(node.image ?? {}), asset: a.id };
      }
      continue;
    }
    if ((m = /^fit:(cover|contain|fill)$/.exec(f))) { node.type = 'image'; node.image = { asset: '', ...(node.image ?? {}), fit: m[1] as 'cover' }; continue; }
    if ((m = /^alt:(.*)$/.exec(f))) { node.type = 'image'; node.image = { asset: '', ...(node.image ?? {}), alt: m[1]!.startsWith('"') ? unquote(m[1]!) : m[1]!, decorative: false }; continue; }
    if (f === 'decorative') { node.type = 'image'; node.image = { asset: '', ...(node.image ?? {}), decorative: true }; delete node.image.alt; continue; }
    if ((m = /^at:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(f))) { node.position = { x: parseFloat(m[1]!), y: parseFloat(m[2]!) }; continue; }
    if ((m = /^align:(left|center|right|justify)$/.exec(f))) { style().textAlign = m[1] as 'left'; continue; }
    if (f === 'muted') { style().color = { token: ctx.tokens.find('text.muted', 'color') ?? 'color.text.muted' }; continue; }
    if (f === 'mono') { style().mono = true; continue; }
    // type overrides — for composed images/marketing where the app type scale is too small
    if ((m = /^size:(\d{1,3})$/.exec(f))) { style().font = { ...(style().font ?? {}), size: Number(m[1]), lineHeight: 1.15 }; continue; }
    if ((m = /^weight:([1-9]00)$/.exec(f))) { style().font = { ...(style().font ?? {}), weight: Number(m[1]) }; continue; }
    if (f === 'truncate') { style().truncate = true; continue; }
    if (f === 'clip') { style().clip = true; continue; }
    if (f === 'hidden') { node.hidden = true; continue; }
    if (f === 'locked') { node.locked = true; continue; }
    if (f === 'text' || f === 'frame' || f === 'vector' || f === 'image' || f === 'group') { node.type = f; continue; }
    if (ctx.tokens.has(`textStyle.${f}`)) { style().textStyle = { token: `textStyle.${f}` }; continue; }
    if ((m = /^([A-Za-z_][\w-]*)=(.+)$/.exec(f))) {
      const key = m[1]!;
      let raw = m[2]!;
      if (raw.startsWith('"')) raw = unquote(raw);
      const val: string | number | boolean = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
      if (comp && key in comp.axes) {
        if (!comp.axes[key]!.includes(String(val))) diag.push({ line, severity: 'error', message: `${comp.name}.${key} must be one of: ${comp.axes[key]!.join(', ')}` });
        else (node.variant ??= {})[key] = String(val);
      } else if (comp?.template && !comp.slots?.[key]) {
        diag.push({ line, severity: 'error', message: `@${comp.name} has no slot "${key}" — slots: ${Object.keys(comp.slots ?? {}).join(', ') || 'none'}${Object.keys(comp.axes).length ? `; axes: ${Object.keys(comp.axes).join(', ')}` : ''}` });
      } else (node.props ??= {})[key] = val;
      continue;
    }
    diag.push({ line, severity: 'error', message: `Unknown flag "${f}"` });
  }

  if (text !== undefined) {
    if (node.type === 'instance') {
      const prop = comp?.labelProp ?? 'label';
      (node.props ??= {})[prop] = text;
    } else if ((node.type === 'frame' || node.type === 'group') && (node.children?.length || hasChildren)) {
      diag.push({ line, severity: 'error', message: `"${node.name}" is a container with children — quoted text only applies to text nodes and components. Target the text node inside it.` });
    } else if (node.type === 'vector' || node.type === 'image') {
      diag.push({ line, severity: 'error', message: `${node.type} "${node.name}" cannot hold text` });
    } else {
      node.text = text;
      if (node.type === 'frame') node.type = 'text';
    }
  }
  if (node.type === 'text') { delete node.layout; }
}

function headToNode(p: PNode, ctx: RdlContext, diag: Diagnostic[]): RNode {
  let head = p.head;
  let id = '';
  const hash = head.indexOf('#');
  if (hash > 0) { id = head.slice(hash + 1); head = head.slice(0, hash); }
  const node: RNode = { id, type: 'frame', name: head };
  if (head.startsWith('@')) {
    node.name = head.slice(1);
    node.component = head.slice(1);
    node.type = 'instance';
  } else {
    const compFlag = p.flags.find((f) => f.startsWith('@'));
    if (compFlag) { node.component = compFlag.slice(1); node.type = 'instance'; }
  }
  if (node.component && !ctx.components[node.component]) {
    diag.push({ line: p.line, severity: 'error', message: `Unknown component "@${node.component}". Known: ${Object.keys(ctx.components).join(', ') || '(none)'}` });
  }
  if (!node.component && /^(Text|Label|Title|Heading|Caption)\b/.test(head) && !p.children.length) node.type = 'text';
  if (!node.component && /^(Icon|Vector)\b/.test(head)) node.type = 'vector';
  if (!node.component && /^(Image|Img|Avatar)\b/.test(head)) node.type = 'image';
  applyFlags(node, p.flags.filter((f) => !f.startsWith('@')), p.text, ctx, p.line, diag, p.children.length > 0);
  if (node.type === 'frame' && !node.layout) node.layout = { mode: 'col' };
  return node;
}

// ---------------------------------------------------------------- compile to ops

export interface CompileOptions {
  page?: string;
  /** parent for top-level created nodes */
  parent?: string;
}

export interface CompileResult {
  ops: Op[];
  errors: Diagnostic[];
  created: string[];
}

/** Compile a whole script against the CURRENT state (dry run / preview). */
export function compileRdl(doc: RangoliDocument, src: string, opts: CompileOptions = {}): CompileResult {
  const { commands, errors } = parseRdl(src);
  const res = compileCommands(doc, commands, opts);
  return { ...res, errors: [...errors, ...res.errors] };
}

function compileCommands(doc: RangoliDocument, commands: Command[], opts: CompileOptions): CompileResult {
  const errors: Diagnostic[] = [];
  const ctx: RdlContext = { tokens: new TokenResolver(doc.data.tokens), components: doc.data.components, icons: doc.data.icons, assets: doc.data.assets };
  const ops: Op[] = [];
  const created: string[] = [];
  const page = doc.page(opts.page);
  const pendingIds = new Set<string>();
  const exists = (id: string) => !!page.nodes[id] || pendingIds.has(id);

  const emitTree = (nodes: PNode[], parent: string | undefined, startIndex: number | undefined) => {
    let idx = startIndex;
    for (const p of nodes) {
      const node = headToNode(p, ctx, errors);
      if (node.id) {
        if (exists(node.id)) { errors.push({ line: p.line, severity: 'error', message: `#${node.id} already exists — use "set #${node.id} …" to change it` }); continue; }
        doc.ids.observe(node.id);
      } else node.id = doc.ids.make();
      pendingIds.add(node.id);
      created.push(node.id);
      ops.push({ op: 'create', page: page.id, node, parent, index: idx });
      if (idx !== undefined) idx++;
      if (p.children.length) {
        if (node.type === 'text' || node.type === 'vector' || node.type === 'image') {
          errors.push({ line: p.children[0]!.line, severity: 'error', message: `${node.type} node "${node.name}" cannot have children` });
        } else emitTree(p.children, node.id, undefined);
      }
    }
  };

  const resolveWhere = (where: Where, defaultParent: string | undefined, line: number): { parent: string | undefined; index: number | undefined } | undefined => {
    const into = (where as { into?: string }).into;
    if (into !== undefined) {
      if (!exists(into)) { errors.push({ line, severity: 'error', message: `#${into} not found` }); return undefined; }
      return { parent: into, index: where.pos === 'start' ? 0 : undefined };
    }
    if (where.pos === 'start') return { parent: defaultParent, index: 0 };
    if (where.pos === 'end') return { parent: defaultParent, index: undefined };
    if (where.pos === 'index') return { parent: defaultParent, index: where.index };
    const refId = (where as Extract<Where, { ref: string }>).ref;
    const ref = page.nodes[refId];
    if (!ref) { errors.push({ line, severity: 'error', message: `#${refId} not found` }); return undefined; }
    const siblings = ref.parent ? page.nodes[ref.parent]!.children ?? [] : page.children;
    const i = siblings.indexOf(ref.id);
    return { parent: ref.parent, index: where.pos === 'before' ? i : i + 1 };
  };

  for (const cmd of commands) {
    switch (cmd.kind) {
      case 'create':
        emitTree(cmd.nodes, opts.parent, undefined);
        break;
      case 'set': {
        const node = page.nodes[cmd.id];
        if (!node) { errors.push({ line: cmd.line, severity: 'error', message: `#${cmd.id} not found` }); break; }
        const copy = structuredClone(node);
        applyFlags(copy, cmd.flags, cmd.text, ctx, cmd.line, errors);
        const patch: Record<string, unknown> = {};
        for (const k of ['type', 'name', 'role', 'layout', 'size', 'position', 'style', 'text', 'variant', 'props', 'hidden', 'locked', 'icon', 'image', 'absolute', 'vector'] as const) {
          if (JSON.stringify(copy[k]) !== JSON.stringify(node[k])) patch[k] = copy[k] ?? null;
        }
        if (Object.keys(patch).length) ops.push({ op: 'update', page: page.id, id: cmd.id, patch: patch as Partial<RNode> });
        break;
      }
      case 'delete':
        if (!page.nodes[cmd.id]) errors.push({ line: cmd.line, severity: 'error', message: `#${cmd.id} not found` });
        else {
          // drop motion attached to the deleted subtree (keeps the document free of orphans)
          const drop = (id: string) => {
            for (const key of Object.keys(doc.data.motion ?? {})) if (key === `#${id}` || key.startsWith(`#${id}[`)) ops.push({ op: 'setMotion', target: key, def: null });
            if (doc.data.prototype?.interactions[id]) ops.push({ op: 'setInteractions', node: id, list: null });
            if (doc.data.prototype?.start === id) ops.push({ op: 'setProtoStart', frame: null });
            for (const c of page.nodes[id]?.children ?? []) drop(c);
          };
          drop(cmd.id);
          ops.push({ op: 'delete', page: page.id, id: cmd.id });
        }
        break;
      case 'insert': {
        const target = page.nodes[cmd.target];
        if (!target) { errors.push({ line: cmd.line, severity: 'error', message: `#${cmd.target} not found` }); break; }
        // "insert #x before|after [#ref]" → sibling of ref (default: #x); "insert #x start|end|index N" → child of #x
        const w =
          cmd.where.pos === 'before' || cmd.where.pos === 'after'
            ? resolveWhere({ pos: cmd.where.pos, ref: cmd.where.ref || cmd.target }, undefined, cmd.line)
            : resolveWhere(cmd.where, cmd.target, cmd.line);
        if (w) emitTree(cmd.nodes, w.parent, w.index);
        break;
      }
      case 'replace': {
        const target = page.nodes[cmd.id];
        if (!target) { errors.push({ line: cmd.line, severity: 'error', message: `#${cmd.id} not found` }); break; }
        const siblings = target.parent ? page.nodes[target.parent]!.children ?? [] : page.children;
        const index = siblings.indexOf(cmd.id);
        ops.push({ op: 'delete', page: page.id, id: cmd.id });
        // allow the replacement to reuse the same id
        const reuse = cmd.nodes.length === 1 && !cmd.nodes[0]!.head.includes('#');
        if (reuse) cmd.nodes[0]!.head += `#${cmd.id}`;
        // temporarily hide the whole old subtree so the replacement may reuse its ids
        const hidden: [string, RNode][] = [];
        const hide = (id: string) => {
          const n = page.nodes[id];
          if (!n) return;
          hidden.push([id, n]);
          delete page.nodes[id];
          for (const c of n.children ?? []) hide(c);
        };
        hide(cmd.id);
        try { emitTree(cmd.nodes, target.parent, index); } finally { for (const [id, n] of hidden) page.nodes[id] = n; }
        break;
      }
      case 'motion': {
        const key = targetKey(cmd.base, cmd.filters);
        if (cmd.base.startsWith('@')) {
          const comp = doc.data.components[cmd.base.slice(1)];
          if (!comp) { errors.push({ line: cmd.line, severity: 'error', message: `Unknown component "${cmd.base}"` }); break; }
          for (const [k, v] of Object.entries(cmd.filters)) {
            if (!comp.axes[k]?.includes(v)) errors.push({ line: cmd.line, severity: 'error', message: `${comp.name} has no ${k}=${v} (axes: ${Object.entries(comp.axes).map(([a, vs]) => `${a}: ${vs.join('|')}`).join('; ')})` });
          }
        } else if (!exists(cmd.base.slice(1))) {
          errors.push({ line: cmd.line, severity: 'error', message: `${cmd.base} not found` });
          break;
        }
        if (cmd.clear) { ops.push({ op: 'setMotion', target: key, def: null }); break; }
        if (!cmd.lines.length) { errors.push({ line: cmd.line, severity: 'error', message: 'motion block is empty — add indented lines like "  hover fill:action.primaryHover fast out", or use "none" to remove' }); break; }
        const specs = parseMotionLines(cmd.lines, errors);
        // merge: triggers given here replace the same triggers on the target; others are kept
        const prev = doc.data.motion?.[key];
        const given = new Set(specs.map((s) => s.trigger));
        const merged = [...(prev?.specs.filter((s) => !given.has(s.trigger)) ?? []), ...specs];
        ops.push({ op: 'setMotion', target: key, def: { target: key, specs: merged } });
        break;
      }
      case 'token': {
        // token color.primary.600 #1d4ed8 dark=#60a5fa  ·  token space.4 18  ·  token radius.control {radius.full}
        const tokens = structuredClone(doc.data.tokens) as Record<string, unknown>;
        const parts = cmd.path.split('.');
        const key = parts[parts.length - 1]!;
        const parse = (v: string): unknown => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
        let cur = tokens;
        let subField = false;
        let bad = false;
        for (const [i, p] of parts.slice(0, -1).entries()) {
          const next = cur[p] as Record<string, unknown> | undefined;
          if (next && typeof next === 'object' && '$value' in next) {
            // one field of a composite token: token textStyle.body.fontSize 15
            const val = next.$value;
            if (i === parts.length - 2 && val && typeof val === 'object' && !Array.isArray(val)) { (val as Record<string, unknown>)[key] = parse(cmd.value); subField = true; }
            else { errors.push({ line: cmd.line, severity: 'error', message: `${cmd.path}: "${p}" is a token, not a group` }); bad = true; }
            break;
          }
          cur = (cur[p] ??= {}) as Record<string, unknown>;
        }
        if (bad) break;
        if (subField) { ops.push({ op: 'setTokens', tokens: tokens as never }); break; }
        const leaf = (cur[key] ??= { $value: parse(cmd.value) }) as Record<string, unknown>;
        leaf.$value = parse(cmd.value);
        for (const [mode, v] of Object.entries(cmd.modes)) {
          const ext = (leaf.$extensions ??= {}) as Record<string, Record<string, Record<string, unknown>>>;
          ((ext.rangoli ??= {}).modes ??= {})[mode] = parse(v);
        }
        const check = new TokenResolver(tokens as never);
        if (check.resolve(cmd.path) === undefined) errors.push({ line: cmd.line, severity: 'error', message: `${cmd.path} = ${cmd.value} does not resolve (missing alias?)` });
        else ops.push({ op: 'setTokens', tokens: tokens as never });
        break;
      }
      case 'language': {
        // language editorial [brand=#9a3b26] — switches type, density, shape, elevation and motion; keeps the brand
        if (!LANGUAGES[cmd.id]) { errors.push({ line: cmd.line, severity: 'error', message: `unknown design language "${cmd.id}" — ${Object.keys(LANGUAGES).join(', ')}` }); break; }
        const curLang = languageOf(doc.data.tokens);
        const brand = cmd.opts.brand ?? curLang.options.brand;
        if (brand && !/^#[0-9a-fA-F]{6}$/.test(brand)) { errors.push({ line: cmd.line, severity: 'error', message: 'brand must be #rrggbb' }); break; }
        ops.push({ op: 'setTokens', tokens: languageTokens(cmd.id, brand ? { brand } : {}) });
        break;
      }
      case 'component': {
        compileComponent(doc, cmd, ctx, page, ops, errors);
        break;
      }
      case 'iconset': {
        const prev = doc.data.icons?.[cmd.name];
        if (cmd.opts.includes('none')) { ops.push({ op: 'setIconSet', name: cmd.name, def: null }); break; }
        const def: IconSet = prev ? structuredClone(prev) : { name: cmd.name, grid: 24, stroke: 1.5, cap: 'round', join: 'round', icons: {} };
        for (const o of cmd.opts) {
          let m: RegExpExecArray | null;
          if ((m = /^grid(\d+)$/.exec(o))) def.grid = Number(m[1]);
          else if ((m = /^stroke(\d*\.?\d+)$/.exec(o))) def.stroke = Number(m[1]);
          else if (o === 'round' || o === 'butt' || o === 'square') { def.cap = o; def.join = o === 'round' ? 'round' : 'miter'; }
          else errors.push({ line: cmd.line, severity: 'error', message: `iconset option "${o}" — use gridN strokeN round|butt|square, or none` });
        }
        ops.push({ op: 'setIconSet', name: cmd.name, def });
        break;
      }
      case 'icon': {
        let set = doc.data.icons?.[cmd.set];
        if (!set) {
          // creating an icon in a new set (e.g. "drafts") inherits the conventions of the first set
          const base = Object.values(doc.data.icons ?? {})[0];
          set = { name: cmd.set, grid: base?.grid ?? 24, stroke: base?.stroke ?? 1.5, cap: base?.cap ?? 'round', join: base?.join ?? 'round', icons: {} };
          ops.push({ op: 'setIconSet', name: cmd.set, def: set }); // applied before the setIcon below (same batch)
        }
        if (cmd.opts.includes('none')) {
          if (!set.icons[cmd.name]) errors.push({ line: cmd.line, severity: 'error', message: `icon ${cmd.set}/${cmd.name} not found` });
          else ops.push({ op: 'setIcon', set: cmd.set, name: cmd.name, icon: null });
          break;
        }
        if (!cmd.lines.length) { errors.push({ line: cmd.line, severity: 'error', message: 'icon block is empty — add shapes like "  circle 12 12 8.5" (or use "none")' }); break; }
        const src = cmd.lines.map((l) => l.toks.join(' ')).join('\n');
        const diag: Diagnostic[] = [];
        compileIcon(src, diag);
        for (const d of diag) errors.push({ ...d, line: cmd.lines[d.line - 1]?.no ?? cmd.line });
        const def: IconDef = { name: cmd.name, src };
        for (const o of cmd.opts) {
          let m: RegExpExecArray | null;
          if ((m = /^stroke(\d*\.?\d+)$/.exec(o))) def.stroke = Number(m[1]);
          else if ((m = /^tags=(.+)$/.exec(o))) def.tags = m[1]!.split(',');
          else errors.push({ line: cmd.line, severity: 'error', message: `icon option "${o}" — use strokeN, tags=a,b or none` });
        }
        ops.push({ op: 'setIcon', set: cmd.set, name: cmd.name, icon: def });
        break;
      }
      case 'proto': {
        if (cmd.node === null) {
          if (cmd.start === undefined) break;
          if (cmd.start && (!page.nodes[cmd.start] || page.nodes[cmd.start]!.parent)) { errors.push({ line: cmd.line, severity: 'error', message: `#${cmd.start} must be a top-level frame (a screen)` }); break; }
          ops.push({ op: 'setProtoStart', frame: cmd.start || null });
          break;
        }
        const node = page.nodes[cmd.node];
        if (!node) { errors.push({ line: cmd.line, severity: 'error', message: `#${cmd.node} not found` }); break; }
        if (cmd.clear) { ops.push({ op: 'setInteractions', node: cmd.node, list: null }); break; }
        if (!cmd.lines.length) { errors.push({ line: cmd.line, severity: 'error', message: 'proto block is empty — add lines like "  click navigate #frame dissolve", or use "none"' }); break; }
        const list = parseProtoLines(cmd.lines, errors);
        for (const it of list) {
          if (it.action === 'navigate' || it.action === 'overlay') {
            const t = it.target ? page.nodes[it.target] : undefined;
            if (!t) errors.push({ line: cmd.line, severity: 'error', message: `${it.action} target #${it.target} not found` });
            else if (t.parent) errors.push({ line: cmd.line, severity: 'error', message: `${it.action} target #${it.target} must be a top-level frame (a screen); "${t.name}" is nested` });
          }
          if (it.action === 'swap') {
            const t = page.nodes[it.target ?? cmd.node];
            const comp = t?.component ? doc.data.components[t.component] : undefined;
            if (!t || !comp) errors.push({ line: cmd.line, severity: 'error', message: `swap target #${it.target ?? cmd.node} must be a component instance` });
            else for (const [k, v] of Object.entries(it.variant ?? {})) if (!comp.axes[k]?.includes(v)) errors.push({ line: cmd.line, severity: 'error', message: `${comp.name} has no ${k}=${v}` });
          }
          if (it.action === 'play' && it.timeline && !doc.data.timelines?.[it.timeline]) errors.push({ line: cmd.line, severity: 'error', message: `timeline "${it.timeline}" not defined (define it with a timeline block first)` });
        }
        ops.push({ op: 'setInteractions', node: cmd.node, list });
        break;
      }
      case 'timeline': {
        if (cmd.clear) { ops.push({ op: 'setTimeline', name: cmd.name, def: null }); break; }
        if (!cmd.lines.length) { errors.push({ line: cmd.line, severity: 'error', message: 'timeline is empty — add tracks like "  #n7 0 opacity:0, y:sm base out"' }); break; }
        const tracks = parseTimelineLines(cmd.lines, errors);
        for (const t of tracks) if (!exists(t.target)) errors.push({ line: cmd.line, severity: 'error', message: `timeline track target #${t.target} not found` });
        ops.push({ op: 'setTimeline', name: cmd.name, def: { name: cmd.name, tracks } });
        break;
      }
      case 'move': {
        if (!page.nodes[cmd.id]) { errors.push({ line: cmd.line, severity: 'error', message: `#${cmd.id} not found` }); break; }
        if ((cmd.where.pos === 'before' || cmd.where.pos === 'after') && !cmd.where.ref) {
          errors.push({ line: cmd.line, severity: 'error', message: `move needs a reference: "move #${cmd.id} ${cmd.where.pos} #other"` });
          break;
        }
        const w = resolveWhere(cmd.where, undefined, cmd.line);
        if (!w) break;
        // adjust index when moving within same parent past itself
        const node = page.nodes[cmd.id]!;
        let index = w.index;
        if (index !== undefined && node.parent === w.parent) {
          const sib = w.parent ? page.nodes[w.parent]!.children ?? [] : page.children;
          if (sib.indexOf(cmd.id) < index) index--;
        }
        ops.push({ op: 'move', page: page.id, id: cmd.id, parent: w.parent, index });
        break;
      }
    }
  }
  return { ops, errors, created };
}

/** Compile and apply. Throws RangoliError('RDL', …) with all diagnostics if any errors. */
export function applyRdl(doc: RangoliDocument, src: string, opts: CompileOptions & { author?: string; label?: string } = {}) {
  const { commands, errors: parseErrors } = parseRdl(src);
  const fail = (errs: Diagnostic[]) => {
    throw new RangoliError('RDL', errs.map((e) => `line ${e.line}: ${e.message}`).join('\n'));
  };
  if (parseErrors.some((e) => e.severity === 'error')) fail(parseErrors.filter((e) => e.severity === 'error'));
  const created: string[] = [];
  const touched = new Set<string>();
  const warnings: Diagnostic[] = [...parseErrors];
  // Each command sees the effects of the previous ones; the whole script is ONE atomic, undoable change.
  doc.transact(
    () => {
      for (const cmd of commands) {
        const res = compileCommands(doc, [cmd], opts);
        const errs = res.errors.filter((e) => e.severity === 'error');
        if (errs.length) fail(errs);
        warnings.push(...res.errors);
        const applied = doc.apply(res.ops, { author: opts.author });
        created.push(...res.created);
        for (const t of applied.touched) touched.add(t);
      }
    },
    { author: opts.author, label: opts.label },
  );
  return { created, touched: [...touched], warnings };
}

// ---------------------------------------------------------------- components

const LIB_IDS = new Set(Object.keys(libraryComponents()));

/**
 * component @Name                     restyle / add variants:  "variant=pill rfull px6" · "* shadow:md" (all instances)
 * component @Name from #id [keep]     building block from layers (text/icon/image layers become props); the
 *                                     layers are replaced by a linked instance unless "keep". Again = update.
 * component @Name reset               drop your rules (library components return to the library look)
 * component @Name none                delete a user component (must be unused)
 */
function compileComponent(doc: RangoliDocument, cmd: Extract<Command, { kind: 'component' }>, ctx: RdlContext, page: Page, ops: Op[], errors: Diagnostic[]) {
  const err = (message: string, line = cmd.line) => errors.push({ line, severity: 'error', message });
  const existing = doc.data.components[cmd.name];
  for (const o of cmd.opts) if (!['keep', 'reset', 'none'].includes(o)) err(`component option "${o}" — use: from #id [keep] · reset · none`);

  if (cmd.opts.includes('none')) {
    if (!existing) return err(`@${cmd.name} not found`);
    if (LIB_IDS.has(cmd.name)) return err(`@${cmd.name} is a library component — use "component @${cmd.name} reset" to undo your changes`);
    const used = Object.values(doc.data.pages).flatMap((p) => Object.values(p.nodes)).filter((n) => n.component === cmd.name);
    if (used.length) return err(`@${cmd.name} is used by ${used.length} layer(s) (#${used.slice(0, 3).map((n) => n.id).join(', #')}) — delete or detach them first`);
    ops.push({ op: 'deleteComponent', id: cmd.name });
    return;
  }
  if (cmd.detach) {
    // instance → real, editable layers (edit, then "component @X from #id" pushes the change to every instance)
    const inst = page.nodes[cmd.detach];
    if (!inst) return err(`#${cmd.detach} not found`);
    if (inst.component !== cmd.name || !existing?.template) return err(`#${cmd.detach} is not an instance of a building block @${cmd.name}`);
    const fresh: Record<string, string> = {};
    const { root, nodes } = expandTemplate(inst, existing, (tid) => (fresh[tid] ??= doc.ids.make()));
    const siblings = inst.parent ? page.nodes[inst.parent]!.children ?? [] : page.children;
    const index = siblings.indexOf(inst.id);
    ops.push({ op: 'delete', page: page.id, id: inst.id });
    const emit = (n: RNode, parent: string | undefined, at: number | undefined) => {
      const { children, ...rest } = n;
      ops.push({ op: 'create', page: page.id, node: { ...rest, parent } as RNode, parent, index: at });
      for (const c of children ?? []) if (nodes[c]) emit(nodes[c]!, n.id, undefined);
    };
    emit(root, inst.parent, index);
    return;
  }
  if (cmd.opts.includes('reset')) {
    if (!existing) return err(`@${cmd.name} not found`);
    const lib = libraryComponents()[cmd.name];
    ops.push({ op: 'setComponent', component: lib ?? { ...existing, styles: existing.styles.filter((r) => !r.user) } });
    return;
  }

  let def: ComponentDef;
  if (cmd.from) {
    const src = page.nodes[cmd.from];
    if (!src) return err(`#${cmd.from} not found`);
    if (existing && !existing.template) return err(`@${cmd.name} already exists as a ${LIB_IDS.has(cmd.name) ? 'library' : 'user'} component — pick another name`);
    if (src.type === 'instance' && src.component === cmd.name) return err(`#${cmd.from} is already an instance of @${cmd.name}`);
    const { template, slots } = snapshotTemplate(page, src.id);
    const firstText = Object.entries(slots).find(([, v]) => v.kind === 'text')?.[0];
    def = existing
      ? { ...structuredClone(existing), template, slots, labelProp: firstText, ...(cmd.description ? { description: cmd.description } : {}) }
      : { id: cmd.name, name: cmd.name, axes: {}, defaults: {}, styles: [], custom: true, template, slots, labelProp: firstText, ...(cmd.description ? { description: cmd.description } : {}) };
    if (!cmd.opts.includes('keep')) {
      // the source layers become a linked instance (same id, so links and prototype hooks keep working)
      const siblings = src.parent ? page.nodes[src.parent]!.children ?? [] : page.children;
      const index = siblings.indexOf(src.id);
      const inst: RNode = { id: src.id, type: 'instance', name: src.name, component: cmd.name, parent: src.parent };
      if (src.position) inst.position = src.position;
      if (src.absolute) inst.absolute = true;
      ops.push({ op: 'delete', page: page.id, id: src.id }, { op: 'create', page: page.id, node: inst, parent: src.parent, index });
    }
  } else {
    if (!existing) return err(`@${cmd.name} not found — make one from layers with "component @${cmd.name} from #id"`);
    def = structuredClone(existing);
  }
  if (cmd.description && !cmd.from) def.description = cmd.description;

  // rule lines: "<axis=value[,axis=value]>|* flags…"
  for (const l of cmd.lines) {
    const [sel, ...flags] = l.toks;
    if (!sel) continue;
    const when: Record<string, string> = {};
    if (sel !== '*') {
      for (const part of sel.split(',')) {
        const m = /^([\w-]+)=([\w-]+)$/.exec(part);
        if (!m) { err(`rule must start with axis=value (e.g. variant=pill) or * for all — got "${sel}"`, l.no); continue; }
        when[m[1]!] = m[2]!;
        // a brand-new axis starts with a neutral "default" value, so existing instances keep their look
        const vals = (def.axes[m[1]!] ??= m[2] === 'default' ? [] : ['default']);
        if (!vals.includes(m[2]!)) vals.push(m[2]!); // new variant value
        def.defaults[m[1]!] ??= vals[0]!;
      }
    }
    if (!flags.length) { err(`rule "${sel}" has no styles — add flags like "rfull px6 fill:primary.700"`, l.no); continue; }
    const scratch: RNode = { id: '_', type: 'frame', name: '_' };
    applyFlags(scratch, flags.filter((f) => !f.startsWith('"')), undefined, ctx, l.no, errors);
    const explicitMode = flags.some((f) => ['row', 'col', 'grid', 'none'].includes(f));
    const layout = scratch.layout ? { ...scratch.layout } as Partial<Layout> : undefined;
    if (layout && !explicitMode) delete layout.mode;
    const key = JSON.stringify(when);
    const prev = def.styles.find((r) => r.user && JSON.stringify(r.when) === key);
    if (prev) {
      prev.style = { ...prev.style, ...scratch.style };
      if (layout) prev.layout = { ...prev.layout, ...layout };
      if (scratch.size) prev.size = { ...prev.size, ...scratch.size };
    } else def.styles.push({ when, style: scratch.style ?? {}, ...(layout ? { layout } : {}), ...(scratch.size ? { size: scratch.size } : {}), user: true });
  }
  ops.push({ op: 'setComponent', component: def });
}

/** Copy a subtree into template ids t1…, and find its slots (text, icon, image layers by name). */
export function snapshotTemplate(page: Page, rootId: string): { template: NonNullable<ComponentDef['template']>; slots: NonNullable<ComponentDef['slots']> } {
  const nodes: Record<string, RNode> = {};
  const slots: NonNullable<ComponentDef['slots']> = {};
  let k = 0;
  const copy = (id: string, parent: string | undefined): string => {
    const n = page.nodes[id]!;
    const tid = `t${++k}`;
    const c: RNode = { ...structuredClone(n), id: tid, parent };
    if (!parent) { delete c.parent; delete c.position; delete c.absolute; }
    nodes[tid] = c;
    const kind = n.type === 'text' ? 'text' : n.type === 'vector' && n.icon ? 'icon' : n.type === 'image' ? 'image' : undefined;
    if (kind && parent) {
      let name = slotName(n.name);
      for (let i = 2; slots[name]; i++) name = `${slotName(n.name)}-${i}`;
      slots[name] = { node: tid, kind };
    }
    if (n.children) c.children = n.children.filter((cid) => page.nodes[cid]).map((cid) => copy(cid, tid));
    return tid;
  };
  const root = copy(rootId, undefined);
  return { template: { root, nodes }, slots };
}

// ---------------------------------------------------------------- serialize

export type Detail = 'outline' | 'compact';

export function serializeRdl(doc: RangoliDocument, opts: { roots?: string[]; page?: string; detail?: Detail; depth?: number } = {}): string {
  const page = doc.page(opts.page);
  const tokens = new TokenResolver(doc.data.tokens);
  const detail = opts.detail ?? 'compact';
  const maxDepth = opts.depth ?? Infinity;
  const lines: string[] = [];
  const visit = (id: string, depth: number) => {
    const n = page.nodes[id];
    if (!n) return;
    const pad = '  '.repeat(depth);
    if (detail === 'outline') {
      const kind = n.component ? `@${n.component}` : n.type;
      const kids = n.children?.length ?? 0;
      const more = depth >= maxDepth && kids ? ` (+${kids})` : '';
      lines.push(`${pad}${n.name}#${n.id} ${kind}${n.role ? ` role:${n.role}` : ''}${n.text ? ` ${JSON.stringify(truncate(n.text, 40))}` : ''}${more}`);
    } else {
      lines.push(pad + nodeLine(n, tokens, doc));
    }
    if (depth < maxDepth) for (const c of n.children ?? []) visit(c, depth + 1);
    else if (detail === 'compact' && n.children?.length) lines.push(`${pad}  … ${n.children.length} children`);
  };
  for (const id of opts.roots ?? page.children) visit(id, 0);
  return lines.join('\n');
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function lenStr(v: Len, group: string): string {
  if (isTokenRef(v)) return v.token.startsWith(`${group}.`) ? v.token.slice(group.length + 1) : v.token;
  return `${v}px`;
}

function paintStr(p: Paint, tokens: TokenResolver): string {
  if (isTokenRef(p)) return `${tokens.shortName(p.token, 'color')}${p.alpha !== undefined ? `~${p.alpha}` : ''}`;
  if ('hex' in p) return p.hex;
  const g = p.gradient;
  const stops = g.stops.map((s, i) => `${paintStr(s.color, tokens)}${Math.abs(s.at - i / (g.stops.length - 1)) > 0.001 ? `@${Math.round(s.at * 100)}` : ''}`);
  return g.type === 'linear' ? `linear(${g.angle ?? 180},${stops.join(',')})` : `radial(${stops.join(',')})`;
}

const radiusStr = (v: Len) => (isTokenRef(v) ? v.token.replace(/^radius\./, '') : String(v));
const q = (s: string) => (/^[\w#~.,()@/%-]+$/.test(s) ? s : JSON.stringify(s));

export function nodeLine(n: RNode, tokens: TokenResolver, doc: RangoliDocument): string {
  const parts: string[] = [];
  // names that can't be a bare head token are written as a generic head + name:"…"
  const safeName = /^[^\s#"@][^\s#"]*$/.test(n.name);
  const generic = { frame: 'Frame', text: 'Text', vector: 'Vector', image: 'Image', group: 'Group', instance: 'Instance' }[n.type];
  const headName = safeName ? n.name : generic;
  if (!safeName) parts.push(''); // placeholder, filled below
  if (n.type === 'instance' && n.component) {
    parts.length = 0;
    parts.push(n.name === n.component ? `@${n.component}#${n.id}` : `${headName}#${n.id} @${n.component}`);
  } else {
    parts.length = 0;
    parts.push(`${headName}#${n.id}`);
    const inferredText = /^(Text|Label|Title|Heading|Caption)\b/.test(headName);
    if (n.type === 'text' && !inferredText) parts.push('text');
    if (n.type === 'vector' && !/^(Icon|Vector)\b/.test(headName)) parts.push('vector');
    if (n.type === 'image' && !/^(Image|Img|Avatar)\b/.test(headName)) parts.push('image');
    if (n.type === 'group') parts.push('group');
    if (n.type === 'frame' && inferredText) parts.push('frame');
  }
  if (!safeName) parts.push(`name:${JSON.stringify(n.name)}`);
  const l = n.layout;
  if (l && n.type !== 'text') {
    if (l.mode === 'grid' && typeof l.columns === 'number') parts.push(`cols${l.columns}`);
    else if (l.mode !== 'col' || n.type === 'instance') { if (n.type !== 'instance') parts.push(l.mode); }
    if (l.wrap) parts.push('wrap');
    if (l.gap !== undefined) parts.push(`gap${lenStr(l.gap, 'space')}`);
    if (l.padding) parts.push(...padStr(l.padding));
    if (l.justify && l.align === 'center' && l.justify === 'center') parts.push('middle');
    else {
      if (l.justify) parts.push(l.justify === 'between' || l.justify === 'around' ? l.justify : `j${l.justify}`);
      if (l.align) parts.push(l.align);
    }
  }
  const s = n.size;
  if (s) {
    for (const k of ['w', 'h'] as const) {
      const d = s[k];
      if (!d) continue;
      if (d.kind === 'fixed') parts.push(`${k}${isTokenRef(d.v) ? d.v.token : d.v}`);
      else parts.push(`${k}${d.kind}`);
    }
    if (s.minW !== undefined) parts.push(`minw${s.minW}`);
    if (s.maxW !== undefined) parts.push(`maxw${s.maxW}`);
    if (s.minH !== undefined) parts.push(`minh${s.minH}`);
    if (s.maxH !== undefined) parts.push(`maxh${s.maxH}`);
  }
  const st = n.style;
  if (st) {
    if (st.textStyle) parts.push(st.textStyle.token.replace(/^textStyle\./, ''));
    if (st.fill) parts.push(st.fill.length ? `fill:${paintStr(st.fill[0]!, tokens)}` : 'fill:none');
    if (st.stroke) {
      const sk = st.stroke;
      const extra = sk.sides || (sk.style && sk.style !== 'solid');
      parts.push(`stroke:${paintStr(sk.paint, tokens)}${(sk.width && sk.width !== 1) || extra ? `/${sk.width ?? 1}` : ''}${extra ? `/${sk.style ?? 'solid'}` : ''}${sk.sides ? `/${sk.sides}` : ''}`);
    }
    if (st.radius !== undefined) parts.push(Array.isArray(st.radius) ? `r:${st.radius.map(radiusStr).join(',')}` : `r${lenStr(st.radius, 'radius')}`);
    if (st.shadow && isTokenRef(st.shadow)) parts.push(`shadow:${st.shadow.token.replace(/^shadow\./, '')}`);
    else if (Array.isArray(st.shadow)) st.shadow.forEach((sh, i) => parts.push(`shadow${i ? '+' : ''}:${sh.x},${sh.y},${sh.blur},${sh.spread ?? 0},${paintStr(sh.color, tokens)}${sh.inset ? ',inset' : ''}`));
    if (st.color) {
      const c = paintStr(st.color, tokens);
      parts.push(c === 'muted' || (isTokenRef(st.color) && st.color.token === 'color.text.muted') ? 'muted' : `color:${c}`);
    }
    if (st.opacity !== undefined) parts.push(`opacity:${st.opacity}`);
    if (st.textAlign) parts.push(`align:${st.textAlign}`);
    if (st.mono) parts.push('mono');
    if (typeof st.font?.size === 'number') parts.push(`size:${st.font.size}`);
    if (st.font?.weight) parts.push(`weight:${st.font.weight}`);
    if (st.font?.family) {
      const fam = st.font.family;
      const tokenFam = /^var\(--font-family-([\w-]+)\)$/.exec(fam);
      parts.push(`font:${tokenFam ? tokenFam[1] : q(fam)}`);
    }
    if (st.font?.lineHeight !== undefined && !(typeof st.font.size === 'number' && st.font.lineHeight === 1.15)) parts.push(`lh:${st.font.lineHeight}`);
    if (st.font?.letterSpacing !== undefined) parts.push(`ls:${st.font.letterSpacing}`);
    if (st.italic) parts.push('italic');
    if (st.decoration) parts.push(st.decoration === 'underline' ? 'underline' : st.decoration === 'line-through' ? 'strike' : 'nodecoration');
    if (st.textTransform && st.textTransform !== 'none') parts.push(st.textTransform === 'uppercase' ? 'upper' : st.textTransform === 'lowercase' ? 'lower' : 'capitalize');
    if (st.truncate) parts.push('truncate');
    if (st.clip) parts.push('clip');
    if (st.blur) parts.push(`blur:${st.blur}`);
    if (st.backdropBlur) parts.push(`bgblur:${st.backdropBlur}`);
    if (st.blend) parts.push(`blend:${st.blend}`);
    if (st.rotate) parts.push(`rotate:${st.rotate}`);
    if (st.z !== undefined) parts.push(`z:${st.z}`);
    if (st.overflow) parts.push(`overflow:${st.overflow}`);
    if (st.cursor) parts.push(`cursor:${st.cursor}`);
    if (st.aspect) parts.push(`ratio:${st.aspect}`);
    if (st.css) parts.push(`css:${JSON.stringify(st.css)}`);
  }
  if (n.type === 'vector' && n.vector && !n.icon) {
    const v = n.vector;
    parts.push(`vb:${v.vw},${v.vh}`);
    if (v.shapes) parts.push(`shapes:${JSON.stringify(v.shapes)}`);
    for (const p of v.paths) if (!p.fromShapes) parts.push(`d:${JSON.stringify(p.d)}`);
  }
  if (n.absolute) parts.push('abs');
  if (n.icon) {
    // short name when unambiguous
    const short = n.icon.split('/')[1]!;
    const f = findIcon(doc.data.icons, short);
    parts.push(`icon:${f && `${f.set.name}/${f.icon.name}` === n.icon ? short : n.icon}`);
  }
  if (n.image) {
    if (n.image.asset) parts.push(`asset:${n.image.asset}`);
    if (n.image.fit) parts.push(`fit:${n.image.fit}`);
    if (n.image.decorative) parts.push('decorative');
    else if (n.image.alt !== undefined) parts.push(`alt:${JSON.stringify(n.image.alt)}`);
  }
  if (n.position) parts.push(`at:${n.position.x},${n.position.y}`);
  if (n.role) parts.push(`role:${n.role}`);
  if (n.hidden) parts.push('hidden');
  if (n.locked) parts.push('locked');
  for (const [k, v] of Object.entries(n.variant ?? {})) parts.push(`${k}=${v}`);
  const comp = n.component ? doc.data.components[n.component] : undefined;
  const labelProp = comp?.labelProp ?? 'label';
  let label: string | undefined;
  for (const [k, v] of Object.entries(n.props ?? {})) {
    if (n.type === 'instance' && k === labelProp && typeof v === 'string') { label = v; continue; }
    parts.push(`${k}=${typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : v}`);
  }
  const txt = n.type === 'instance' ? label : n.text;
  if (txt !== undefined) parts.push(JSON.stringify(txt));
  return parts.join(' ');
}

function padStr(p: [Len, Len, Len, Len]): string[] {
  const [t, r, b, l] = p.map((v) => lenStr(v, 'space'));
  if (t === r && r === b && b === l) return [`p${t}`];
  const out: string[] = [];
  if (t === b && r === l) return [`py${t}`, `px${r}`];
  const push = (side: string, v: string) => { if (v !== '0px' && v !== '0') out.push(`p${side}${v}`); };
  push('t', t!); push('r', r!); push('b', b!); push('l', l!);
  return out;
}

/** Resolved token helper for consumers. */
export function tokenOf(ref: TokenRef | undefined): string | undefined {
  return ref?.token;
}

/** A component's user customisations as an editable "component @X" block ('' when there are none). */
export function componentRdl(doc: RangoliDocument, name: string): string {
  const def = doc.data.components[name];
  if (!def) return '';
  const tokens = new TokenResolver(doc.data.tokens);
  const lines: string[] = [];
  for (const r of def.styles.filter((x) => x.user)) {
    // "col" is the frame default and prints nothing, so a rule without a mode never gains one
    const scratch: RNode = { id: 'x', type: 'frame', name: 'R', style: r.style, ...(r.layout ? { layout: { ...r.layout, mode: r.layout.mode ?? 'col' } as Layout } : {}), ...(r.size ? { size: r.size } : {}) };
    const flags = nodeLine(scratch, tokens, doc).replace(/^R#x\s*/, '').trim();
    const mode = r.layout?.mode === 'col' ? 'col ' : '';
    const sel = Object.entries(r.when).map(([k, v]) => `${k}=${v}`).join(',') || '*';
    lines.push(`  ${sel} ${mode}${flags}`);
  }
  return lines.length ? `component @${name}\n${lines.join('\n')}` : '';
}
