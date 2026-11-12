/**
 * Low fidelity: a kit of placeholder blocks, starting layouts per device, display skins that strip
 * a design back to structure, and an annotated spec. Everything is ordinary RDL and CSS, so a
 * wireframe grows into the visual design instead of being thrown away.
 */
import type { Op, RangoliDocument } from './document.js';
import type { RNode } from './model.js';
import type { PatternSpec } from './patterns.js';
import { renderCss, renderFragment, type RenderOptions } from './render.js';
import type { ReviewData } from './review.js';

const q = (s: string) => JSON.stringify(s.replace(/\s+/g, ' ').trim());
const X_BOX = 'css:"background-image:linear-gradient(to top right,transparent calc(50% - .5px),rgba(127,127,127,.45),transparent calc(50% + .5px)),linear-gradient(to bottom right,transparent calc(50% - .5px),rgba(127,127,127,.45),transparent calc(50% + .5px))"';
const size = (v: string, axis: 'w' | 'h') => (/^\d+$/.test(v) ? `${axis}${v}` : v);
const bar = (name: string, h: number, extra = 'wfill') => `${name} ${extra} h${h} fill:border r1`;
const lines = (n: number) => Array.from({ length: n }, (_, i) => bar('Line', 8, i === n - 1 && n > 1 ? 'wfill maxw240' : 'wfill'));
const indent = (s: string[], pad = '  ') => s.map((l) => pad + l);
const placeholder = (name: string, w: string, h: string, label: string) =>
  [`${name} col middle ${size(w, 'w')} ${size(h, 'h')} fill:subtle stroke:border r1 ${X_BOX}`, `  Text caption muted ${q(label)}`].join('\n');

const P = (description: string, params: Record<string, string>, rdl: PatternSpec['rdl']): PatternSpec => ({ category: 'Wireframe', description, params, rdl });

export const WIREFRAME_PATTERNS: Record<string, PatternSpec> = {
  'wf-image': P('Crossed box standing in for an image', { w: 'wfill', h: '200', label: 'Image' }, (p) => placeholder('Placeholder', p.w!, p.h!, p.label!)),
  'wf-video': P('Crossed box standing in for a video', { w: 'wfill', h: '240', label: '▶ Video' }, (p) => placeholder('Video', p.w!, p.h!, p.label!)),
  'wf-map': P('Crossed box standing in for a map', { w: 'wfill', h: '240', label: 'Map' }, (p) => placeholder('Map', p.w!, p.h!, p.label!)),
  'wf-ad': P('Reserved promotional slot', { w: 'wfill', h: '96', label: 'Promotion' }, (p) => placeholder('Promo', p.w!, p.h!, p.label!)),
  'wf-heading': P('Bar standing in for a heading', {}, () => bar('Heading', 16, 'wfill maxw320')),
  'wf-text': P('Greeked lines standing in for body copy', { lines: '3' }, (p) => ['TextBlock col gap2 wfill', ...indent(lines(Math.max(1, Number(p.lines) || 3)))].join('\n')),
  'wf-button': P('Outlined button', { label: 'Action' }, (p) => ['Btn col middle px4 h36 stroke:text.secondary r1', `  Text label ${q(p.label!)}`].join('\n')),
  'wf-input': P('Labelled empty field', { label: 'Label' }, (p) => ['Field col gap1 wfill', `  Text label ${q(p.label!)}`, '  Box wfill h36 stroke:border r1'].join('\n')),
  'wf-avatar': P('Round avatar', { size: '40' }, (p) => `Avatar w${p.size} h${p.size} rfull fill:border`),
  'wf-card': P('Image, heading and copy in a card', {}, () => ['Card col gap3 p4 stroke:border r2 wfill', ...indent(placeholder('Placeholder', 'wfill', '120', 'Image').split('\n')), `  ${bar('Heading', 12, 'wfill maxw200')}`, ...indent(['TextBlock col gap2 wfill', ...indent(lines(2))])].join('\n')),
  'wf-list': P('Repeating rows with an avatar and two lines', { rows: '5' }, (p) =>
    ['List col gap4 wfill', ...Array.from({ length: Math.min(20, Number(p.rows) || 5) }, () => ['  Row row gap3 center wfill', '    Avatar w32 h32 rfull fill:border', '    Copy col gap2 wfill', `      ${bar('Line', 8, 'wfill maxw280')}`, `      ${bar('Line', 8, 'wfill maxw180')}`].join('\n'))].join('\n')),
  'wf-chart': P('Bars standing in for a chart', { h: '240' }, (p) =>
    [`Chart col p4 wfill h${p.h} fill:subtle stroke:border r1`, '  Bars row gap3 end wfill hfill', ...[60, 120, 90, 150, 40, 110].map((h) => `    Bar wfill h${h} fill:border`)].join('\n')),
  'wf-tabs': P('A row of tab labels', { tabs: 'First|Second|Third' }, (p) => ['Tabs row gap4 wfill', ...p.tabs!.split('|').map((t) => `  Text label ${q(t)}`)].join('\n')),
  'wf-nav': P('Top navigation with logo, links and an action', { links: 'Product|Pricing|Docs', cta: 'Start' }, (p) =>
    ['Nav row between center wfill px6 py3 stroke:border', '  Logo w96 h24 fill:border r1', '  Links row gap6 center', ...p.links!.split('|').map((l) => `    Text body-sm ${q(l)}`), '  Btn col middle px4 h36 stroke:text.secondary r1', `    Text label ${q(p.cta!)}`].join('\n')),
  'wf-sidebar': P('Side navigation', { items: '6' }, (p) =>
    ['Sidebar col gap4 w220 hfill p4 fill:subtle', '  Logo w96 h24 fill:border r1', ...Array.from({ length: Math.min(12, Number(p.items) || 6) }, () => `  ${bar('Item', 10)}`)].join('\n')),
  'wf-tabbar': P('Mobile bottom navigation', { items: '4' }, (p) =>
    ['TabBar row around center wfill py3 stroke:border', ...Array.from({ length: Math.min(5, Number(p.items) || 4) }, () => '  Tab w24 h24 r1 fill:border')].join('\n')),
  'wf-browser': P('Browser window bar', { url: 'example.com' }, (p) =>
    ['Browser row gap2 center wfill px3 py2 fill:subtle', '  Dot w10 h10 rfull fill:border', '  Dot w10 h10 rfull fill:border', '  Dot w10 h10 rfull fill:border', '  Address col wfill px3 py1 stroke:border r1', `    Text caption muted ${q(p.url!)}`].join('\n')),
  'wf-phone-bar': P('Mobile status bar', {}, () => ['Status row between center wfill px4 py2', '  Text caption "9:41"', '  Signal w40 h10 fill:border r1'].join('\n')),
};

// ---------------------------------------------------------------- starting layouts

export const WF_DEVICES = {
  desktop: { name: 'Desktop', w: 1440, h: 900 },
  tablet: { name: 'Tablet', w: 834, h: 1112 },
  mobile: { name: 'Mobile', w: 390, h: 844 },
} as const;
export type WfDevice = keyof typeof WF_DEVICES;

/**
 * The devices a screen can have frames for. One screen, several linked frames: Desktop, Tablet, iPad, Mobile,
 * and any custom width and height. The ids match ScreenDevice in lifecycle.ts and the screen_frames table.
 */
export const SCREEN_DEVICES = {
  desktop: { name: 'Desktop', w: 1440, h: 900 },
  tablet: { name: 'Tablet', w: 834, h: 1112 },
  ipad: { name: 'iPad', w: 1024, h: 1366 },
  mobile: { name: 'Mobile', w: 390, h: 844 },
} as const;
export type ScreenDevicePreset = keyof typeof SCREEN_DEVICES;
export const SCREEN_DEVICE_IDS = [...(Object.keys(SCREEN_DEVICES) as ScreenDevicePreset[]), 'custom'] as const;
/** Largest frame a custom size may ask for, in either direction. */
export const MAX_FRAME_SIZE = 20000;

/** Which device class a frame of this width belongs to. Mirrors device_class() in migration 009. */
export function deviceForWidth(w: number | null | undefined): ScreenDevicePreset {
  if (w == null || !Number.isFinite(w)) return 'desktop';
  return w < 600 ? 'mobile' : w < 900 ? 'tablet' : w < 1200 ? 'ipad' : 'desktop';
}

export const deviceName = (device: string): string => (device === 'custom' ? 'Custom' : (SCREEN_DEVICES as Record<string, { name: string }>)[device]?.name ?? device);

type Body = (wide: boolean) => string[];
interface Template {
  name: string;
  /** which screen names and purposes suggest this layout */
  match: RegExp;
  /** full-bleed screens have no app navigation around them */
  bare?: boolean;
  body: Body;
}

const twoCol = (wide: boolean, a: string[], b: string[]) => (wide ? ['Columns row gap6 wfill', '  Main col gap4 wfill', ...indent(a, '    '), '  Side col gap4 w320', ...indent(b, '    ')] : [...a, ...b]);
const cards = (wide: boolean, n: number) => (wide ? ['Cards row gap4 wfill', ...Array.from({ length: n }, () => '  +wf-card')] : ['Cards col gap4 wfill', '  +wf-card']);
const toolbar = (label: string) => ['Toolbar row gap3 center wfill', '  +wf-input label="Search"', `  +wf-button label=${q(label)}`];

export const WF_TEMPLATES: Record<string, Template> = {
  search: { name: 'Search', match: /search|find|explore|discover/i, body: () => ['+wf-input label="Search"', '+wf-tabs tabs="All|Recent|Saved"', '+wf-list rows=6'] },
  dashboard: { name: 'Dashboard', match: /dashboard|overview|home|summary|analytics|report/i, body: (w) => [...cards(w, 3), '+wf-chart', '+wf-list rows=3'] },
  list: { name: 'List or table', match: /list|table|browse|cases|items|results|runs|history|inventory|catalog|orders/i, body: () => [...toolbar('New'), '+wf-list rows=7'] },
  detail: { name: 'Detail', match: /detail|view|item|page for|product|article|run\b/i, body: (w) => twoCol(w, ['+wf-image h=280', '+wf-text lines=5'], ['+wf-button label="Primary action"', '+wf-text lines=3']) },
  form: { name: 'Form', match: /form|create|new|add|edit|compose|launch|submit|request/i, body: () => ['+wf-input label="First field"', '+wf-input label="Second field"', '+wf-input label="Third field"', 'Actions row gap3', '  +wf-button label="Save"', '  +wf-button label="Cancel"'] },
  settings: { name: 'Settings', match: /setting|preference|account|configur|admin/i, body: () => ['+wf-tabs tabs="General|Team|Billing"', '+wf-input label="Name"', '+wf-input label="Email"', '+wf-list rows=3', '+wf-button label="Save changes"'] },
  checkout: { name: 'Checkout', match: /checkout|payment|pay\b|billing|cart|basket/i, body: (w) => twoCol(w, ['+wf-input label="Name on card"', '+wf-input label="Card number"', '+wf-input label="Address"'], ['+wf-text lines=4', '+wf-button label="Pay now"']) },
  profile: { name: 'Profile', match: /profile|user|member|team/i, body: (w) => ['Header row gap4 center wfill', '  +wf-avatar size=72', '  +wf-text lines=2', ...cards(w, 3)] },
  login: { name: 'Sign in', match: /log.?in|sign.?(in|up)|auth|register|password|welcome/i, bare: true, body: () => ['Panel col gap4 w320', '  +wf-heading', '  +wf-input label="Email"', '  +wf-input label="Password"', '  +wf-button label="Continue"'] },
  landing: { name: 'Landing page', match: /landing|marketing|pricing|about/i, bare: true, body: (w) => [...(w ? ['+wf-nav'] : []), 'Hero col gap4 p6 wfill', '  +wf-heading', '  +wf-text lines=2', '  +wf-button label="Get started"', 'Features col gap4 p6 wfill', ...indent(cards(w, 3))] },
};

export const WF_TEMPLATE_IDS = ['blank', ...Object.keys(WF_TEMPLATES)];

/** A starting point, not a decision: matches words in the screen's name first, then its purpose. */
export function suggestTemplate(name: string, purpose = ''): string {
  const found = (text: string) => Object.entries(WF_TEMPLATES).find(([, t]) => t.match.test(text))?.[0];
  return found(name) ?? found(purpose) ?? 'blank';
}

const rdlText = (s: string) => `"${s.replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** RDL for one screen. The first node created is the frame. A device is a preset id or an exact size. */
export function wireframeScript(name: string, purpose: string, template = 'blank', device: WfDevice | ScreenDevicePreset | { w: number; h: number } = 'desktop'): string {
  const d = typeof device === 'string' ? SCREEN_DEVICES[device] : device;
  const wide = d.w >= 600;
  const frame = (layout: string) => `Frame name:${rdlText(name)} ${layout} w${d.w} h${d.h} fill:surface stroke:border clip`;
  const t = WF_TEMPLATES[template];
  if (!t) return [frame('col gap4 p6'), `  Text title ${rdlText(name)}`, `  Text body-sm muted ${rdlText(purpose || 'What this screen is for')}`].join('\n');
  const head = [`Text title ${rdlText(name)}`, `Text body-sm muted ${rdlText(purpose || 'What this screen is for')}`];
  if (t.bare) return [frame(t.body === WF_TEMPLATES.login!.body ? 'col middle' : 'col'), ...indent(t.body(wide))].join('\n');
  const main = (cls: string) => [`Content col gap4 ${cls} wfill hfill clip`, ...indent([...head, ...t.body(wide)])];
  return wide
    ? [frame('row'), '  +wf-sidebar', ...indent(main('p6'))].join('\n')
    : [frame('col'), '  +wf-phone-bar', ...indent(main('p4')), '  +wf-tabbar'].join('\n');
}

// ---------------------------------------------------------------- device frames

/**
 * "Duplicate to device": the operations that copy a top-level frame, with all its layers, as a new frame of
 * another size placed beside it. Fresh ids throughout; the caller applies the ops and links the new frame
 * to the same screen. Prototype links and motion stay on the original (shared content is R2).
 */
export function duplicateFrameOps(doc: RangoliDocument, frameId: string, size: { w: number; h: number; label: string }): { ops: Op[]; frame: string } {
  const found = doc.findNode(frameId);
  if (!found || found.node.parent) throw new Error('Only a top-level frame can be duplicated to another device.');
  const { page, node: root } = found;
  const ids = new Map<string, string>();
  const ops: Op[] = [];
  const copy = (id: string, parent: string | undefined, index: number | undefined) => {
    const src = page.nodes[id];
    if (!src) return;
    const fresh = doc.ids.make();
    ids.set(id, fresh);
    const { children, parent: _p, id: _i, ...rest } = structuredClone(src);
    const node: RNode = { ...rest, id: fresh };
    if (id === frameId) {
      node.name = `${root.name.replace(/ · (Desktop|Tablet|iPad|Mobile|Custom)( \d+×\d+)?$/, '')} · ${size.label}`.slice(0, 120);
      node.size = { ...(node.size ?? {}), w: { kind: 'fixed', v: size.w }, h: { kind: 'fixed', v: size.h } };
      const w = root.size?.w?.kind === 'fixed' && typeof root.size.w.v === 'number' ? root.size.w.v : 1440;
      if (root.position) node.position = { x: root.position.x + w + 80, y: root.position.y };
    }
    ops.push({ op: 'create', page: page.id, node, parent, index });
    for (const c of children ?? []) copy(c, fresh, undefined);
  };
  copy(frameId, undefined, page.children.indexOf(frameId) + 1);
  return { ops, frame: ids.get(frameId)! };
}

// ---------------------------------------------------------------- display skins

export type Skin = 'none' | 'clean' | 'sketch';
export const SKINS: readonly Skin[] = ['none', 'clean', 'sketch'];
export const asSkin = (v: unknown): Skin => (SKINS.includes(v as Skin) ? (v as Skin) : 'none');

const HAND = `'Segoe Print','Bradley Hand','Chalkboard SE','Comic Sans MS',cursive`;
const IMAGE_X = `object-position:-99999px 0;background:linear-gradient(to top right,transparent calc(50% - .5px),#999,transparent calc(50% + .5px)),linear-gradient(to bottom right,transparent calc(50% - .5px),#999,transparent calc(50% + .5px)),#e8e8e8`;

/** How the skin changes what is drawn. It never touches the document, so switching back is instant. */
export function skinCss(skin: Skin, scope: string): string {
  if (skin === 'none') return '';
  const base = `${scope} img{${IMAGE_X}}`;
  if (skin === 'clean') return `${scope}{filter:grayscale(1)}${base}`;
  return `${scope}{filter:grayscale(1) url(#rk-rough)}${base}${scope},${scope} *{font-family:${HAND}!important}`;
}

/** The wobble behind the sketch skin. Must sit in the same document or shadow root as the frames. */
export const SKIN_DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="rk-rough"><feTurbulence type="fractalNoise" baseFrequency=".03" numOctaves="2" seed="4"/><feDisplacementMap in="SourceGraphic" scale="2.5"/></filter></svg>`;

export function applySkin(html: string, skin: Skin, scope: string): string {
  if (skin === 'none') return html;
  return html.replace('</head>', () => `<style>${skinCss(skin, scope)}</style></head>`).replace(/<body[^>]*>/, (m) => m + SKIN_DEFS);
}

// ---------------------------------------------------------------- annotations and the spec

export interface Annotation {
  n: number;
  id: string;
  node: string;
  body: string;
  author: string;
}

/** Numbered in the order they were written, so a number means the same thing on every surface. */
export function annotationsOf(reviews: ReviewData): Annotation[] {
  return reviews.threads
    .filter((t) => t.kind === 'annotation' && !t.resolved && t.node)
    .map((t, i) => ({ n: i + 1, id: t.id, node: t.node!, body: t.comments[0]?.body ?? '', author: t.comments[0]?.author ?? '' }));
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One printable page: every screen with its numbered notes. Print to PDF from the browser. */
export function wireframeSpecHtml(doc: RangoliDocument, reviews: ReviewData, opts: { title?: string; skin?: Skin; assetUrl?: RenderOptions['assetUrl']; assetBase?: string } = {}): string {
  const page = doc.page();
  const all = annotationsOf(reviews).filter((a) => page.nodes[a.node]);
  const rootOf = (id: string) => {
    let n = page.nodes[id];
    while (n?.parent) n = page.nodes[n.parent];
    return n?.id;
  };
  let css = '';
  const used = new Set<string>();
  const sections = page.children.map((id) => {
    const f = renderFragment(doc, { roots: [id], editorAttrs: true, assetUrl: opts.assetUrl, assetBase: opts.assetBase });
    css += f.css + '\n';
    f.usedComponents.forEach((c) => used.add(c));
    const notes = all.filter((a) => rootOf(a.node) === id);
    return `<section class="sp-screen"><h2>${esc(page.nodes[id]!.name)}</h2><div class="sp-frame" data-frame>${f.html}</div>${notes.length ? `<ol class="sp-notes">${notes.map((a) => `<li value="${a.n}">${esc(a.body)}</li>`).join('')}</ol>` : ''}</section>`;
  });
  const skin = opts.skin ?? 'clean';
  const markers = JSON.stringify(all.map((a) => ({ n: a.n, node: a.node }))).replace(/</g, '\\u003c');
  const title = esc(opts.title ?? doc.data.manifest.name);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} wireframes</title><style>${renderCss(doc, css, [...used])}
body{margin:0;background:#fff;color:#1c2026;font:14px/20px system-ui,sans-serif}
.sp-bar{display:flex;justify-content:space-between;align-items:center;padding:16px 32px;border-bottom:1px solid #e3e6ea}
.sp-bar h1{font-size:18px;margin:0}
.sp-bar button{height:32px;padding:0 12px;cursor:pointer}
.sp-screen{padding:24px 32px;break-inside:avoid-page}
.sp-screen h2{font-size:15px;margin:0 0 12px}
.sp-frame{position:relative;transform-origin:top left;width:max-content}
.sp-notes{margin:16px 0 0;padding-left:24px}
.sp-mark{position:absolute;width:20px;height:20px;border-radius:4px;background:#b7791f;color:#fff;font:600 11px/20px system-ui;text-align:center;z-index:9}
@media print{.sp-bar button{display:none}.sp-screen{padding:12px 0}}
${skinCss(skin, '.sp-frame>[data-rid]')}</style></head><body>${SKIN_DEFS}
<header class="sp-bar"><h1>${title}: wireframes</h1><button type="button" onclick="print()">Print or save as PDF</button></header>
${sections.join('\n')}
<script>
var M=${markers},W=860;
document.querySelectorAll('[data-frame]').forEach(function(f){var w=f.scrollWidth,h=f.scrollHeight,s=Math.min(1,W/w);f.style.transform='scale('+s+')';f.style.marginBottom=(h*s-h)+'px';f.dataset.s=s});
M.forEach(function(m){var el=document.querySelector('[data-rid="'+m.node+'"]');if(!el)return;var f=el.closest('[data-frame]'),b=f.getBoundingClientRect(),r=el.getBoundingClientRect(),s=+f.dataset.s,d=document.createElement('span');d.className='sp-mark';d.textContent=m.n;d.style.left=(r.left-b.left)/s+'px';d.style.top=(r.top-b.top)/s+'px';d.style.transform='scale('+1/s+')';f.appendChild(d)});
</script></body></html>`;
}
