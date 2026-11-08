/**
 * Reference renderer: model → semantic HTML + CSS (flex/grid). Tokens are emitted as CSS variables,
 * so modes (light/dark) switch with a data attribute and no re-render.
 */
import { expandTemplate, resolveInstance } from './components.js';
import type { RangoliDocument } from './document.js';
import { isTokenRef, type ComponentDef, type Dim, type Layout, type Len, type Paint, type RNode, type Sizing, type Style } from './model.js';
import { cssVarName, TokenResolver, tokensToCss } from './tokens.js';
import { motionCss } from './motion.js';
import { compileIcon, findIcon } from './icons.js';
import type { AssetMeta } from './images.js';
import { ANATOMY, COMPONENT_CSS, SHARED_CSS } from './library.js';
import { sanitizeCss } from './rdl.js';

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
  html: string;
  css: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const JUSTIFY: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around' };
const ALIGN: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' };

export function lenCss(v: Len): string {
  if (isTokenRef(v)) return `var(${cssVarName(v.token)})`;
  return v === 0 ? '0' : `${v}px`;
}

export function paintCss(p: Paint): string {
  if (isTokenRef(p)) return p.alpha !== undefined && p.alpha < 100 ? `color-mix(in srgb, var(${cssVarName(p.token)}) ${p.alpha}%, transparent)` : `var(${cssVarName(p.token)})`;
  if ('hex' in p) return p.hex;
  const g = p.gradient;
  const stops = g.stops.map((s) => `${paintCss(s.color)} ${Math.round(s.at * 100)}%`).join(', ');
  return g.type === 'linear' ? `linear-gradient(${g.angle ?? 180}deg, ${stops})` : `radial-gradient(${stops})`;
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

  node(n: RNode, parentLayout: Layout | undefined, inInline: boolean): string {
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
    const attrs: string[] = [`class="r-${n.id}${cc ? ` rc-${cc}` : ''}"`];
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
        for (const [k, v] of Object.entries(r.variant)) attrs.push(`data-${k}="${esc(v)}"`);
        const raw = n.props?.[comp.labelProp ?? 'label'];
        const label = raw === undefined ? undefined : String(raw);
        const anatomy = comp.anatomy ? ANATOMY[comp.anatomy] : undefined;
        if (anatomy) {
          const res = anatomy(n, r.variant, label, { esc, icon: (ref, px = 16) => this.iconSvg(ref, px) });
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
      const grid = found?.set.grid ?? 24;
      attrs.push(`viewBox="0 0 ${grid} ${grid}"`, 'aria-hidden="true"', 'xmlns="http://www.w3.org/2000/svg"', 'fill="none"', 'stroke="currentColor"');
      if (found) {
        attrs.push(`stroke-width="${found.icon.stroke ?? found.set.stroke}"`, `stroke-linecap="${found.set.cap}"`, `stroke-linejoin="${found.set.join}"`);
        inner = compileIcon(found.icon.src)
          .shapes.map((s) => {
            // per-shape colour tokens (illustrations): c=primary.600
            const tok = s.color ? this.tokens.find(s.color, 'color') : undefined;
            const col = tok ? `var(${cssVarName(tok)})` : s.color?.startsWith('#') ? s.color : 'currentColor';
            return s.fill ? `<path d="${s.d}" fill="${col}" stroke="none"/>` : `<path d="${s.d}"${col !== 'currentColor' ? ` stroke="${col}"` : ''}/>`;
          })
          .join('');
      }
      if (!size?.w) decls.push('width:20px');
      if (!size?.h) decls.push('height:20px');
      decls.push('flex-shrink:0');
    } else if (n.type === 'vector' && n.vector) {
      const v = n.vector;
      tag = 'svg';
      attrs.push(`viewBox="0 0 ${v.vw} ${v.vh}"`, 'aria-hidden="true"', 'xmlns="http://www.w3.org/2000/svg"', 'overflow="visible"');
      // a path without its own paint inherits the layer's fill/stroke; bare pen strokes default to currentColor
      const solid = (p?: Paint) => (!p ? undefined : 'gradient' in p ? paintCss(p.gradient.stops[0]!.color) : paintCss(p));
      const tokenColor = (c?: string) => {
        if (!c) return undefined;
        if (c.startsWith('#')) return c;
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
          return `<path d="${esc(p.d)}" fill="${fill}" stroke="${stroke}"${stroke !== 'none' ? ` stroke-width="${width}" stroke-linecap="${p.cap ?? 'round'}" stroke-linejoin="${p.join ?? 'round'}"${dash}` : ''}/>`;
        })
        .join('');
      if (!size?.w) decls.push(`width:${v.vw}px`);
      if (!size?.h) decls.push(`height:${v.vh}px`);
    } else if (n.type === 'image') {
      const meta = n.image?.asset ? this.doc.data.assets?.[n.image.asset] : undefined;
      if (meta) {
        tag = 'img';
        const src = this.opts.assetUrl ? this.opts.assetUrl(meta) : `${this.opts.assetBase ?? 'assets/'}${meta.file}`;
        attrs.push(`src="${esc(src)}"`, `alt="${esc(n.image?.decorative ? '' : n.image?.alt ?? '')}"`, `width="${meta.w}"`, `height="${meta.h}"`, 'loading="lazy"', 'decoding="async"');
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

    if (decls.length) this.rules.push(`.r-${n.id}{${decls.join(';')}}`);
    if (tag === 'img' || tag === 'input') return `<${tag} ${attrs.join(' ')}>`;
    return `<${tag} ${attrs.join(' ')}>${inner}</${tag}>`;
  }

  /** Inline SVG for an icon reference (used inside component anatomy). */
  iconSvg(ref: string, px: number): string {
    const found = findIcon(this.doc.data.icons, ref);
    if (!found) return '';
    const paths = compileIcon(found.icon.src).shapes.map((s) => (s.fill ? `<path d="${s.d}" fill="currentColor" stroke="none"/>` : `<path d="${s.d}"/>`)).join('');
    return `<svg width="${px}" height="${px}" viewBox="0 0 ${found.set.grid} ${found.set.grid}" fill="none" stroke="currentColor" stroke-width="${found.icon.stroke ?? found.set.stroke}" stroke-linecap="${found.set.cap}" stroke-linejoin="${found.set.join}" aria-hidden="true">${paths}</svg>`;
  }

  layoutDecls(l: Layout, d: string[]) {
    if (l.mode === 'row' || l.mode === 'col') {
      d.push('display:flex', `flex-direction:${l.mode === 'row' ? 'row' : 'column'}`);
      if (l.wrap) d.push('flex-wrap:wrap');
    } else if (l.mode === 'grid') {
      d.push('display:grid');
      if (typeof l.columns === 'number') d.push(`grid-template-columns:repeat(${l.columns},minmax(0,1fr))`);
      else if (l.columns) d.push(`grid-template-columns:${l.columns}`);
      if (l.rows) d.push(`grid-template-rows:${l.rows}`);
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
      const v = this.tokens.resolve(s.textStyle.token) as { letterSpacing?: string | number; textCase?: string } | undefined;
      if (v?.letterSpacing !== undefined) d.push(`letter-spacing:${typeof v.letterSpacing === 'number' ? `${v.letterSpacing}px` : v.letterSpacing}`);
      if (v?.textCase) d.push(`text-transform:${v.textCase}`);
    }
    if (s.font) {
      if (s.font.weight) d.push(`font-weight:${s.font.weight}`);
      if (s.font.size !== undefined) d.push(`font-size:${lenCss(s.font.size)}`);
      if (s.font.lineHeight !== undefined) d.push(`line-height:${typeof s.font.lineHeight === 'number' && s.font.lineHeight > 3 ? `${s.font.lineHeight}px` : s.font.lineHeight}`);
      if (s.font.family) d.push(`font-family:${s.font.family}`);
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
      if (clean) d.push(clean);
    }
  }
}

/** Static (non-motion) CSS for used library components (parts + states). Interaction motion comes from doc.data.motion. */
function componentBaseCss(used: Set<string>): string {
  const out: string[] = [];
  for (const id of used) if (COMPONENT_CSS[id]) out.push(COMPONENT_CSS[id]!);
  if (['Button', 'Status', 'Spinner'].some((c) => used.has(c))) out.push(SHARED_CSS);
  return out.join('\n');
}

// Reduced motion is handled per animation by motionCss (fades kept, movement removed) — no global kill switch.
const BASE_CSS = `*,*::before,*::after{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--color-bg-canvas);color:var(--color-text-primary);font:var(--textStyle-body);-webkit-font-smoothing:antialiased}
button,input{font:inherit;color:inherit}
h1,h2,h3,h4,p{overflow-wrap:break-word}`;

/** Render nodes to an HTML fragment + node CSS (no tokens/base). */
export function renderFragment(doc: RangoliDocument, opts: RenderOptions = {}): RenderResult & { usedComponents: string[] } {
  const r = new Renderer(doc, opts);
  const page = doc.page(opts.page);
  const html = (opts.roots ?? page.children)
    .map((id) => page.nodes[id])
    .filter((n): n is RNode => !!n)
    .map((n) => r.node(n, n.parent ? doc.node(n.parent, page.id).layout : undefined, false))
    .join('\n');
  return { html, css: r.rules.join('\n'), usedComponents: [...r.usedComponents] };
}

/** Full CSS: tokens (all modes) + base + component states + node rules. */
export function renderCss(doc: RangoliDocument, fragmentCss: string, used: string[]): string {
  return [tokensToCss(doc.data.tokens, ['light', 'dark']), BASE_CSS, componentBaseCss(new Set(used)), fragmentCss, motionCss(doc.data.motion, doc.data.tokens, doc.data.timelines)].filter(Boolean).join('\n\n');
}

/** Standalone HTML page — the reference render. */
export function renderDocument(doc: RangoliDocument, opts: RenderOptions & { title?: string; padding?: number } = {}): string {
  const frag = renderFragment(doc, opts);
  const css = renderCss(doc, frag.css, frag.usedComponents);
  const mode = opts.mode && opts.mode !== 'light' ? ` data-mode="${esc(opts.mode)}"` : '';
  return `<!doctype html>
<html lang="en"${mode}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title ?? doc.data.manifest.name)}</title>
<style>
${css}
.rangoli-stage{padding:${opts.padding ?? 24}px;display:flex;flex-wrap:wrap;gap:48px;align-items:flex-start}
</style>
</head>
<body>
<div class="rangoli-stage">
${frag.html}
</div>
</body>
</html>
`;
}
