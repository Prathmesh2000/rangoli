/**
 * Standalone HTML prototype: every top-level frame becomes a screen, interactions run in a tiny
 * dependency-free runtime (Web Animations API). Smart animate = FLIP between layers with the same
 * name path. Reduced motion → short dissolves, timelines fade only.
 */
import { cloneDocument } from './review.js';
import type { AssetMeta } from './images.js';
import type { RangoliDocument } from './document.js';
import { resolveTiming, specKeyframes } from './motion.js';
import type { Interaction } from './prototype.js';
import { renderCss, renderFragment } from './render.js';
import { cssVarName, TokenResolver, tokenValueToCss } from './tokens.js';

export interface PlayerOptions {
  start?: string;
  mode?: string;
  /** add a live-reload hook (EventSource on /events) when served by rangoli */
  liveReload?: boolean;
  title?: string;
  /** where asset files are served from (default "assets/" next to the exported HTML) */
  assetBase?: string;
  /** embed assets directly, for pages that cannot fetch them */
  assetUrl?: (meta: AssetMeta) => string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function prototypeHtml(doc: RangoliDocument, opts: PlayerOptions = {}): string {
  const page = doc.page();
  const tokens = new TokenResolver(doc.data.tokens);
  const screens = page.children.filter((id) => page.nodes[id]?.type === 'frame' || page.nodes[id]?.type === 'group');
  const start = opts.start && screens.includes(opts.start) ? opts.start : doc.data.prototype?.start && screens.includes(doc.data.prototype.start) ? doc.data.prototype.start : screens[0];

  // literal values for WAAPI (var() inside keyframes/easing is not reliable)
  const varMap = new Map<string, string>();
  for (const t of tokens.flat.values()) {
    const v = tokenValueToCss(tokens.resolve(t.path), t.type);
    if (v !== undefined) varMap.set(cssVarName(t.path), v);
  }
  const lit = (s: string) => s.replace(/var\((--[\w.-]+)\)/g, (m, name: string) => varMap.get(name) ?? m);
  const literalEasing = (easing: string) => {
    if (easing.startsWith('spring:')) return resolveTiming({ duration: 'base', easing }, tokens).ease;
    const b = tokens.resolve(`motion.easing.${easing}`) as number[] | undefined;
    return b ? `cubic-bezier(${b.join(',')})` : 'ease';
  };
  const literalMs = (duration: string, easing: string) => resolveTiming({ duration, easing }, tokens).ms;

  // screens
  let css = '';
  const used = new Set<string>();
  const sections = screens.map((id) => {
    const f = renderFragment(doc, { roots: [id], editorAttrs: true, assetBase: opts.assetBase, assetUrl: opts.assetUrl });
    css += f.css + '\n';
    f.usedComponents.forEach((c) => used.add(c));
    const n = page.nodes[id]!;
    return `<section class="rp-screen" data-screen="${id}" aria-label="${esc(n.name)}">${f.html}</section>`;
  });

  // swap templates (pre-rendered variants with renamed classes)
  const swaps: Record<string, string> = {};
  let k = 0;
  const interactions: Record<string, (Interaction & { ms: number; ease: string })[]> = {};
  for (const [node, list] of Object.entries(doc.data.prototype?.interactions ?? {})) {
    if (!page.nodes[node]) continue;
    interactions[node] = list.map((it) => {
      const out = { ...it, ms: literalMs(it.transition.duration, it.transition.easing), ease: literalEasing(it.transition.easing) };
      if (it.action === 'swap' && it.variant) {
        const target = it.target ?? node;
        const copy = cloneDocument(doc);
        const tn = copy.findNode(target)?.node;
        if (tn) {
          tn.variant = { ...(tn.variant ?? {}), ...it.variant };
          const f = renderFragment(copy, { roots: [target], editorAttrs: true });
          const suffix = `__s${k++}`;
          const re = new RegExp(`r-${target}(?![\\w-])`, 'g');
          swaps[`${node}:${list.indexOf(it)}`] = f.html.replace(re, `r-${target}${suffix}`);
          css += f.css.replace(re, `r-${target}${suffix}`) + '\n';
          f.usedComponents.forEach((c) => used.add(c));
        }
      }
      return out;
    });
  }

  // smart-animate keys: layer name path below the screen root
  const keys: Record<string, string> = {};
  const walk = (id: string, path: string) => {
    const seen = new Map<string, number>();
    for (const c of page.nodes[id]?.children ?? []) {
      const cn = page.nodes[c];
      if (!cn) continue;
      const i = seen.get(cn.name) ?? 0;
      seen.set(cn.name, i + 1);
      const key = `${path}/${cn.name}${i ? `#${i}` : ''}`;
      keys[c] = key;
      walk(c, key);
    }
  };
  for (const root of screens) walk(root, '');

  // timelines → literal keyframes (+ reduced)
  const timelines: Record<string, { target: string; at: number; ms: number; easing: string; from: Record<string, string>; to: Record<string, string>; rfrom: Record<string, string>; rto: Record<string, string> }[]> = {};
  for (const tl of Object.values(doc.data.timelines ?? {})) {
    timelines[tl.name] = tl.tracks.map((t) => {
      const kf = specKeyframes(t.spec, doc.data.tokens);
      const rk = specKeyframes(t.spec, doc.data.tokens, true);
      const litObj = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([a, b]) => [a, lit(b)]));
      return { target: t.target, at: t.at, ms: kf.ms, easing: literalEasing(t.spec.easing), from: litObj(kf.from), to: litObj(kf.to), rfrom: litObj(rk.from), rto: litObj(rk.to) };
    });
  }

  const data = { vars: doc.data.prototype?.variables ?? {}, start, screens: Object.fromEntries(screens.map((id) => [id, page.nodes[id]!.name])), interactions, swaps, keys, timelines };
  const allCss = renderCss(doc, css, [...used]);
  const mode = opts.mode && opts.mode !== 'light' ? ` data-mode="${esc(opts.mode)}"` : '';

  return `<!doctype html>
<html lang="en"${mode}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title ?? `${doc.data.manifest.name} — prototype`)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 3l9 5-9 5z' fill='%232a6fb0'/%3E%3C/svg%3E">
<style>
${allCss}
${PLAYER_CSS}
</style>
</head>
<body>
<main class="rp-stage"><div class="rp-viewport">${sections.join('\n')}</div></main>
<div class="rp-hud" role="toolbar" aria-label="Prototype controls">
  <button type="button" data-rp="back" title="Back (Backspace)">← Back</button>
  <span class="rp-name" aria-live="polite"></span>
  <span class="rp-vars" title="Prototype variables"></span>
  <button type="button" data-rp="restart" title="Restart (R)">↺ Restart</button>
  <button type="button" data-rp="hotspots" aria-pressed="false" title="Show clickable areas (H)">Hotspots</button>
</div>
<script>window.__RP__=${JSON.stringify(data).replace(/</g, '\\u003c')};</script>
<script>${PLAYER_JS}</script>
${opts.liveReload ? `<script>new EventSource('/events').addEventListener('change',()=>location.reload())</script>` : ''}
</body>
</html>
`;
}

const PLAYER_CSS = `
html,body{height:100%}
body{margin:0;overflow:hidden}
.rp-stage{position:fixed;inset:0 0 48px 0;display:grid;place-items:center;overflow:auto;background:var(--color-bg-canvas)}
.rp-viewport{position:relative;overflow:hidden;box-shadow:0 0 0 1px var(--color-border-default)}
.rp-screen{position:absolute;left:0;top:0;display:none}
.rp-screen.is-active,.rp-screen.is-leaving{display:block}
.rp-screen.is-overlay{display:block;z-index:10}
.rp-backdrop{position:absolute;inset:0;background:rgba(10,12,16,.45);z-index:9}
.rp-hud{position:fixed;left:0;right:0;bottom:0;height:48px;display:flex;align-items:center;gap:8px;padding:0 12px;background:#14161a;color:#e6e8eb;font:500 13px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.rp-hud button{all:unset;cursor:pointer;padding:8px 10px;border-radius:6px}
.rp-hud button:hover{background:rgba(255,255,255,.1)}
.rp-hud button:focus-visible{outline:2px solid #5b9be0}
.rp-hud button[aria-pressed="true"]{background:rgba(255,255,255,.18)}
.rp-name{flex:1;text-align:center;opacity:.8}
.rp-vars{opacity:.7;font-size:12px;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rp-hot{cursor:pointer}
body.rp-show-hot .rp-hot,.rp-flash .rp-hot{outline:2px solid rgba(47,129,247,.85)!important;outline-offset:2px;background-color:rgba(47,129,247,.08)}
`;

/** Dependency-free runtime. Kept small and readable on purpose. */
const PLAYER_JS = `(() => {
const D = window.__RP__, viewport = document.querySelector('.rp-viewport'), nameEl = document.querySelector('.rp-name');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let current = null, history = [], overlays = [], timers = [];
const screenEl = (id) => viewport.querySelector('[data-screen="' + id + '"]');
const sizeTo = (el) => { const f = el.firstElementChild; if (!f) return; viewport.style.width = f.offsetWidth + 'px'; viewport.style.height = f.offsetHeight + 'px'; };
const anim = (el, kf, ms, easing) => el.animate(kf, { duration: reduce ? Math.min(ms, 150) : ms, easing: easing || 'ease', fill: 'both' });
function markHotspots(root) {
  for (const id of Object.keys(D.interactions)) {
    const el = root.querySelector('[data-rid="' + id + '"]');
    if (!el || el.classList.contains('rp-hot')) continue;
    el.classList.add('rp-hot');
    if (D.interactions[id].some((i) => i.trigger === 'click') && !/^(BUTTON|A|INPUT)$/.test(el.tagName)) { el.tabIndex = 0; el.setAttribute('role', 'button'); }
  }
}
function armDelays(scope) {
  for (const [id, list] of Object.entries(D.interactions)) {
    const el = scope.querySelector('[data-rid="' + id + '"]');
    if (!el) continue;
    list.forEach((it) => { if (it.trigger === 'delay') timers.push(setTimeout(() => run(it, id, el), it.delay || 0)); });
  }
}
function clearTimers() { timers.forEach(clearTimeout); timers = []; }
function show(id, tr, push) {
  const to = screenEl(id); if (!to || id === current) return;
  const from = current && screenEl(current);
  closeAllOverlays(true); clearTimers();
  if (push && current) history.push(current);
  const t0 = tr ? tr.transition.type : 'instant';
  const type = reduce && t0 !== 'instant' ? 'dissolve' : t0;
  if (type === 'smart' && from && tr) smart(from, to, tr); else {
    to.classList.add('is-active'); sizeTo(to);
    if (from) {
      from.classList.remove('is-active'); from.classList.add('is-leaving');
      const done = () => { from.classList.remove('is-leaving'); from.getAnimations().forEach((a) => a.cancel()); };
      const ms = tr ? tr.ms : 0, ease = tr ? tr.ease : 'ease';
      const d = { left: ['100%', '0'], right: ['-100%', '0'], up: ['0', '100%'], down: ['0', '-100%'] }[(tr && tr.transition.direction) || 'left'];
      if (type === 'dissolve') { to.style.zIndex = 2; anim(to, [{ opacity: 0 }, { opacity: 1 }], ms, ease).finished.then(done); }
      else if (type === 'slide') { to.style.zIndex = 2; anim(to, [{ transform: 'translate(' + d[0] + ',' + d[1] + ')' }, { transform: 'none' }], ms, ease).finished.then(done); }
      else if (type === 'push') {
        const back = d.map((v) => v === '0' ? '0' : v.startsWith('-') ? v.slice(1) : '-' + v);
        anim(to, [{ transform: 'translate(' + d[0] + ',' + d[1] + ')' }, { transform: 'none' }], ms, ease);
        anim(from, [{ transform: 'none' }, { transform: 'translate(' + back[0] + ',' + back[1] + ')' }], ms, ease).finished.then(done);
      } else done();
    }
  }
  to.style.zIndex = '';
  current = id; nameEl.textContent = D.screens[id] || id;
  markHotspots(to); armDelays(to);
}
function smart(from, to, tr) {
  const vr = viewport.getBoundingClientRect();
  const rects = new Map();
  from.querySelectorAll('[data-rid]').forEach((el) => { const k = D.keys[el.dataset.rid]; if (k) rects.set(k, el.getBoundingClientRect()); });
  from.classList.remove('is-active'); to.classList.add('is-active'); sizeTo(to);
  const moved = new Map();
  to.querySelectorAll('[data-rid]').forEach((el) => {
    const k = D.keys[el.dataset.rid]; const a = k && rects.get(k);
    if (!a) { anim(el, [{ opacity: 0 }, { opacity: 1 }], tr.ms, tr.ease); return; }
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top, sx = b.width ? a.width / b.width : 1, sy = b.height ? a.height / b.height : 1;
    // skip if an animated ancestor already carries the same movement
    let p = el.parentElement, inherited = false;
    while (p && p !== to) { const m = moved.get(p); if (m && Math.abs(m[0] - dx) < 0.5 && Math.abs(m[1] - dy) < 0.5) { inherited = true; break; } p = p.parentElement; }
    if (inherited || (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01)) return;
    moved.set(el, [dx, dy]);
    anim(el, [{ transformOrigin: '0 0', transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')' }, { transformOrigin: '0 0', transform: 'none' }], tr.ms, tr.ease);
  });
  void vr;
}
function openOverlay(id, tr) {
  const el = screenEl(id); if (!el) return;
  const bd = document.createElement('div'); bd.className = 'rp-backdrop'; viewport.appendChild(bd);
  bd.addEventListener('click', () => closeOverlay());
  el.classList.add('is-overlay');
  const f = el.firstElementChild; const vw = viewport.offsetWidth, vh = viewport.offsetHeight;
  el.style.left = Math.max(0, (vw - f.offsetWidth) / 2) + 'px'; el.style.top = Math.max(0, (vh - f.offsetHeight) / 2) + 'px';
  anim(bd, [{ opacity: 0 }, { opacity: 1 }], tr.ms, tr.ease);
  anim(el, tr.transition.type === 'slide' ? [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }] : [{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }], tr.ms, tr.ease);
  overlays.push({ id, el, bd }); markHotspots(el); armDelays(el);
}
function closeOverlay(instant) {
  const o = overlays.pop(); if (!o) return;
  const end = () => { o.el.classList.remove('is-overlay'); o.el.style.left = o.el.style.top = ''; o.el.getAnimations().forEach((a) => a.cancel()); o.bd.remove(); };
  if (instant) return end();
  anim(o.bd, [{ opacity: 1 }, { opacity: 0 }], 120, 'ease-in'); anim(o.el, [{ opacity: 1 }, { opacity: 0 }], 120, 'ease-in').finished.then(end);
}
function closeAllOverlays(instant) { while (overlays.length) closeOverlay(instant); }
function playTimeline(name) {
  const scope = overlays.length ? overlays[overlays.length - 1].el : screenEl(current);
  for (const t of D.timelines[name] || []) {
    const el = scope.querySelector('[data-rid="' + t.target + '"]'); if (!el) continue;
    el.animate([reduce ? t.rfrom : t.from, reduce ? t.rto : t.to], { duration: reduce ? Math.min(t.ms, 150) : t.ms, delay: reduce ? 0 : t.at, easing: t.easing, fill: 'both' });
  }
}
const original = new Map();
let V = Object.assign({}, D.vars), hiddenByLogic = [];
const texts = new Map();
function paint() {
  const walker = document.createTreeWalker(viewport, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!texts.has(n) && /{{[\\w-]+}}/.test(n.nodeValue)) texts.set(n, n.nodeValue);
  texts.forEach((tpl, n) => { n.nodeValue = tpl.replace(/{{([\\w-]+)}}/g, (_, k) => (k in V ? V[k] : '')); });
  const shown = Object.entries(V).map(([k, v]) => k + '=' + v).join('  ');
  document.querySelector('.rp-vars').textContent = shown;
}
function holds(c) {
  const set = c.name in V, a = V[c.name], na = Number(a), nb = Number(c.value), numeric = set && a !== '' && !isNaN(na) && !isNaN(nb);
  const text = set ? String(a) : c.value === 'false' ? 'false' : '';
  switch (c.op) {
    case '=': return text === c.value;
    case '!=': return text !== c.value;
    case '>': return numeric && na > nb;
    case '<': return numeric && na < nb;
    case '>=': return numeric && na >= nb;
    case '<=': return numeric && na <= nb;
  }
  return false;
}
function setVisible(id, visible) {
  viewport.querySelectorAll('[data-rid="' + id + '"]').forEach((el) => {
    el.style.display = visible ? '' : 'none';
    if (!visible && !hiddenByLogic.includes(el)) hiddenByLogic.push(el);
  });
}
function isVisible(id) {
  const el = viewport.querySelector('[data-rid="' + id + '"]');
  return !!el && el.style.display !== 'none';
}
function run(it, id, el) {
  if (it.when && !it.when.every(holds)) return;
  switch (it.action) {
    case 'set':
      for (const [k, v] of Object.entries(it.variant || {})) V[k] = /^[+-]\\d+(\\.\\d+)?$/.test(v) ? String((Number(V[k]) || 0) + Number(v)) : v;
      return paint();
    case 'toggle':
      if (it.target) return setVisible(it.target, !isVisible(it.target));
      V[it.variable] = V[it.variable] === 'true' ? 'false' : 'true';
      return paint();
    case 'show': return setVisible(it.target, true);
    case 'hide': return setVisible(it.target, false);
    case 'navigate': return show(it.target, it, true);
    case 'overlay': return openOverlay(it.target, it);
    case 'close': return closeOverlay();
    case 'back': return overlays.length ? closeOverlay() : back();
    case 'play': return playTimeline(it.timeline);
    case 'swap': {
      const target = it.target ? viewport.querySelector('.is-active [data-rid="' + it.target + '"], .is-overlay [data-rid="' + it.target + '"]') : el;
      const html = D.swaps[id + ':' + D.interactions[id].indexOf(it)]; if (!target || !html) return;
      if (!original.has(target.dataset.rid)) original.set(target.dataset.rid, target.outerHTML);
      const tmp = document.createElement('div'); tmp.innerHTML = html; const next = tmp.firstElementChild;
      target.replaceWith(next); markHotspots(next.parentElement || viewport);
      if (!reduce) next.animate([{ opacity: .6 }, { opacity: 1 }], { duration: it.ms, easing: it.ease });
      return next;
    }
  }
}
function back() { const prev = history.pop(); if (prev) show(prev, { ms: 200, ease: 'ease', transition: { type: 'dissolve' } }, false); }
function handlersFor(el, trigger) {
  let n = el;
  while (n && n !== document.body) {
    const id = n.dataset && n.dataset.rid;
    const list = id && D.interactions[id] && D.interactions[id].filter((i) => i.trigger === trigger);
    if (list && list.length) return { id, el: n, list };
    n = n.parentElement;
  }
  return null;
}
document.addEventListener('click', (e) => {
  if (e.target.closest('.rp-hud')) return;
  const h = handlersFor(e.target, 'click');
  if (!h) { document.body.classList.add('rp-flash'); setTimeout(() => document.body.classList.remove('rp-flash'), 400); return; }
  e.preventDefault(); h.list.forEach((it) => run(it, h.id, h.el));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { const h = document.activeElement && handlersFor(document.activeElement, 'click'); if (h && document.activeElement.getAttribute('role') === 'button') { e.preventDefault(); h.list.forEach((it) => run(it, h.id, h.el)); return; } }
  for (const [id, list] of Object.entries(D.interactions)) for (const it of list) if (it.trigger === 'key' && it.key === e.key) { const el = viewport.querySelector('.is-active [data-rid="' + id + '"], .is-overlay [data-rid="' + id + '"]'); if (el) { e.preventDefault(); run(it, id, el); } }
  if (e.target.closest && e.target.closest('input,textarea')) return;
  if (e.key === 'h' || e.key === 'H') toggleHot();
  if (e.key === 'r' || e.key === 'R') restart();
  if (e.key === 'Escape') closeOverlay();
  if (e.key === 'Backspace') back();
});
document.addEventListener('pointerdown', (e) => { const h = handlersFor(e.target, 'press'); if (h) h.list.forEach((it) => run(it, h.id, h.el)); });
let hovered = null;
document.addEventListener('pointerover', (e) => {
  const h = handlersFor(e.target, 'hover'); if (!h || hovered === h.el) return;
  hovered = h.el; let swapped = null;
  h.list.forEach((it) => { const r = run(it, h.id, h.el); if (it.action === 'swap' && r) swapped = r; });
  const leaveEl = swapped || h.el;
  leaveEl.addEventListener('pointerleave', () => {
    hovered = null;
    if (swapped && original.has(h.id)) { const tmp = document.createElement('div'); tmp.innerHTML = original.get(h.id); const back = tmp.firstElementChild; swapped.replaceWith(back); markHotspots(back.parentElement || viewport); }
  }, { once: true });
});
function toggleHot() { const on = document.body.classList.toggle('rp-show-hot'); document.querySelector('[data-rp="hotspots"]').setAttribute('aria-pressed', String(on)); }
function restart() { V = Object.assign({}, D.vars); hiddenByLogic.forEach((el) => { el.style.display = ''; }); hiddenByLogic = []; paint(); history = []; closeAllOverlays(true); const s = current; current = null; if (s) screenEl(s).classList.remove('is-active'); show(D.start, null, false); }
document.querySelector('.rp-hud').addEventListener('click', (e) => { const a = e.target.dataset && e.target.dataset.rp; if (a === 'back') back(); if (a === 'restart') restart(); if (a === 'hotspots') toggleHot(); });
paint();
show(D.start, null, false);
window.__rangoliPlayer = { vars: () => Object.assign({}, V), show: (id) => show(id, null, true), current: () => current, overlays: () => overlays.map((o) => o.id), playTimeline };
})();`;
