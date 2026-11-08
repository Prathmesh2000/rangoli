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
import { isTokenRef, type Dim, type Layout, type Len, type Paint, type RNode, type Sizing, type Style, type TokenRef } from './model.js';
import { TokenResolver } from './tokens.js';

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
  | { kind: 'replace'; line: number; id: string; nodes: PNode[] };

export type Where = { pos: 'start' | 'end' } | { pos: 'before' | 'after'; ref: string } | { pos: 'index'; index: number };

const COMMANDS = new Set(['set', 'insert', 'move', 'delete', 'replace']);
const isCommandLine = (ln: Line) => COMMANDS.has(ln.toks[0]!) && !!ln.toks[1]?.startsWith('#');

export function parseRdl(src: string): { commands: Command[]; errors: Diagnostic[] } {
  const lines = lex(src);
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
}

function lenFrom(group: 'space' | 'radius', v: string, ctx: RdlContext, line: number, diag: Diagnostic[]): Len | undefined {
  if (/^\d+(\.\d+)?px$/.test(v)) return parseFloat(v);
  const path = `${group}.${v}`;
  if (ctx.tokens.has(path)) return { token: path };
  diag.push({ line, severity: 'error', message: `Unknown ${group} step "${v}". Use a scale step (${ctx.tokens.group(group).map((t) => t.path.split('.').pop()).join(', ')}) or "<n>px".` });
  return undefined;
}

function paintFrom(v: string, ctx: RdlContext, line: number, diag: Diagnostic[]): Paint | undefined {
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return { hex: v.toLowerCase() };
  const found = ctx.tokens.find(v, 'color');
  if (found) return { token: found };
  diag.push({ line, severity: 'error', message: `Unknown color "${v}". Use a color token (e.g. surface, text.secondary, primary.600) or #hex.` });
  return undefined;
}

const fixed = (v: number): Dim => ({ kind: 'fixed', v });

/** Apply flags onto a mutable node. Returns nothing; reports diagnostics. */
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
    if ((m = /^r(\d+(?:\.\d+)?(?:px)?|full)$/.exec(f))) { const v = lenFrom('radius', m[1]!, ctx, line, diag); if (v !== undefined) style().radius = v; continue; }
    if ((m = /^(fill|bg):(.+)$/.exec(f))) {
      if (m[2] === 'none') { style().fill = []; continue; }
      const p = paintFrom(m[2]!, ctx, line, diag);
      if (p) style().fill = [p];
      continue;
    }
    if ((m = /^stroke:([^/]+)(?:\/(\d+(?:\.\d+)?))?$/.exec(f))) {
      if (m[1] === 'none') { delete style().stroke; continue; }
      const p = paintFrom(m[1]!, ctx, line, diag);
      if (p) style().stroke = { paint: p, width: m[2] ? parseFloat(m[2]) : 1, align: 'inside' };
      continue;
    }
    if ((m = /^color:(.+)$/.exec(f))) { const p = paintFrom(m[1]!, ctx, line, diag); if (p) style().color = p; continue; }
    if ((m = /^shadow:(.+)$/.exec(f))) {
      if (m[1] === 'none') { delete style().shadow; continue; }
      const path = ctx.tokens.find(m[1]!, 'shadow');
      if (path) style().shadow = { token: path };
      else diag.push({ line, severity: 'error', message: `Unknown shadow "${m[1]}" (try ${ctx.tokens.group('shadow').map((t) => t.path.split('.').pop()).join(', ')})` });
      continue;
    }
    if ((m = /^opacity:(\d*\.?\d+)$/.exec(f))) { style().opacity = parseFloat(m[1]!); continue; }
    if ((m = /^role:(.+)$/.exec(f))) { node.role = m[1]; continue; }
    if ((m = /^at:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(f))) { node.position = { x: parseFloat(m[1]!), y: parseFloat(m[2]!) }; continue; }
    if ((m = /^align:(left|center|right)$/.exec(f))) { style().textAlign = m[1] as 'left'; continue; }
    if (f === 'muted') { style().color = { token: ctx.tokens.find('text.muted', 'color') ?? 'color.text.muted' }; continue; }
    if (f === 'mono') { style().mono = true; continue; }
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
      } else (node.props ??= {})[key] = val;
      continue;
    }
    diag.push({ line, severity: 'error', message: `Unknown flag "${f}"` });
  }

  if (text !== undefined) {
    if (node.type === 'instance') {
      const prop = comp?.labelProp ?? 'label';
      (node.props ??= {})[prop] = text;
    } else {
      node.text = text;
      if (node.type === 'frame' && !node.children?.length && !hasChildren) node.type = 'text';
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
  const ctx: RdlContext = { tokens: new TokenResolver(doc.data.tokens), components: doc.data.components };
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
    const ref = page.nodes[where.ref];
    if (!ref) { errors.push({ line, severity: 'error', message: `#${where.ref} not found` }); return undefined; }
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
        for (const k of ['type', 'name', 'role', 'layout', 'size', 'position', 'style', 'text', 'variant', 'props', 'hidden', 'locked'] as const) {
          if (JSON.stringify(copy[k]) !== JSON.stringify(node[k])) patch[k] = copy[k] ?? null;
        }
        if (Object.keys(patch).length) ops.push({ op: 'update', page: page.id, id: cmd.id, patch: patch as Partial<RNode> });
        break;
      }
      case 'delete':
        if (!page.nodes[cmd.id]) errors.push({ line: cmd.line, severity: 'error', message: `#${cmd.id} not found` });
        else ops.push({ op: 'delete', page: page.id, id: cmd.id });
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
        delete page.nodes[cmd.id]; // temporarily hide for exists() check
        try { emitTree(cmd.nodes, target.parent, index); } finally { page.nodes[cmd.id] = target; }
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
  if (isTokenRef(p)) return tokens.shortName(p.token, 'color');
  if ('hex' in p) return p.hex;
  return 'gradient';
}

export function nodeLine(n: RNode, tokens: TokenResolver, doc: RangoliDocument): string {
  const parts: string[] = [];
  if (n.type === 'instance' && n.component) {
    parts.push(n.name === n.component ? `@${n.component}#${n.id}` : `${n.name}#${n.id} @${n.component}`);
  } else {
    parts.push(`${n.name}#${n.id}`);
    const inferredText = /^(Text|Label|Title|Heading|Caption)\b/.test(n.name);
    if (n.type === 'text' && !inferredText) parts.push('text');
    if (n.type === 'vector' && !/^(Icon|Vector)\b/.test(n.name)) parts.push('vector');
    if (n.type === 'image' && !/^(Image|Img|Avatar)\b/.test(n.name)) parts.push('image');
    if (n.type === 'group') parts.push('group');
    if (n.type === 'frame' && inferredText) parts.push('frame');
  }
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
    if (st.stroke) parts.push(`stroke:${paintStr(st.stroke.paint, tokens)}${st.stroke.width && st.stroke.width !== 1 ? `/${st.stroke.width}` : ''}`);
    if (st.radius !== undefined && !Array.isArray(st.radius)) parts.push(`r${lenStr(st.radius, 'radius')}`);
    if (st.shadow && isTokenRef(st.shadow)) parts.push(`shadow:${st.shadow.token.replace(/^shadow\./, '')}`);
    if (st.color) {
      const c = paintStr(st.color, tokens);
      parts.push(c === 'muted' || (isTokenRef(st.color) && st.color.token === 'color.text.muted') ? 'muted' : `color:${c}`);
    }
    if (st.opacity !== undefined) parts.push(`opacity:${st.opacity}`);
    if (st.textAlign) parts.push(`align:${st.textAlign}`);
    if (st.mono) parts.push('mono');
    if (st.truncate) parts.push('truncate');
    if (st.clip) parts.push('clip');
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
