/**
 * Reference renderer: model → semantic HTML + CSS (flex/grid). Tokens are emitted as CSS variables,
 * so modes (light/dark) switch with a data attribute and no re-render.
 */
import { expandTemplate, resolveInstance } from './components.js';
import type { RangoliDocument } from './document.js';
import { isTokenRef, type ImagePaint, type ComponentDef, type Dim, type Layout, type Len, type Paint, type RNode, type Sizing, type Style } from './model.js';
import { cssVarName as tokenVarName, fontStack, TokenResolver, tokensToCss } from './tokens.js';
import { FONT_FALLBACK, findFont, fontHead } from './fonts.js';
import { scene3dModule } from './scene3d.js';
import { motionCss } from './motion.js';
import { compileIcon as compileIconSource, findIcon, shapeMarkup, type CompiledIcon } from './icons.js';
import type { AssetMeta } from './images.js';
import { ANATOMY, COMPONENT_CSS, SHARED_CSS } from './library.js';
import { isSafeCssValue, isSafeGridTemplate, isSafeNodeId, safeHex, sanitizeCss, SAFE_IMAGE_POS, SAFE_IMAGE_URL } from './safety.js';

export interface RenderOptions {
  page?: string;
  roots?: string[];
  /** which mode the standalone page starts in */
  mode?: string;
  /** add data-rid attributes for editor hit-testing */
  editorAttrs?: boolean;
  /** URL prefix for asset files (default "assets/" — relative, for exported folders) */
  assetBase?: string;
  /** full control over asset URLs (e.g. data URIs for screenshots) */
  assetUrl?: (meta: AssetMeta) => string;
}

export interface RenderResult {
  /** layers' JavaScript as one file ("" when there is none) */
  js?: string;
  html: string;
  css: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** An attribute value that is typed but may come from a stored document. */
const attr = (v: unknown) => esc(String(v));

const JUSTIFY: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around' };
const ALIGN: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' };

export function lenCss(v: Len): string {
  if (isTokenRef(v)) return `var(${cssVarName(v.token)})`;
  return v === 0 ? '0' : `${v}px`;
}

export function paintCss(p: Paint): string {
  // the output reaches <style> and SVG attributes, so nothing from the document is emitted unchecked
  if (isTokenRef(p)) return typeof p.alpha === 'number' && p.alpha < 100 ? `color-mix(in srgb, var(${cssVarName(p.token)}) ${p.alpha}%, transparent)` : `var(${cssVarName(p.token)})`;
  if ('hex' in p) return safeHex(p.hex) ?? 'transparent';
  if ('image' in p) return 'transparent'; // images are painted by the layer background (see imageCss)
  const g = p.gradient;
  const stops = g.stops.map((s) => `${paintCss(s.color)} ${Math.round(s.at * 100)}%`).join(', ');
  return g.type === 'linear' ? `linear-gradient(${Number.isFinite(g.angle) ? g.angle : 180}deg, ${stops})` : `radial-gradient(${stops})`;
}

/** Quote custom family names and add the right generic fallback. */
function familyCss(family: string): string {
  if (family.startsWith('var(')) return family;
  const names = family.split(',').map((f) => f.trim().replace(/^["']|["']$/g, ''));
  const generic = FONT_FALLBACK[findFont(names[0]!)?.category ?? 'sans'];
  return fontStack(names.includes(generic) ? names : [...names, generic]);
}

/** Pure helpers called once per layer or more, remembered (bounded) so per-frame re-renders stay cheap. */
function remember<T>(fn: (key: string) => T, limit = 20_000): (key: string) => T {
  const cache = new Map<string, T>();
  return (key) => {
    let v = cache.get(key);
    if (v === undefined) {
      v = fn(key);
      if (cache.size >= limit) cache.clear();
      cache.set(key, v);
    }
    return v;
  };
}
const cssVarName = remember(tokenVarName);
/** Compiled shapes are only read here, never changed, so one result can serve every use of the same source. */
const compileIcon: (src: string) => CompiledIcon = remember((src) => compileIconSource(src), 2_000);

/** isSafeCssValue, remembered: the same declarations ("display:flex", "gap:var(--space-2)") repeat on every layer. */
const SAFE_DECL_CACHE = new Map<string, boolean>();
function safeDecl(d: string): boolean {
  let ok = SAFE_DECL_CACHE.get(d);
  if (ok === undefined) {
    ok = isSafeCssValue(d);
    if (SAFE_DECL_CACHE.size >= 20_000) SAFE_DECL_CACHE.clear();
    SAFE_DECL_CACHE.set(d, ok);
  }
  return ok;
}

class Renderer {
  readonly rules: string[] = [];
  readonly tokens: TokenResolver;
  readonly usedComponents = new Set<string>();
  constructor(private doc: RangoliDocument, private opts: RenderOptions) {
    this.tokens = new TokenResolver(doc.data.tokens);
  }

  /** expanded template layers (instance id + "_" + template id) while an instance renders */
  private extra: Record<string, RNode> = {};
  /** layer id → id the editor should select (template internals select their instance) */
  private rid: Record<string, string> = {};
  private compClass: Record<string, string> = {};
  private building = new Set<string>();

  private lookup(id: string): RNode | undefined {
    return this.extra[id] ?? this.doc.page(this.opts.page).nodes[id];
  }

  /** A building-block instance: render the component's layers with slot props filled in. */
  private templateInstance(n: RNode, comp: ComponentDef, parentLayout: Layout | undefined, inInline: boolean): string {
    if (this.building.has(comp.id)) return ''; // a component cannot contain itself
    // root = template root + component rules (component @X block) + this instance's own overrides
    const { root, nodes: map } = expandTemplate(n, comp, (tid) => `${n.id}_${tid}`);
    for (const id of Object.keys(map)) if (id !== n.id) this.rid[id] = this.rid[n.id] ?? n.id;
    this.compClass[n.id] = comp.id;
    Object.assign(this.extra, map);
    this.building.add(comp.id);
    try {
      return this.node(root, parentLayout, inInline);
    } finally {
      this.building.delete(comp.id);
      for (const id of Object.keys(map)) delete this.extra[id];
    }
  }

  readonly scripts: { id: string; code: string }[] = [];
  private textStyles = new Map<string, { letterSpacing?: string | number; textCase?: string } | undefined>();
  /** A text style's resolved value, once per render (every text layer asks). */
  private textStyle(path: string): { letterSpacing?: string | number; textCase?: string } | undefined {
    if (!this.textStyles.has(path)) this.textStyles.set(path, this.tokens.resolve(path) as { letterSpacing?: string | number; textCase?: string } | undefined);
    return this.textStyles.get(path);
  }
  /** declarations already made safe where they were built (image URLs, sanitised raw CSS) */
  private vetted = new Set<string>();

  private imageCss(m: ImagePaint): string[] {
    const meta = m.asset ? this.doc.data.assets?.[m.asset] : undefined;
    const url = m.url !== undefined && SAFE_IMAGE_URL.test(m.url) ? m.url : undefined;
    const src = url ?? (meta ? (this.opts.assetUrl ? this.opts.assetUrl(meta) : `${this.opts.assetBase ?? 'assets/'}${meta.file}`) : '');
    if (!src) return ['background:var(--color-bg-subtle)'];
    const tint = m.tint ? `linear-gradient(${paintCss(m.tint)},${paintCss(m.tint)}),` : '';
    const size = m.fit === 'tile' ? 'auto' : m.fit === 'contain' ? 'contain' : 'cover';
    const pos = m.pos !== undefined && SAFE_IMAGE_POS.test(m.pos) ? m.pos : 'center';
    const decl = `background:${tint}url("${src.replace(/["\\]/g, '').replace(/[<>\s]/g, encodeURIComponent)}") ${pos.replace('-', ' ')} / ${size} ${m.fit === 'tile' ? 'repeat' : 'no-repeat'}`;
    this.vetted.add(decl);
    return [decl];
  }

  node(n: RNode, parentLayout: Layout | undefined, inInline: boolean): string {
    if (!isSafeNodeId(n.id)) return ''; // ids become class names and selectors
    if (n.script) this.scripts.push({ id: n.id, code: n.script });
    if (n.type === 'instance' && n.component) {
      const comp = this.doc.data.components[n.component];
      if (comp?.template) return this.templateInstance(n, comp, parentLayout, inInline);
    }
    const decls: string[] = [];
    let layout = n.layout;
    let size = n.size;
    let style: Style = n.style ?? {};
    let tag = 'div';
    const cc = n.component ?? this.compClass[n.id];
    const attrs: string[] = [`class="r-${n.id}${cc ? ` rc-${esc(cc)}` : ''}"`];
    if (this.opts.editorAttrs) attrs.push(`data-rid="${this.rid[n.id] ?? n.id}"`);
    let inner = '';

    if (n.type === 'instance' && n.component) {
      const comp = this.doc.data.components[n.component];
      if (comp) {
        const r = resolveInstance(n, comp);
        layout = r.layout;
        size = r.size;
        style = r.style;
        tag = comp.tag ?? 'div';
        this.usedComponents.add(comp.id);
        for (const [k, v] of Object.entries(r.variant)) if (/^[\w-]+$/.test(k)) attrs.push(`data-${k}="${esc(v)}"`);
        const raw = n.props?.[comp.labelProp ?? 'label'];
        const label = raw === undefined ? undefined : String(raw);
        const anatomy = comp.anatomy ? ANATOMY[comp.anatomy] : undefined;
        if (anatomy) {
          const res = anatomy(n, r.variant, label, {
            esc,
            icon: (ref, px = 16) => this.iconSvg(ref, px),
            assetUrl: (id) => {
              const meta = this.doc.data.assets?.[id];
              return !meta ? undefined : this.opts.assetUrl ? this.opts.assetUrl(meta) : `${this.opts.assetBase ?? 'assets/'}${meta.file}`;
            },
            iconPaths: (ref) => {
              const found = findIcon(this.doc.data.icons, ref);
              if (!found) return undefined;
              return { grid: found.set.grid, stroke: found.icon.stroke ?? found.set.stroke, paths: compileIcon(found.icon.src).shapes.map((s) => ({ d: s.d, fill: s.fill, ...(s.w !== undefined ? { w: s.w } : {}) })) };
            },
            color: (c) => { if (safeHex(c) || c === 'transparent') return c; const tok = this.tokens.find(c, 'color'); return tok ? `var(${cssVarName(tok)})` : /^[a-z-]+$/i.test(c) ? c : 'currentColor'; },
          });
          if (res.tag) tag = res.tag;
          inner = res.inner;
          attrs.push(...(res.attrs ?? []));
        } else if (tag === 'textarea') {
          attrs.push(`placeholder="${esc(label ?? '')}"`);
          if (r.variant.state === 'disabled') attrs.push('disabled');
          inner = esc(String(n.props?.value ?? ''));
        } else if (label !== undefined) inner = esc(label);
        if (tag === 'button' && !attrs.some((a) => a.startsWith('type='))) attrs.push('type="button"');
        if (tag === 'a') attrs.push('href="#"');
      }
    }

    if (n.role) attrs.push(`data-role="${esc(n.role)}"`);
    if (n.hidden) decls.push('display:none');

    // layout of this node (as a container)
    if (layout && n.type !== 'text') this.layoutDecls(layout, decls);
    // sizing relative to parent
    this.sizeDecls(size, parentLayout, decls, n.type === 'text');
    if ((parentLayout?.mode === 'none' || n.absolute) && n.position) decls.push('position:absolute', `left:${n.position.x}px`, `top:${n.position.y}px`);
    // containers with absolutely placed children become the positioning context
    if (layout?.mode !== 'none' && n.children?.some((c) => this.lookup(c)?.absolute)) decls.push('position:relative');
    // vectors paint their paths themselves (fill/stroke go to the SVG, not the box)
    const vectorPaths = n.type === 'vector' && !!n.vector && !n.icon;
    this.styleDecls(vectorPaths ? { ...style, fill: undefined, stroke: undefined } : style, decls, !!n.absolute);

    if (n.type === 'text') {
      const ts = style.textStyle?.token.replace(/^textStyle\./, '') ?? '';
      tag = inInline ? 'span' : ({ display: 'h1', headline: 'h2', title: 'h3', 'title-sm': 'h4' } as Record<string, string>)[ts] ?? 'p';
      inner = esc(n.text ?? '');
      decls.push('white-space:pre-wrap');
      if (inInline) decls.push('display:block');
    } else if (n.type === 'vector' && n.icon) {
      const found = findIcon(this.doc.data.icons, n.icon);
      tag = 'svg';
      const grid = attr(found?.set.grid ?? 24);
      attrs.push(`viewBox="0 0 ${grid} ${grid}"`, 'aria-hidden="true"', 'xmlns="http://www.w3.org/2000/svg"', 'fill="none"', 'stroke="currentColor"');
      if (found) {
        attrs.push(`stroke-width="${attr(found.icon.stroke ?? found.set.stroke)}"`, `stroke-linecap="${attr(found.set.cap)}"`, `stroke-linejoin="${attr(found.set.join)}"`);
        inner = compileIcon(found.icon.src)
          .shapes.map((s) => {
            // per-shape colour tokens (illustrations): c=primary.600
            return shapeMarkup(s, (c) => { const t = this.tokens.find(c, 'color'); return t ? `var(${cssVarName(t)})` : safeHex(c) ?? 'currentColor'; });
          })
          .join('');
      }
      if (!size?.w) decls.push('width:20px');
      if (!size?.h) decls.push('height:20px');
      decls.push('flex-shrink:0');
    } else if (n.type === 'vector' && n.vector) {
      const v = n.vector;
      tag = 'svg';
      attrs.push(`viewBox="0 0 ${attr(v.vw)} ${attr(v.vh)}"`, 'aria-hidden="true"', 'xmlns="http://www.w3.org/2000/svg"', 'overflow="visible"');
      // a path without its own paint inherits the layer's fill/stroke; bare pen strokes default to currentColor
      const solid = (p?: Paint) => (!p ? undefined : 'gradient' in p ? paintCss(p.gradient.stops[0]!.color) : paintCss(p));
      const tokenColor = (c?: string) => {
        if (!c) return undefined;
        if (c.startsWith('#')) return safeHex(c);
        const t = this.tokens.find(c, 'color');
        return t ? `var(${cssVarName(t)})` : undefined;
      };
      const layerFill = solid(style.fill?.[0]);
      const layerStroke = style.stroke ? solid(style.stroke.paint) : undefined;
      const layerWidth = style.stroke?.width ?? 2;
      inner = v.paths
        .map((p) => {
          const own = tokenColor(p.color);
          const fill = p.fill !== undefined ? (p.fill === 'none' ? 'none' : paintCss(p.fill)) : p.filled ? own ?? 'currentColor' : layerFill ?? 'none';
          let stroke = p.stroke ? paintCss(p.stroke) : p.filled ? 'none' : own ?? layerStroke ?? (layerFill ? 'none' : 'currentColor');
          if (p.filled && layerStroke && !own) stroke = layerStroke; // coloured fills keep their own edge
          const width = p.strokeWidth ?? layerWidth;
          const dash = style.stroke?.style === 'dashed' ? ` stroke-dasharray="${width * 3} ${width * 2}"` : style.stroke?.style === 'dotted' ? ` stroke-dasharray="0 ${width * 2}"` : '';
          return `<path d="${esc(p.d)}" fill="${fill}" stroke="${stroke}"${stroke !== 'none' ? ` stroke-width="${attr(width)}" stroke-linecap="${attr(p.cap ?? 'round')}" stroke-linejoin="${attr(p.join ?? 'round')}"${dash}` : ''}/>`;
        })
        .join('');
      if (!size?.w) decls.push(`width:${v.vw}px`);
      if (!size?.h) decls.push(`height:${v.vh}px`);
    } else if (n.type === 'image') {
      const meta = n.image?.asset ? this.doc.data.assets?.[n.image.asset] : undefined;
      if (meta) {
        tag = 'img';
        const src = this.opts.assetUrl ? this.opts.assetUrl(meta) : `${this.opts.assetBase ?? 'assets/'}${meta.file}`;
        attrs.push(`src="${esc(src)}"`, `alt="${esc(n.image?.decorative ? '' : n.image?.alt ?? '')}"`, `width="${attr(meta.w)}"`, `height="${attr(meta.h)}"`, 'loading="lazy"', 'decoding="async"');
        decls.push(`object-fit:${n.image?.fit ?? 'cover'}`, 'display:block');
        if (!size?.w) decls.push(`width:${meta.w}px`);
        if (!size?.h) decls.push('height:auto');
      } else {
        // image slot without a file yet — a neutral placeholder, never a broken <img>
        attrs.push('role="img"', `aria-label="${esc(n.image?.alt ?? 'Image placeholder')}"`);
        decls.push(`background:var(${cssVarName('color.bg.subtle')})`, `box-shadow:inset 0 0 0 1px var(${cssVarName('color.border.default')})`);
        if (!size?.w) decls.push('width:160px');
        if (!size?.h) decls.push('height:120px');
      }
    }

    const childInline = inInline || tag === 'button' || tag === 'span' || tag === 'a';
    let kids = '';
    for (const cid of n.children ?? []) {
      const c = this.lookup(cid);
      if (c) kids += this.node(c, n.type === 'text' ? undefined : layout, childInline);
    }
    // component children (e.g. an icon inside a button) lead the label
    inner = n.type === 'instance' ? kids + inner : inner + kids;

    // last check for every field: a value from a stored document cannot leave its declaration
    const safeDecls = decls.filter((d) => this.vetted.has(d) || safeDecl(d));
    if (safeDecls.length) this.rules.push(`.r-${n.id}{${safeDecls.join(';')}}`);
    if (tag === 'img' || tag === 'input') return `<${tag} ${attrs.join(' ')}>`;
    return `<${tag} ${attrs.join(' ')}>${inner}</${tag}>`;
  }

  /** Inline SVG for an icon reference (used inside component anatomy). */
  iconSvg(ref: string, px: number): string {
    const found = findIcon(this.doc.data.icons, ref);
    if (!found) return '';
    const paths = compileIcon(found.icon.src).shapes.map((s) => shapeMarkup(s, (c) => { const t = this.tokens.find(c, 'color'); return t ? `var(${cssVarName(t)})` : safeHex(c) ?? 'currentColor'; })).join('');
    return `<svg width="${px}" height="${px}" viewBox="0 0 ${attr(found.set.grid)} ${attr(found.set.grid)}" fill="none" stroke="currentColor" stroke-width="${attr(found.icon.stroke ?? found.set.stroke)}" stroke-linecap="${attr(found.set.cap)}" stroke-linejoin="${attr(found.set.join)}" aria-hidden="true">${paths}</svg>`;
  }

  layoutDecls(l: Layout, d: string[]) {
    if (l.mode === 'row' || l.mode === 'col') {
      d.push('display:flex', `flex-direction:${l.mode === 'row' ? 'row' : 'column'}`);
      if (l.wrap) d.push('flex-wrap:wrap');
    } else if (l.mode === 'grid') {
      d.push('display:grid');
      if (typeof l.columns === 'number') d.push(`grid-template-columns:repeat(${l.columns},minmax(0,1fr))`);
      else if (isSafeGridTemplate(l.columns)) d.push(`grid-template-columns:${l.columns}`);
      if (isSafeGridTemplate(l.rows)) d.push(`grid-template-rows:${l.rows}`);
    } else d.push('position:relative');
    if (l.gap !== undefined) d.push(`gap:${lenCss(l.gap)}`);
    if (l.padding) {
      const p = l.padding.map(lenCss);
      d.push(`padding:${p[0] === p[2] && p[1] === p[3] ? (p[0] === p[1] ? p[0] : `${p[0]} ${p[1]}`) : p.join(' ')}`);
    }
    if (l.justify && l.mode !== 'none') d.push(`justify-content:${JUSTIFY[l.justify]}`);
    if (l.align && l.mode !== 'none') d.push(`align-items:${ALIGN[l.align]}`);
  }

  sizeDecls(s: Sizing | undefined, parent: Layout | undefined, d: string[], isText: boolean) {
    const axis = (dim: Dim | undefined, prop: 'width' | 'height') => {
      if (!dim) return;
      if (dim.kind === 'fixed') {
        d.push(`${prop}:${lenCss(dim.v)}`);
        const main = parent?.mode === 'row' ? 'width' : parent?.mode === 'col' ? 'height' : undefined;
        if (main === prop) d.push('flex-shrink:0'); // only the main axis can shrink
        return;
      }
      if (dim.kind === 'hug') {
        if (prop === 'width' && (!parent || parent.mode === 'col' || parent.mode === 'none')) d.push('width:fit-content');
        return;
      }
      // fill
      const main = parent?.mode === 'row' ? 'width' : parent?.mode === 'col' ? 'height' : undefined;
      if (main === prop) d.push('flex:1 1 0px', prop === 'width' ? 'min-width:0' : 'min-height:0');
      else if (parent && (parent.mode === 'row' || parent.mode === 'col')) d.push('align-self:stretch');
      else d.push(`${prop}:100%`);
    };
    axis(s?.w, 'width');
    axis(s?.h, 'height');
    if (s?.minW !== undefined) d.push(`min-width:${lenCss(s.minW)}`);
    if (s?.maxW !== undefined) d.push(`max-width:${lenCss(s.maxW)}`);
    if (s?.minH !== undefined) d.push(`min-height:${lenCss(s.minH)}`);
    if (s?.maxH !== undefined) d.push(`max-height:${lenCss(s.maxH)}`);
    if (isText && !s?.w && parent?.mode === 'row') d.push('min-width:0');
  }

  styleDecls(s: Style, d: string[], isAbsolute = false) {
    if (s.fill) {
      if (!s.fill.length) d.push('background:transparent');
      else if ('image' in s.fill[0]!) d.push(...this.imageCss(s.fill[0]!.image));
      else if (s.fill.length === 1) {
        const p = s.fill[0]!;
        d.push(`background:${paintCss(p)}`);
      } else {
        // layered: first paint is on top (Figma order is bottom→top; we store top-first)
        d.push(`background:${s.fill.map((p) => (isTokenRef(p) || 'hex' in p ? `linear-gradient(${paintCss(p)},${paintCss(p)})` : paintCss(p))).join(',')}`);
      }
    }
    const shadows: string[] = [];
    if (s.stroke) {
      const w = s.stroke.width ?? 1;
      const p = s.stroke.paint;
      const c = 'gradient' in p ? paintCss(p.gradient.stops[0]!.color) : paintCss(p);
      const lineStyle = s.stroke.style ?? 'solid';
      if (s.stroke.sides || lineStyle !== 'solid') {
        // real borders for dashed/dotted or single sides (box-sizing keeps size stable)
        const sides = s.stroke.sides ?? 'trbl';
        const name: Record<string, string> = { t: 'top', r: 'right', b: 'bottom', l: 'left' };
        for (const k of sides) d.push(`border-${name[k]}:${w}px ${lineStyle} ${c}`);
      } else if (s.stroke.align === 'outside') d.push(`outline:${w}px solid ${c}`);
      else if (s.stroke.align === 'center') d.push(`outline:${w}px solid ${c}`, `outline-offset:-${w / 2}px`);
      else shadows.push(`inset 0 0 0 ${w}px ${c}`);
    }
    if (s.shadow) {
      if (isTokenRef(s.shadow)) shadows.push(`var(${cssVarName(s.shadow.token)})`);
      else for (const sh of s.shadow) shadows.push(`${sh.inset ? 'inset ' : ''}${sh.x}px ${sh.y}px ${sh.blur}px ${sh.spread ?? 0}px ${paintCss(sh.color)}`);
    }
    if (shadows.length) d.push(`box-shadow:${shadows.join(',')}`);
    if (s.radius !== undefined) d.push(`border-radius:${Array.isArray(s.radius) ? s.radius.map(lenCss).join(' ') : lenCss(s.radius)}`);
    if (s.opacity !== undefined) d.push(`opacity:${s.opacity}`);
    if (s.blur) d.push(`filter:blur(${s.blur}px)`);
    if (s.blend) d.push(`mix-blend-mode:${s.blend}`);
    if (s.clip) d.push('overflow:hidden');
    if (s.textStyle) {
      d.push(`font:var(${cssVarName(s.textStyle.token)})`);
      const v = this.textStyle(s.textStyle.token);
      if (v?.letterSpacing !== undefined) d.push(`letter-spacing:${typeof v.letterSpacing === 'number' ? `${v.letterSpacing}px` : v.letterSpacing}`);
      if (v?.textCase) d.push(`text-transform:${v.textCase}`);
    }
    if (s.font) {
      if (s.font.weight) d.push(`font-weight:${s.font.weight}`);
      if (s.font.size !== undefined) d.push(`font-size:${lenCss(s.font.size)}`);
      if (s.font.lineHeight !== undefined) d.push(`line-height:${typeof s.font.lineHeight === 'number' && s.font.lineHeight > 3 ? `${s.font.lineHeight}px` : s.font.lineHeight}`);
      if (s.font.family) d.push(`font-family:${familyCss(s.font.family)}`);
      if (s.font.letterSpacing !== undefined) d.push(`letter-spacing:${s.font.letterSpacing}`);
    }
    if (s.color) d.push(`color:${paintCss(s.color)}`);
    if (s.textAlign) d.push(`text-align:${s.textAlign}`);
    if (s.mono) d.push(`font-family:var(${cssVarName('font.family.mono')})`, 'font-variant-numeric:tabular-nums');
    if (s.truncate) d.push('white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis');
    if (s.italic) d.push('font-style:italic');
    if (s.decoration) d.push(`text-decoration:${s.decoration}`);
    if (s.textTransform) d.push(`text-transform:${s.textTransform}`);
    if (s.rotate) d.push(`rotate:${s.rotate}deg`);
    if (s.z !== undefined) d.push(`z-index:${s.z}`, ...(isAbsolute ? [] : ['position:relative']));
    if (s.overflow) d.push(`overflow:${s.overflow}`);
    if (s.cursor) d.push(`cursor:${s.cursor}`);
    if (s.backdropBlur) d.push(`backdrop-filter:blur(${s.backdropBlur}px)`, `-webkit-backdrop-filter:blur(${s.backdropBlur}px)`);
    if (s.aspect) d.push(`aspect-ratio:${s.aspect}`);
    if (s.css) {
      const clean = sanitizeCss(s.css); // re-check at render: data may come from anywhere
      if (clean) { this.vetted.add(clean); d.push(clean); }
    }
  }
}

/** Static (non-motion) CSS for used library components (parts + states). Interaction motion comes from doc.data.motion. */
function componentBaseCss(used: Set<string>): string {
  const out: string[] = [];
  for (const id of used) if (COMPONENT_CSS[id]) out.push(COMPONENT_CSS[id]!);
  if (['Button', 'Status', 'Spinner', 'Chart', 'WalletButton', 'TxStatus'].some((c) => used.has(c))) out.push(SHARED_CSS);
  return out.join('\n');
}

// Reduced motion is handled per animation by motionCss (fades kept, movement removed) — no global kill switch.
const BASE_CSS = `*,*::before,*::after{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--color-bg-canvas);color:var(--color-text-primary);font:var(--textStyle-body);-webkit-font-smoothing:antialiased}
button,input{font:inherit;color:inherit}
h1,h2,h3,h4,p{overflow-wrap:break-word}`;

/** Render nodes to an HTML fragment + node CSS (no tokens/base). */
/** Layer scripts as one file: each runs with `el` bound to its layer, and one failing cannot stop the rest. */
function bundleScripts(list: { id: string; code: string }[]): string {
  return list.map((s) => `// layer #${s.id}\n(function (el) {\n  try {\n${s.code.split('\n').map((l) => `    ${l}`).join('\n')}\n  } catch (e) { console.error('layer #${s.id}', e); }\n})(document.querySelector('.r-${s.id}'));`).join('\n\n');
}

export function renderFragment(doc: RangoliDocument, opts: RenderOptions = {}): RenderResult & { usedComponents: string[] } {
  const r = new Renderer(doc, opts);
  const page = doc.page(opts.page);
  const html = (opts.roots ?? page.children)
    .map((id) => page.nodes[id])
    .filter((n): n is RNode => !!n)
    .map((n) => r.node(n, n.parent ? doc.node(n.parent, page.id).layout : undefined, false))
    .join('\n');
  return { html, css: r.rules.join('\n'), usedComponents: [...r.usedComponents], js: bundleScripts(r.scripts) };
}

/** Full CSS: tokens (all modes) + base + component states + node rules. */
export function renderCss(doc: RangoliDocument, fragmentCss: string, used: string[]): string {
  const css = [fontHead(doc).css, tokensToCss(doc.data.tokens), BASE_CSS, componentBaseCss(new Set(used)), fragmentCss, motionCss(doc.data.motion, doc.data.tokens, doc.data.timelines)].filter(Boolean).join('\n\n');
  return escapeStyleText(css);
}

/** Whatever slipped through, it cannot end the <style> element. Safe to apply per part: the pattern never spans a "\n\n" join. */
export function escapeStyleText(css: string): string {
  return css.replace(/<(?=\/style|!--)/gi, '\\3c ');
}

/**
 * The pieces renderCss joins, for renderers that keep node rules per frame (eng/frames.ts):
 * renderCss(doc, f, used) === escapeStyleText([fontHead(doc).css, tokensToCss(tokens), RENDER_BASE_CSS,
 * renderComponentCss(used), f, motionCss(...)].filter(Boolean).join('\n\n')).
 */
export const RENDER_BASE_CSS = BASE_CSS;
export function renderComponentCss(used: Iterable<string>): string {
  return componentBaseCss(new Set(used));
}

/** Standalone HTML page — the reference render. */
/** scripts: include layers' JavaScript. Off by default so previews and shared review links never run it. */
export function renderDocument(doc: RangoliDocument, opts: RenderOptions & { title?: string; padding?: number; scripts?: boolean } = {}): string {
  const frag = renderFragment(doc, opts);
  const css = renderCss(doc, frag.css, frag.usedComponents);
  const mode = opts.mode && opts.mode !== 'light' ? ` data-mode="${esc(opts.mode)}"` : '';
  return `<!doctype html>
<html lang="en"${mode}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title ?? doc.data.manifest.name)}</title>
${fontHead(doc).links.map((l) => `<link rel="stylesheet" href="${esc(l)}">`).join('\n')}
<style>
${css}
.rangoli-stage{padding:${opts.padding ?? 24}px;display:flex;flex-wrap:wrap;gap:48px;align-items:flex-start}
</style>
</head>
<body>
<div class="rangoli-stage">
${frag.html}
</div>
${frag.html.includes('rk-3d') ? `<script type="module">${scene3dModule().replace(/<\/script/gi, '<\\/script')}</script>` : ''}
${opts.scripts && frag.js ? `<script>\n${frag.js.replace(/<\/script/gi, '<\\/script')}\n</script>` : ''}
</body>
</html>
`;
}
