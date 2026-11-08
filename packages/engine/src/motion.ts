/**
 * Motion engine (SPEC §9, Phase 2): state transitions + enter/exit, as data.
 *
 *   motion @Button variant=primary
 *     hover fill:action.primaryHover fast out
 *     press scale:press fast out
 *   motion #n7
 *     enter opacity:0, scale:popIn, y:md base out      (single value on enter = FROM)
 *     exit  opacity:0, scale:popIn fast in             (single value on exit  = TO)
 *
 * CSS output: transitions for states (interruptible), keyframes for enter/exit,
 * springs as CSS linear() curves, and an automatic reduced-motion variant (fades kept, movement removed).
 */
import type { Diagnostic } from './rdl.js';
import { cssVarName, TokenResolver } from './tokens.js';
import type { TokenTree } from './model.js';

export type MotionTrigger = 'hover' | 'press' | 'focus' | 'disabled' | 'selected' | 'enter' | 'exit';
export type MotionProp = 'opacity' | 'scale' | 'x' | 'y' | 'rotate' | 'fill' | 'color' | 'stroke' | 'shadow' | 'blur' | 'w' | 'h' | 'ring';

export interface MotionTrack {
  prop: MotionProp;
  from?: string;
  to?: string;
}

export interface MotionSpec {
  trigger: MotionTrigger;
  tracks: MotionTrack[];
  /** duration token name (fast, base…) or "<n>ms" */
  duration: string;
  /** easing token name (out, in, inOut, drawer, linear) or spring:<name> */
  easing: string;
  delay?: number;
}

export interface MotionDef {
  /** "@Button", "@Button[variant=primary]" or "#n7" */
  target: string;
  specs: MotionSpec[];
}

export const TRIGGERS: MotionTrigger[] = ['hover', 'press', 'focus', 'disabled', 'selected', 'enter', 'exit'];
const PROPS: MotionProp[] = ['opacity', 'scale', 'x', 'y', 'rotate', 'fill', 'color', 'stroke', 'shadow', 'blur', 'w', 'h', 'ring'];
const STATE_TRIGGERS = new Set<MotionTrigger>(['hover', 'press', 'focus', 'disabled', 'selected']);
const TRANSFORM_PROPS = new Set<MotionProp>(['scale', 'x', 'y', 'rotate']);

// ---------------------------------------------------------------- target keys

export function targetKey(base: string, filters: Record<string, string> = {}): string {
  const f = Object.entries(filters).sort(([a], [b]) => a.localeCompare(b));
  return f.length ? `${base}[${f.map(([k, v]) => `${k}=${v}`).join(',')}]` : base;
}

export function parseTargetKey(key: string): { base: string; filters: Record<string, string> } {
  const m = /^([@#][\w-]+)(?:\[(.*)\])?$/.exec(key);
  if (!m) return { base: key, filters: {} };
  const filters: Record<string, string> = {};
  for (const kv of (m[2] ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    if (k && v) filters[k] = v;
  }
  return { base: m[1]!, filters };
}

export function targetSelector(key: string): string {
  const { base, filters } = parseTargetKey(key);
  const sel = base.startsWith('@') ? `.rc-${base.slice(1)}` : `.r-${base.slice(1)}`;
  return sel + Object.entries(filters).map(([k, v]) => `[data-${k}="${v}"]`).join('');
}

// ---------------------------------------------------------------- parsing

/** Parse motion block lines (already tokenized) into specs. */
export function parseMotionLines(lines: { no: number; toks: string[] }[], diag: Diagnostic[]): MotionSpec[] {
  const specs: MotionSpec[] = [];
  for (const { no, toks: raw } of lines) {
    const toks = raw.flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean);
    const trigger = toks[0] as MotionTrigger;
    if (!TRIGGERS.includes(trigger)) {
      diag.push({ line: no, severity: 'error', message: `Unknown motion trigger "${toks[0]}". Use: ${TRIGGERS.join(', ')}` });
      continue;
    }
    const spec: MotionSpec = { trigger, tracks: [], duration: STATE_TRIGGERS.has(trigger) ? 'fast' : 'base', easing: trigger === 'exit' ? 'in' : 'out' };
    for (const t of toks.slice(1)) {
      let m: RegExpExecArray | null;
      if (t === 'ring') { spec.tracks.push({ prop: 'ring', to: 'focus' }); continue; }
      if ((m = /^delay:(\d+)(?:ms)?$/.exec(t))) { spec.delay = Number(m[1]); continue; }
      if (/^(instant|fast|base|slow|panel)$/.test(t) || /^\d+ms$/.test(t)) { spec.duration = t; continue; }
      if (/^(out|in|inOut|drawer|linear)$/.test(t) || /^spring:[\w-]+$/.test(t)) { spec.easing = t; continue; }
      if ((m = /^([a-z]+):(.+)$/.exec(t))) {
        const prop = m[1] as MotionProp;
        if (!PROPS.includes(prop)) { diag.push({ line: no, severity: 'error', message: `Unknown motion property "${m[1]}". Use: ${PROPS.join(', ')}` }); continue; }
        const parts = m[2]!.split(/→|->/);
        if (parts.length === 2) spec.tracks.push({ prop, from: parts[0], to: parts[1] });
        else if (trigger === 'enter') spec.tracks.push({ prop, from: parts[0] });
        else spec.tracks.push({ prop, to: parts[0] });
        continue;
      }
      diag.push({ line: no, severity: 'error', message: `Unknown motion token "${t}" (expected prop:value, duration like fast/200ms, easing like out/spring:snappy)` });
    }
    if (!spec.tracks.length) diag.push({ line: no, severity: 'error', message: `"${trigger}" has no properties (e.g. opacity:0, scale:press, fill:action.primaryHover)` });
    specs.push(spec);
  }
  return specs;
}

export function serializeMotion(motion: Record<string, MotionDef> | undefined, targets?: string[]): string {
  const out: string[] = [];
  for (const def of Object.values(motion ?? {})) {
    if (targets && !targets.some((t) => def.target === t || def.target.startsWith(`${t}[`))) continue;
    const { base, filters } = parseTargetKey(def.target);
    out.push(`motion ${base}${Object.entries(filters).map(([k, v]) => ` ${k}=${v}`).join('')}`);
    for (const s of def.specs) {
      const tracks = s.tracks.map((t) => (t.prop === 'ring' ? 'ring' : t.from !== undefined && t.to !== undefined ? `${t.prop}:${t.from}→${t.to}` : `${t.prop}:${t.from ?? t.to}`));
      out.push(`  ${s.trigger} ${tracks.join(', ')} ${s.duration} ${s.easing}${s.delay ? ` delay:${s.delay}` : ''}`);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- easing math

/** Evaluate cubic-bezier(x1,y1,x2,y2) at progress t ∈ [0,1]. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const bx = (u: number) => 3 * x1 * u * (1 - u) ** 2 + 3 * x2 * u ** 2 * (1 - u) + u ** 3;
  const by = (u: number) => 3 * y1 * u * (1 - u) ** 2 + 3 * y2 * u ** 2 * (1 - u) + u ** 3;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0, hi = 1, u = t;
    for (let i = 0; i < 40; i++) {
      u = (lo + hi) / 2;
      if (bx(u) < t) lo = u; else hi = u;
    }
    return by(u);
  };
}

export interface SpringParams { stiffness: number; damping: number; mass?: number }

/** Simulate a spring 0→1. Returns samples, settle duration (ms) and overshoot. */
export function simulateSpring(p: SpringParams): { samples: number[]; duration: number; overshoot: number } {
  const m = p.mass ?? 1, k = p.stiffness, c = p.damping;
  let x = 0, v = 0, t = 0, maxX = 0;
  const dt = 1 / 1000;
  const xs: number[] = [];
  while (t < 2) {
    const a = (-k * (x - 1) - c * v) / m;
    v += a * dt;
    x += v * dt;
    t += dt;
    xs.push(x);
    maxX = Math.max(maxX, x);
    if (Math.abs(x - 1) < 0.001 && Math.abs(v) < 0.01 && t > 0.05) break;
  }
  const duration = Math.round(t * 1000);
  const N = 24;
  const samples = Array.from({ length: N + 1 }, (_, i) => xs[Math.min(xs.length - 1, Math.round((i / N) * (xs.length - 1)))]!);
  samples[N] = 1;
  return { samples, duration, overshoot: Math.max(0, maxX - 1) };
}

export function dampingRatio(p: SpringParams): number {
  return p.damping / (2 * Math.sqrt(p.stiffness * (p.mass ?? 1)));
}

// ---------------------------------------------------------------- resolution

interface Timing {
  ms: number;
  css: string; // duration css
  ease: string; // timing function css
  fn: (t: number) => number;
  spring?: { overshoot: number; ratio: number };
}

export function resolveTiming(spec: Pick<MotionSpec, 'duration' | 'easing'>, tokens: TokenResolver): Timing {
  let ms = 0;
  let durCss: string;
  if (/^\d+ms$/.test(spec.duration)) { ms = parseInt(spec.duration, 10); durCss = spec.duration; }
  else {
    const path = `motion.duration.${spec.duration}`;
    ms = Number(tokens.resolve(path) ?? 0);
    durCss = tokens.has(path) ? `var(${cssVarName(path)})` : `${ms}ms`;
  }
  if (spec.easing.startsWith('spring:')) {
    const sp = tokens.resolve(`motion.spring.${spec.easing.slice(7)}`) as SpringParams | undefined;
    if (sp) {
      const sim = simulateSpring(sp);
      const pts = sim.samples.map((v) => +v.toFixed(3)).join(', ');
      // spring defines its own duration
      return { ms: sim.duration, css: `${sim.duration}ms`, ease: `linear(${pts})`, fn: (t) => sim.samples[Math.round(t * (sim.samples.length - 1))]!, spring: { overshoot: sim.overshoot, ratio: dampingRatio(sp) } };
    }
  }
  const path = `motion.easing.${spec.easing}`;
  const bez = (tokens.resolve(path) as number[] | undefined) ?? [0.2, 0, 0, 1];
  return { ms, css: durCss, ease: tokens.has(path) ? `var(${cssVarName(path)})` : `cubic-bezier(${bez.join(',')})`, fn: cubicBezier(bez[0]!, bez[1]!, bez[2]!, bez[3]!) };
}

const NATURAL: Partial<Record<MotionProp, string>> = { opacity: '1', scale: '1', x: '0', y: '0', rotate: '0', blur: '0' };

function cssValue(prop: MotionProp, raw: string, tokens: TokenResolver): string {
  const neg = raw.startsWith('-') && !/^-?\d/.test(raw.slice(1)) ? '-' : '';
  const v = neg ? raw.slice(1) : raw;
  const num = /^-?\d+(\.\d+)?$/.test(v);
  switch (prop) {
    case 'opacity':
      return v;
    case 'scale': {
      if (num) return v;
      const p = `motion.scale.${v}`;
      return tokens.has(p) ? `var(${cssVarName(p)})` : v;
    }
    case 'x':
    case 'y':
    case 'blur': {
      if (num) return `${neg}${v}px`;
      const p = `motion.distance.${v}`;
      return tokens.has(p) ? (neg ? `calc(-1 * var(${cssVarName(p)}))` : `var(${cssVarName(p)})`) : `${v}px`;
    }
    case 'rotate':
      return `${neg}${v}deg`;
    case 'fill':
    case 'color':
    case 'stroke': {
      if (v.startsWith('#')) return v;
      const p = tokens.find(v, 'color');
      return p ? `var(${cssVarName(p)})` : v;
    }
    case 'shadow': {
      if (v === 'none') return 'none';
      const p = tokens.find(v, 'shadow');
      return p ? `var(${cssVarName(p)})` : v;
    }
    case 'w':
    case 'h':
      return num ? `${v}px` : v;
    case 'ring':
      return `var(${cssVarName('color.border.focus')})`;
  }
}

/** Numeric value of a track endpoint, for curve sampling. */
function numericValue(prop: MotionProp, raw: string | undefined, tokens: TokenResolver): number | undefined {
  if (raw === undefined) raw = NATURAL[prop];
  if (raw === undefined) return undefined;
  const neg = raw.startsWith('-') ? -1 : 1;
  const v = raw.replace(/^-/, '');
  if (/^\d+(\.\d+)?$/.test(v)) return neg * Number(v);
  const group = prop === 'scale' ? 'motion.scale' : prop === 'x' || prop === 'y' || prop === 'blur' ? 'motion.distance' : undefined;
  if (group) {
    const r = tokens.resolve(`${group}.${v}`);
    if (typeof r === 'number') return neg * r;
  }
  return undefined;
}

function declsFor(tracks: MotionTrack[], which: 'from' | 'to', tokens: TokenResolver, reduced = false): string[] {
  const d: string[] = [];
  const transform: string[] = [];
  for (const t of tracks) {
    const raw = (which === 'from' ? t.from : t.to) ?? NATURAL[t.prop];
    if (raw === undefined) continue;
    if (reduced && (TRANSFORM_PROPS.has(t.prop) || t.prop === 'blur' || t.prop === 'w' || t.prop === 'h')) continue;
    const v = cssValue(t.prop, raw, tokens);
    switch (t.prop) {
      case 'opacity': d.push(`opacity:${v}`); break;
      case 'scale': transform.push(`scale(${v})`); break;
      case 'x': transform.push(`translateX(${v})`); break;
      case 'y': transform.push(`translateY(${v})`); break;
      case 'rotate': transform.push(`rotate(${v})`); break;
      case 'fill': d.push(`background-color:${v}`); break;
      case 'color': d.push(`color:${v}`); break;
      case 'stroke': d.push(`box-shadow:inset 0 0 0 1px ${v}`); break;
      case 'shadow': d.push(`box-shadow:${v}`); break;
      case 'blur': d.push(`filter:blur(${v})`); break;
      case 'w': d.push(`width:${v}`); break;
      case 'h': d.push(`height:${v}`); break;
      case 'ring': d.push(`outline:2px solid ${v}`, 'outline-offset:2px'); break;
    }
  }
  if (transform.length) d.push(`transform:${transform.join(' ')}`);
  return d;
}

const CSS_PROP: Record<MotionProp, string> = {
  opacity: 'opacity', scale: 'transform', x: 'transform', y: 'transform', rotate: 'transform', fill: 'background-color',
  color: 'color', stroke: 'box-shadow', shadow: 'box-shadow', blur: 'filter', w: 'width', h: 'height', ring: 'outline-color',
};

const PSEUDO: Record<string, string> = {
  hover: ':hover:not(:disabled):not([aria-disabled="true"])',
  press: ':active:not(:disabled):not([aria-disabled="true"])',
  focus: ':focus-visible',
  selected: '[aria-selected="true"]',
};

const keyframeName = (key: string, trig: string) => `rg-${key.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')}-${trig}`;

/** Keyframes for one spec as WAAPI-ready objects (used by prototypes and filmstrips). */
export function specKeyframes(spec: MotionSpec, tokenTree: TokenTree, reduced = false): { from: Record<string, string>; to: Record<string, string>; ms: number; easing: string } {
  const tokens = new TokenResolver(tokenTree);
  const toObj = (decls: string[]) =>
    Object.fromEntries(
      decls.map((d) => {
        const i = d.indexOf(':');
        return [d.slice(0, i).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), d.slice(i + 1)];
      }),
    );
  const tm = resolveTiming(spec, tokens);
  return { from: toObj(declsFor(spec.tracks, 'from', tokens, reduced)), to: toObj(declsFor(spec.tracks, 'to', tokens, reduced)), ms: tm.ms, easing: tm.ease };
}

/** Generate CSS for all motion definitions (+ timelines, triggered by class .tl-<name> on any ancestor). */
export function motionCss(motion: Record<string, MotionDef> | undefined, tokenTree: TokenTree, timelines?: Record<string, { name: string; tracks: { target: string; at: number; spec: MotionSpec }[] }>): string {
  if (!motion && !timelines) return '';
  const tokens = new TokenResolver(tokenTree);
  const out: string[] = [];
  const reduced: string[] = [];
  for (const tl of Object.values(timelines ?? {})) {
    tl.tracks.forEach((t, i) => {
      const tm = resolveTiming(t.spec, tokens);
      const name = `rg-tl-${tl.name}-${i}`;
      out.push(`@keyframes ${name}{from{${declsFor(t.spec.tracks, 'from', tokens).join(';')}}to{${declsFor(t.spec.tracks, 'to', tokens).join(';')}}}`);
      out.push(`.tl-${tl.name} .r-${t.target},.r-${t.target}.tl-${tl.name}{animation:${name} ${tm.css} ${tm.ease} ${t.at}ms both}`);
      const rf = declsFor(t.spec.tracks, 'from', tokens, true), rt = declsFor(t.spec.tracks, 'to', tokens, true);
      reduced.push(rf.length || rt.length ? `@keyframes ${name}-r{from{${rf.join(';')}}to{${rt.join(';')}}}.tl-${tl.name} .r-${t.target},.r-${t.target}.tl-${tl.name}{animation-name:${name}-r;animation-duration:${Math.min(tm.ms, 150)}ms}` : `.tl-${tl.name} .r-${t.target}{animation:none}`);
    });
  }
  for (const def of Object.values(motion ?? {})) {
    const S = targetSelector(def.target);
    const states = def.specs.filter((s) => STATE_TRIGGERS.has(s.trigger));
    // base transition list: how we animate back OUT of states (use each prop's first spec timing)
    const transitions = new Map<string, string>();
    for (const s of states) {
      const tm = resolveTiming(s, tokens);
      for (const t of s.tracks) {
        const p = CSS_PROP[t.prop];
        if (!transitions.has(p)) transitions.set(p, `${p} ${tm.css} ${tm.ease}`);
      }
    }
    if (transitions.size) out.push(`${S}{transition:${[...transitions.values()].join(',')}}`);
    for (const s of states) {
      const tm = resolveTiming(s, tokens);
      const decls = declsFor(s.tracks, 'to', tokens);
      const props = [...new Set(s.tracks.map((t) => CSS_PROP[t.prop]))];
      const trans = `transition:${props.map((p) => `${p} ${tm.css} ${tm.ease}${s.delay ? ` ${s.delay}ms` : ''}`).join(',')}`;
      const sel = s.trigger === 'disabled' ? `${S}:disabled,${S}[aria-disabled="true"]` : `${S}${PSEUDO[s.trigger]}`;
      out.push(`${sel}{${[...decls, trans].join(';')}}`);
      if (s.tracks.some((t) => TRANSFORM_PROPS.has(t.prop))) reduced.push(`${sel}{transform:none}`);
    }
    for (const s of def.specs.filter((x) => x.trigger === 'enter' || x.trigger === 'exit')) {
      const tm = resolveTiming(s, tokens);
      const name = keyframeName(def.target, s.trigger);
      const from = declsFor(s.tracks, 'from', tokens);
      const to = declsFor(s.tracks, 'to', tokens);
      out.push(`@keyframes ${name}{from{${from.join(';')}}to{${to.join(';')}}}`);
      const sel = s.trigger === 'enter' ? S : `${S}[data-exiting]`;
      out.push(`${sel}{animation:${name} ${tm.css} ${tm.ease} ${s.delay ?? 0}ms both}`);
      // reduced motion: keep the fade, drop movement
      const rFrom = declsFor(s.tracks, 'from', tokens, true);
      const rTo = declsFor(s.tracks, 'to', tokens, true);
      if (rFrom.length || rTo.length) {
        reduced.push(`@keyframes ${name}-r{from{${rFrom.join(';')}}to{${rTo.join(';')}}}`);
        reduced.push(`${sel}{animation-name:${name}-r;animation-duration:${Math.min(tm.ms, 150)}ms}`);
      } else reduced.push(`${sel}{animation:none}`);
    }
  }
  if (!out.length) return '';
  const head = '/* motion — enter animates on mount; add [data-exiting] to play exit before removal */';
  return [head, ...out, reduced.length ? `@media (prefers-reduced-motion: reduce){${reduced.join('')}}` : ''].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- sampling for agents

/** Value tables per track — how agents "see" an animation. */
export function sampleMotion(spec: MotionSpec, tokenTree: TokenTree, steps = 6): { ms: number; lines: string[] } {
  const tokens = new TokenResolver(tokenTree);
  const tm = resolveTiming(spec, tokens);
  const lines: string[] = [];
  const ts = Array.from({ length: steps }, (_, i) => i / (steps - 1));
  for (const t of spec.tracks) {
    const from = numericValue(t.prop, spec.trigger === 'exit' ? t.from : t.from, tokens);
    const to = numericValue(t.prop, t.to, tokens);
    if (from === undefined || to === undefined) {
      lines.push(`${t.prop}: ${t.from ?? '(current)'} → ${t.to ?? '(natural)'} over ${tm.ms}ms`);
      continue;
    }
    const vals = ts.map((p) => +(from + (to - from) * tm.fn(p)).toFixed(3));
    lines.push(`${t.prop}: ${vals.join(' ')}`);
  }
  lines.push(`t(ms): ${ts.map((p) => Math.round(p * tm.ms)).join(' ')}`);
  return { ms: tm.ms, lines };
}

// ---------------------------------------------------------------- lint (M rules)

export interface MotionIssue {
  code: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  target: string;
  message: string;
  fix?: string;
}

export function lintMotion(motion: Record<string, MotionDef> | undefined, tokenTree: TokenTree, nonInteractive: (target: string) => boolean = () => false): MotionIssue[] {
  const tokens = new TokenResolver(tokenTree);
  const issues: MotionIssue[] = [];
  for (const def of Object.values(motion ?? {})) {
    const enter = def.specs.find((s) => s.trigger === 'enter');
    const exit = def.specs.find((s) => s.trigger === 'exit');
    for (const s of def.specs) {
      const tm = resolveTiming(s, tokens);
      const frequent = s.trigger === 'hover' || s.trigger === 'press' || s.trigger === 'focus';
      const add = (code: string, severity: MotionIssue['severity'], message: string, fix?: string) => issues.push({ code, severity, target: def.target, message: `${s.trigger}: ${message}`, fix });
      if (tm.ms > 400 || (frequent && tm.ms > 200)) add('M01', 'P2', `${tm.ms}ms is slow for ${frequent ? 'a frequent interaction (keep ≤ 200ms)' : 'UI motion (keep ≤ 300–400ms)'}`, frequent ? `motion ${def.target} → use "fast"` : undefined);
      const jank = s.tracks.filter((t) => t.prop === 'w' || t.prop === 'h' || t.prop === 'shadow' || t.prop === 'blur');
      if (jank.length) add('M02', s.trigger === 'enter' && jank.some((t) => t.prop === 'w' || t.prop === 'h') ? 'P1' : 'P2', `animates ${jank.map((t) => t.prop).join(', ')} (layout/paint every frame). Prefer transform/opacity.`);
      if (tm.spring && tm.spring.ratio < 0.9) add('M03', 'P2', `spring overshoots ${(tm.spring.overshoot * 100).toFixed(0)}% (damping ratio ${tm.spring.ratio.toFixed(2)}) — bouncy motion feels toy-like in a work tool`);
      for (const t of s.tracks) {
        if (t.prop !== 'scale') continue;
        const v = numericValue('scale', s.trigger === 'exit' ? t.to : t.from, tokens);
        if (v !== undefined && v < 0.8) add('M05', 'P2', `scales from ${v} — start at ≥ 0.9 so it does not pop out of nothing`);
      }
      if (s.trigger === 'focus' && tm.ms > 100) add('M10', 'P3', 'focus feedback should be instant for keyboard users', undefined);
      if (s.trigger === 'hover' && nonInteractive(def.target) && s.tracks.some((t) => t.prop === 'y' || t.prop === 'scale' || t.prop === 'shadow')) {
        add('M11', 'P2', 'hover lift/scale on a non-interactive element — a classic AI-slop tell. Remove it or make the element clickable.');
      }
    }
    if (enter && exit) {
      const te = resolveTiming(enter, tokens).ms, tx = resolveTiming(exit, tokens).ms;
      if (tx >= te && te > 0) issues.push({ code: 'M07', severity: 'P3', target: def.target, message: `exit (${tx}ms) should be faster than enter (${te}ms)` });
    }
  }
  return issues;
}

// ---------------------------------------------------------------- presets & defaults

export const MOTION_PRESETS: Record<string, { description: string; rdl: string }> = {
  press: { description: 'Tactile press feedback for clickable elements', rdl: 'press scale:press fast out' },
  popover: { description: 'Menus, dropdowns, tooltips: small grow + fade from trigger', rdl: 'enter opacity:0, scale:popIn, y:-sm fast out\nexit opacity:0, scale:popIn instant in' },
  modal: { description: 'Dialogs: fade + slight scale/rise', rdl: 'enter opacity:0, scale:popIn, y:md base out\nexit opacity:0, scale:popIn fast in' },
  toast: { description: 'Toasts/snackbars: slide from edge + fade', rdl: 'enter opacity:0, y:md base out\nexit opacity:0, y:sm fast in' },
  listItem: { description: 'Row added/removed', rdl: 'enter opacity:0, y:sm base out\nexit opacity:0 fast in' },
  fade: { description: 'Plain fade in/out', rdl: 'enter opacity:0 base out\nexit opacity:0 fast in' },
  statusChange: { description: 'Status chip/icon change — the one memorable moment', rdl: 'enter opacity:0, scale:popIn base spring:snappy' },
  drawer: { description: 'Side sheet / drawer', rdl: 'enter opacity:0, x:lg panel drawer\nexit opacity:0, x:lg slow in' },
};

export function defaultMotion(): Record<string, MotionDef> {
  const d = (target: string, rdl: string): MotionDef => ({ target, specs: parseMotionLines(rdl.split('\n').map((l, i) => ({ no: i + 1, toks: l.trim().split(/\s+/) })), []) });
  const defs = [
    d('@Button', 'press scale:press fast out\nfocus ring instant\ndisabled opacity:0.5 instant'),
    d('@Button[variant=primary]', 'hover fill:action.primaryHover fast out'),
    d('@Button[variant=secondary]', 'hover fill:action.secondaryHover fast out'),
    d('@Button[variant=ghost]', 'hover fill:action.secondaryHover fast out'),
    d('@Button[variant=danger]', 'hover fill:action.dangerHover fast out'),
    d('@Input', 'hover stroke:text.secondary fast out\nfocus ring instant'),
  ];
  return Object.fromEntries(defs.map((x) => [x.target, x]));
}
