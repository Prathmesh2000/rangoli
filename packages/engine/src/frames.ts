/**
 * Retained, per-frame rendering (ARCHITECTURE.md section 4, "Incremental render").
 *
 * Each top-level frame of a page is rendered on its own and cached as { html, css, used components }.
 * A change names what it touched (ChangeEntry.touched); `sync` maps node ids to their root frame through
 * parents, re-renders only those frames and reports which frames' output actually changed, so a canvas can
 * patch just those elements and their stylesheets. Shared CSS (fonts, tokens, base, component states,
 * motion) is kept apart and recomputed only when its inputs can have changed.
 *
 * Invariant (tested in frames.test.ts): after any sequence of syncs,
 *   html() === renderFragment(doc, opts).html   and   css() === renderCss(doc, frag.css, frag.usedComponents).
 */
import type { RangoliDocument } from './document.js';
import type { Page, RNode, TokenTree } from './model.js';
import { escapeStyleText, renderComponentCss, renderFragment, RENDER_BASE_CSS, type RenderOptions } from './render.js';
import { fontHead } from './fonts.js';
import { TokenResolver, tokensToCss } from './tokens.js';
import { motionCss } from './motion.js';

// canvas geometry travels with the frame renderer (index.ts re-exports this module)
export * from './canvas-layout.js';

export interface FrameRender {
  id: string;
  html: string;
  /** this frame's node rules ("" when it has none) */
  css: string;
  /** library components the frame uses, in first-use order */
  used: string[];
  /** page node ids inside the frame, the frame included */
  nodes: string[];
  /** components its layers instantiate directly (templates are followed at sync time) */
  components: string[];
  /** CSS variables its html, node rules and component CSS read (computed on first use) */
  vars?: Set<string>;
}

export interface FrameDelta {
  /** top-level frame ids in page order after the sync */
  order: string[];
  /** frames whose html or css differ from before (new frames included), in page order */
  changed: string[];
  /** frames that left the page */
  removed: string[];
  /** order or membership of top-level frames changed */
  orderChanged: boolean;
  /** fonts, tokens, base or component CSS changed */
  headChanged: boolean;
  motionChanged: boolean;
  /** fonts may have changed: a host that loads font files should re-read fontHead(doc) */
  fontsDirty: boolean;
  /**
   * When only token values changed in the shared CSS: the CSS variables whose value changed (any mode), so a
   * host that scopes styles per frame restyles only frames that read them (framesReading). null when the
   * shared CSS changed in a way that is not limited to variables (or nothing in it changed: see headChanged).
   */
  tokenVars: string[] | null;
  /** how many frames were rendered to produce this delta (cost, not output) */
  rendered: number;
  /** the whole page was re-rendered (no usable touched set) */
  full: boolean;
}

/** Touched keys (see document.ts applyOne) whose effect is limited to shared CSS or to nothing on the canvas. */
const MOTION_KEY = /^\$(motion|timeline):/;
const NO_RENDER_KEY = /^\$proto:/;

export class FrameRenderer {
  private frames = new Map<string, FrameRender>();
  private nodeFrame = new Map<string, string>();
  /** layers (any page) with their own font family, as of the last sync */
  private fontNodes = new Set<string>();
  private orderList: string[] = [];
  /** what frame markup reads from tokens: names (in order) and text-style values; see tokenSignature */
  private tokenSig = '';
  private pageId: string | undefined;
  private parts = { fonts: '', tokens: '', components: '', motion: '' };
  private headText = '';
  private doc: RangoliDocument | undefined;

  constructor(private readonly opts: Omit<RenderOptions, 'roots'> = {}) {}

  get order(): readonly string[] {
    return this.orderList;
  }

  frame(id: string): FrameRender | undefined {
    return this.frames.get(id);
  }

  /** The top-level frame a page node was last rendered in. */
  frameOf(id: string): string | undefined {
    return this.nodeFrame.get(id);
  }

  /**
   * Bring the cache up to date with `doc`. `touched` is the union of ChangeEntry.touched since the last sync;
   * null (or a different page) re-renders every frame, and still reports only the frames whose output changed.
   */
  sync(doc: RangoliDocument, touched: Iterable<string> | null): FrameDelta {
    const page = doc.page(this.opts.page);
    const first = !this.doc;
    const full = touched === null || first || page.id !== this.pageId;
    this.doc = doc;
    this.pageId = page.id;

    let all = full;
    let tokensDirty = full;
    let motionDirty = full;
    let fontsDirty = full;
    const dirty = new Set<string>();
    const changedComponents = new Set<string>();
    if (full) {
      this.fontNodes = nodesWithFamily(doc);
      this.tokenSig = tokenSignature(doc.data.tokens);
    } else {
      for (const t of touched!) {
        if (t.startsWith('$')) {
          if (t === '$tokens') {
            tokensDirty = motionDirty = fontsDirty = true;
            // markup reads token names and text-style values only; a colour or spacing value is a CSS variable
            const sig = tokenSignature(doc.data.tokens);
            if (sig !== this.tokenSig) { all = true; this.tokenSig = sig; }
          } else if (MOTION_KEY.test(t)) motionDirty = true;
          else if (t.startsWith('$component:')) { changedComponents.add(t.slice('$component:'.length)); fontsDirty = true; }
          else if (!NO_RENDER_KEY.test(t)) all = true; // icons, assets, anything new: re-render all, the diff below keeps DOM work small
          continue;
        }
        // fonts: only a layer that has, or had, its own family can change the font list
        const family = hasFamily(doc, t);
        if (family || this.fontNodes.has(t)) {
          fontsDirty = true;
          if (family) this.fontNodes.add(t);
          else this.fontNodes.delete(t);
        }
        const now = frameRootOf(page, t);
        if (now) dirty.add(now);
        const before = this.nodeFrame.get(t);
        if (before) dirty.add(before);
      }
    }

    // top-level order: every node listed on the page, like renderFragment
    const order = page.children.filter((id) => !!page.nodes[id]);
    const prevOrder = this.orderList;
    const orderChanged = order.length !== prevOrder.length || order.some((id, i) => id !== prevOrder[i]);
    const keep = new Set(order);
    const removed = prevOrder.filter((id) => !keep.has(id));
    for (const id of removed) this.drop(id);

    // a component change reaches the frames that instantiate it, directly or through building blocks
    if (changedComponents.size && !all) {
      const reach = new Map<string, Set<string>>();
      for (const id of order) {
        const f = this.frames.get(id);
        if (f && !dirty.has(id) && f.components.some((c) => intersects(reachable(doc, c, reach), changedComponents))) dirty.add(id);
      }
    }

    const changed: string[] = [];
    let rendered = 0;
    for (const id of order) {
      const prev = this.frames.get(id);
      if (prev && !all && !dirty.has(id)) continue;
      const next = this.renderFrame(doc, page, id);
      rendered++;
      if (prev && prev.html === next.html && prev.css === next.css && sameList(prev.used, next.used)) {
        // output unchanged; the node list can still have changed (e.g. a hidden-id child), so keep it fresh
        this.index(prev, next.nodes);
        prev.components = next.components;
        continue;
      }
      if (prev) this.unindex(prev);
      this.frames.set(id, next);
      this.index(next, next.nodes);
      changed.push(id);
    }
    this.orderList = order;

    // shared CSS, each part recomputed only when its inputs can have changed
    const fonts = fontsDirty ? fontHead(doc).css : this.parts.fonts;
    const tokens = tokensDirty ? tokensToCss(doc.data.tokens) : this.parts.tokens;
    const components = renderComponentCss(this.usedAll());
    const motion = motionDirty ? motionCss(doc.data.motion, doc.data.tokens, doc.data.timelines) : this.parts.motion;
    const headChanged = full || fonts !== this.parts.fonts || tokens !== this.parts.tokens || components !== this.parts.components;
    // fonts (@font-face, ignored inside shadow roots) and component CSS (static per component, so it only grows
    // or shrinks with the set used) never change how an untouched frame looks; token values can
    const tokenVars = !full && headChanged ? changedVars(this.parts.tokens, tokens) : null;
    const motionChanged = full || motion !== this.parts.motion;
    this.parts = { fonts, tokens, components, motion };
    if (headChanged) this.headText = escapeStyleText([fonts, tokens, RENDER_BASE_CSS, components].filter(Boolean).join('\n\n'));

    return { order, changed, removed, orderChanged, headChanged, motionChanged, fontsDirty, rendered, full, tokenVars };
  }

  /**
   * Frames whose output reads any of these CSS variables, directly or through component and base CSS, in page
   * order. Base CSS styles the frame host (body rules), so a variable it reads reaches every frame.
   */
  framesReading(vars: Iterable<string>): string[] {
    const want = new Set(vars);
    if (!want.size) return [];
    for (const v of varsIn(RENDER_BASE_CSS)) if (want.has(v)) return [...this.orderList];
    return this.orderList.filter((id) => {
      const f = this.frames.get(id);
      if (!f) return false;
      f.vars ??= new Set([...varsIn(f.css), ...varsIn(f.html), ...varsIn(renderComponentCss(f.used))]);
      for (const v of f.vars) if (want.has(v)) return true;
      return false;
    });
  }

  /** Fonts, tokens (all modes), base and component CSS: everything before node rules. */
  headCss(): string {
    return this.headText;
  }

  /** Motion and timeline CSS: everything after node rules. */
  motionCss(): string {
    return escapeStyleText(this.parts.motion);
  }

  /** A frame's node rules, escaped like renderCss. */
  frameCss(id: string): string {
    return escapeStyleText(this.frames.get(id)?.css ?? '');
  }

  /** The page fragment, identical to renderFragment(doc, opts).html. */
  html(): string {
    return this.orderList.map((id) => this.frames.get(id)!.html).join('\n');
  }

  /** The page CSS, identical to renderCss(doc, fragment.css, fragment.usedComponents). */
  css(): string {
    const nodeRules = this.orderList.map((id) => this.frames.get(id)!.css).filter(Boolean).join('\n');
    return escapeStyleText([this.parts.fonts, this.parts.tokens, RENDER_BASE_CSS, this.parts.components, nodeRules, this.parts.motion].filter(Boolean).join('\n\n'));
  }

  /** Library components used anywhere on the page, in the order a single render would meet them. */
  usedAll(): string[] {
    const out = new Set<string>();
    for (const id of this.orderList) for (const c of this.frames.get(id)!.used) out.add(c);
    return [...out];
  }

  private renderFrame(doc: RangoliDocument, page: Page, id: string): FrameRender {
    const f = renderFragment(doc, { ...this.opts, page: page.id, roots: [id] });
    const { nodes, components } = subtree(page, id);
    return { id, html: f.html, css: f.css, used: f.usedComponents, nodes, components };
  }

  private index(f: FrameRender, nodes: string[]): void {
    if (f.nodes !== nodes) {
      this.unindex(f);
      f.nodes = nodes;
    }
    for (const n of nodes) this.nodeFrame.set(n, f.id);
  }

  private unindex(f: FrameRender): void {
    for (const n of f.nodes) if (this.nodeFrame.get(n) === f.id) this.nodeFrame.delete(n);
  }

  private drop(id: string): void {
    const f = this.frames.get(id);
    if (!f) return;
    this.unindex(f);
    this.frames.delete(id);
  }
}

/** The top-level frame holding `id` on this page, walking parents (O(depth)). */
export function frameRootOf(page: Page, id: string): string | undefined {
  let n: RNode | undefined = Object.hasOwn(page.nodes, id) ? page.nodes[id] : undefined;
  let guard = 0;
  while (n?.parent && guard++ < 10_000) {
    const p: RNode | undefined = Object.hasOwn(page.nodes, n.parent) ? page.nodes[n.parent] : undefined;
    if (!p) return undefined; // orphan: not on the canvas
    n = p;
  }
  return n && page.children.includes(n.id) ? n.id : undefined;
}

function subtree(page: Page, root: string): { nodes: string[]; components: string[] } {
  const nodes: string[] = [];
  const components = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    const n = page.nodes[id];
    if (!n) continue;
    nodes.push(id);
    if (n.component) components.add(n.component);
    if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return { nodes, components: [...components] };
}

/** A component and every component its building-block template instantiates, transitively. */
function reachable(doc: RangoliDocument, id: string, memo: Map<string, Set<string>>): Set<string> {
  const hit = memo.get(id);
  if (hit) return hit;
  const out = new Set<string>([id]);
  memo.set(id, out); // set first: a template that contains itself stops here
  const def = Object.hasOwn(doc.data.components, id) ? doc.data.components[id] : undefined;
  for (const n of Object.values(def?.template?.nodes ?? {})) {
    if (n.component) for (const c of reachable(doc, n.component, memo)) out.add(c);
  }
  return out;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const x of b) if (a.has(x)) return true;
  return false;
}

/**
 * Everything frame markup reads from tokens (render.ts): which token paths exist, in order (`find` resolves
 * short names by path and order), the theme map, and the light-mode letterSpacing/textCase of composite
 * values (text styles). Values that reach the page as CSS variables are left out: changing them only
 * changes the token stylesheet.
 */
export function tokenSignature(tree: TokenTree): string {
  const r = new TokenResolver(tree);
  const parts: string[] = [JSON.stringify(r.themes)];
  for (const path of r.flat.keys()) {
    parts.push(path);
    let v: unknown;
    try { v = r.resolve(path); } catch { parts.push('!cycle'); continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as { letterSpacing?: unknown; textCase?: unknown };
      if (o.letterSpacing !== undefined || o.textCase !== undefined) parts.push(JSON.stringify([o.letterSpacing, o.textCase]));
    }
  }
  return parts.join('\n');
}

function hasFamily(doc: RangoliDocument, id: string): boolean {
  for (const page of Object.values(doc.data.pages)) {
    const n = Object.hasOwn(page.nodes, id) ? page.nodes[id] : undefined;
    if (n) return !!n.style?.font?.family;
  }
  return false;
}

function nodesWithFamily(doc: RangoliDocument): Set<string> {
  const out = new Set<string>();
  for (const page of Object.values(doc.data.pages)) for (const n of Object.values(page.nodes)) if (n.style?.font?.family) out.add(n.id);
  return out;
}

/** Custom property names read with var(--name) in a CSS or markup string. */
export function varsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) out.add(m[1]!);
  return out;
}

/**
 * Variables whose declared value differs between two tokensToCss outputs (any mode block), closed over
 * variables that read them. null when the texts differ in anything other than variable declarations.
 */
export function changedVars(before: string, after: string): string[] | null {
  const parse = (css: string): Map<string, string> | null => {
    const out = new Map<string, string>();
    let bad = false;
    const rest = css.replace(/([^{}]+)\{([^{}]*)\}/g, (_m, sel: string, body: string) => {
      for (const line of body.split(';')) {
        const t = line.trim();
        if (!t) continue;
        const i = t.indexOf(':');
        if (i < 0 || !t.startsWith('--')) { bad = true; continue; }
        out.set(`${sel.trim()}|${t.slice(0, i).trim()}`, t.slice(i + 1).trim());
      }
      return '';
    });
    return rest.trim() || bad ? null : out;
  };
  if (before === after) return [];
  const a = parse(before), b = parse(after);
  if (!a || !b) return null;
  const changed = new Set<string>();
  for (const [k, v] of a) if (b.get(k) !== v) changed.add(k.slice(k.indexOf('|') + 1));
  for (const [k, v] of b) if (a.get(k) !== v) changed.add(k.slice(k.indexOf('|') + 1));
  // a variable whose value reads a changed one changes too
  for (let grew = true; grew; ) {
    grew = false;
    for (const [k, v] of b) {
      const name = k.slice(k.indexOf('|') + 1);
      if (changed.has(name)) continue;
      for (const r of varsIn(v)) if (changed.has(r)) { changed.add(name); grew = true; break; }
    }
  }
  return [...changed];
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
