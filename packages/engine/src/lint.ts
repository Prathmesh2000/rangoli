/**
 * Deterministic design linter. Same input → same output. No AI.
 * Codes: D01–D15 (design). Motion rules M01–M14 arrive with the motion engine (Phase 2).
 */
import { contrastRatio, deltaE, hexToRgb, rgbToHex } from './color.js';
import { resolveInstance } from './components.js';
import type { RangoliDocument } from './document.js';
import { isTokenRef, type Len, type Paint, type RNode, type Style } from './model.js';
import { TokenResolver } from './tokens.js';
import { lintMotion } from './motion.js';
import { timelineDuration } from './prototype.js';
import { findIcon, lintIcons } from './icons.js';
import { formatBytes } from './images.js';

export type Severity = 'P0' | 'P1' | 'P2' | 'P3';

export interface LintIssue {
  code: string;
  severity: Severity;
  node: string;
  message: string;
  /** RDL command that fixes it, when deterministic */
  fix?: string;
}

export interface LintOptions {
  page?: string;
  roots?: string[];
  modes?: string[];
}

const SEV_ORDER: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function lint(doc: RangoliDocument, opts: LintOptions = {}): LintIssue[] {
  const page = doc.page(opts.page);
  const tokens = new TokenResolver(doc.data.tokens);
  const modes = opts.modes ?? ['light', 'dark', ...Object.keys(tokens.themes)];
  const issues: LintIssue[] = [];
  const add = (i: LintIssue) => issues.push(i);

  const colorTokens = tokens.group('color').filter((t) => typeof tokens.resolve(t.path) === 'string' && !/\.(\d+)$/.test(t.path) && t.path !== 'color.white');
  const spaceSteps = tokens.group('space').map((t) => ({ path: t.path, v: tokens.resolve(t.path) as number }));
  const radiusSteps = tokens.group('radius').map((t) => ({ path: t.path, v: tokens.resolve(t.path) as number }));

  const effective = (n: RNode): Style => {
    if (n.type === 'instance' && n.component) {
      const c = doc.data.components[n.component];
      if (c) return resolveInstance(n, c).style;
    }
    return n.style ?? {};
  };

  type Tint = { hex: string; alpha: number };
  /** colours a paint can show: one for solids, every stop for gradients; alpha 0–1 */
  const paintTints = (p: Paint | undefined, mode: string): Tint[] => {
    if (!p) return [];
    const one = (c: Paint): Tint | undefined => {
      if (isTokenRef(c)) {
        const v = tokens.resolve(c.token, mode);
        return typeof v === 'string' && v.startsWith('#') ? { hex: v, alpha: (c.alpha ?? 100) / 100 } : undefined;
      }
      if ('hex' in c) return { hex: c.hex, alpha: 1 };
      return undefined;
    };
    if ('gradient' in p) return p.gradient.stops.map((s) => one(s.color)).filter((t): t is Tint => !!t);
    if ('image' in p) return p.image.tint ? [one(p.image.tint)!].filter(Boolean) : [];
    const t = one(p);
    return t ? [t] : [];
  };
  const blend = (top: Tint, under: string): string => {
    if (top.alpha >= 1) return top.hex;
    const a = hexToRgb(top.hex), b = hexToRgb(under);
    const m = (x: number, y: number) => x * top.alpha + y * (1 - top.alpha);
    return rgbToHex({ r: m(a.r, b.r), g: m(a.g, b.g), b: m(a.b, b.b) });
  };

  /** every opaque colour that can sit behind n (gradient stops, alpha blended over ancestors) */
  const bgsOf = (n: RNode | undefined, mode: string): string[] => {
    let cur = n;
    while (cur) {
      const tints = paintTints(effective(cur).fill?.[0], mode);
      if (tints.length) {
        const parent = cur.parent ? page.nodes[cur.parent] : undefined;
        const under = tints.some((t) => t.alpha < 1) ? bgsOf(parent, mode) : [];
        return tints.flatMap((t) => (t.alpha >= 1 ? [t.hex] : under.map((u) => blend(t, u))));
      }
      cur = cur.parent ? page.nodes[cur.parent] : undefined;
    }
    return [(tokens.resolve('color.bg.canvas', mode) as string) ?? '#ffffff'];
  };

  const fgOf = (n: RNode, mode: string): Tint => {
    let cur: RNode | undefined = n;
    while (cur) {
      const t = paintTints(effective(cur).color, mode)[0];
      if (t) return t;
      cur = cur.parent ? page.nodes[cur.parent] : undefined;
    }
    return { hex: (tokens.resolve('color.text.primary', mode) as string) ?? '#000000', alpha: 1 };
  };

  const nearestColorToken = (hex: string): string | undefined => {
    let best: { path: string; d: number } | undefined;
    for (const t of colorTokens) {
      const v = tokens.resolve(t.path) as string;
      const d = deltaE(hex, v);
      if (!best || d < best.d) best = { path: t.path, d };
    }
    return best ? tokens.shortName(best.path, 'color') : undefined;
  };

  const nearestStep = (px: number, steps: { path: string; v: number }[]) => {
    let best = steps[0];
    for (const s of steps) if (best && Math.abs(s.v - px) < Math.abs(best.v - px)) best = s;
    return best;
  };

  const checkTokenRef = (n: RNode, ref: unknown, where: string) => {
    if (isTokenRef(ref) && !tokens.has(ref.token)) add({ code: 'D15', severity: 'P0', node: n.id, message: `${where} references missing token "${ref.token}"` });
  };

  const textSize = (n: RNode): { size: number; weight: number } => {
    const st = effective(n);
    let size = 14, weight = 400;
    if (st.textStyle) {
      const v = tokens.resolve(st.textStyle.token) as { fontSize?: number; fontWeight?: number } | undefined;
      if (v?.fontSize) size = v.fontSize;
      if (v?.fontWeight) weight = v.fontWeight;
    }
    if (typeof st.font?.size === 'number') size = st.font.size;
    if (st.font?.weight) weight = st.font.weight;
    return { size, weight };
  };

  const isCardLike = (s: Style) => !!(s.fill?.length && (s.stroke || s.shadow) && s.radius !== undefined);

  const roots = opts.roots ?? page.children;
  const textStyles = new Set<string>();
  const radii = new Set<string>();
  const primaryByRoot = new Map<string, string[]>();

  const visit = (id: string, rootId: string, cardDepth: number) => {
    const n = page.nodes[id];
    if (!n || n.hidden) return;
    const st = effective(n);

    // D15 missing tokens
    for (const p of st.fill ?? []) checkTokenRef(n, p, 'fill');
    checkTokenRef(n, st.color, 'color');
    checkTokenRef(n, st.stroke?.paint, 'stroke');
    checkTokenRef(n, st.textStyle, 'text style');
    checkTokenRef(n, st.radius, 'radius');
    checkTokenRef(n, n.layout?.gap, 'gap');

    // D01 raw colors
    const raw: [string, Paint | undefined][] = [['fill', n.style?.fill?.[0]], ['color', n.style?.color], ['stroke', n.style?.stroke?.paint]];
    for (const [prop, p] of raw) {
      if (p && !isTokenRef(p) && 'hex' in p) {
        const near = nearestColorToken(p.hex);
        add({ code: 'D01', severity: 'P2', node: n.id, message: `Hard-coded ${prop} ${p.hex}; use a color token${near ? ` (closest: ${near})` : ''}`, fix: near ? `set #${n.id} ${prop}:${near}` : undefined });
      }
      if (p && !isTokenRef(p) && 'gradient' in p) {
        add({ code: 'D06', severity: 'P2', node: n.id, message: `Gradient ${prop} — a common AI-slop tell in app UI. Use a solid surface/accent unless it is a deliberate brand moment.` });
      }
    }

    // D02 off-scale spacing
    const spaceVals: [string, Len | undefined][] = [['gap', n.layout?.gap], ...((n.layout?.padding ?? []).map((v, i) => [['pt', 'pr', 'pb', 'pl'][i]!, v] as [string, Len]))];
    for (const [prop, v] of spaceVals) {
      if (typeof v === 'number' && v !== 0) {
        const near = nearestStep(v, spaceSteps);
        const onScale = spaceSteps.some((s) => s.v === v);
        add({
          code: 'D02', severity: onScale ? 'P3' : 'P2', node: n.id,
          message: onScale ? `${prop} ${v}px is raw; use the token step` : `${prop} ${v}px is off the spacing scale (nearest ${near?.v}px)`,
          fix: near ? `set #${n.id} ${prop === 'gap' ? 'gap' : prop}${near.path.split('.').pop()}` : undefined,
        });
      }
    }

    // D14 off-scale radius
    if (typeof st.radius === 'number' && n.style?.radius === st.radius) {
      const near = nearestStep(st.radius, radiusSteps);
      if (!radiusSteps.some((s) => s.v === st.radius)) add({ code: 'D14', severity: 'P3', node: n.id, message: `radius ${st.radius}px off the radius scale`, fix: near ? `set #${n.id} r${near.path.split('.').pop()}` : undefined });
    }
    if (st.radius !== undefined && (n.type === 'frame' || n.type === 'instance')) radii.add(JSON.stringify(st.radius));

    // D04 nested cards
    // a card holds content: dots, swatches and floating badges/overlays are not nested cards
    const card = n.type === 'frame' && !n.absolute && !!n.children?.length && isCardLike(st);
    if (card && cardDepth > 0) add({ code: 'D04', severity: 'P2', node: n.id, message: 'Card nested inside a card. Use spacing or a divider instead of another box.' });

    // text checks
    const isTextual = n.type === 'text' || (n.type === 'instance' && n.component && (doc.data.components[n.component]?.tag === 'button' || doc.data.components[n.component]?.tag === 'span'));
    if (isTextual) {
      const { size, weight } = textSize(n);
      if (st.textStyle) textStyles.add(st.textStyle.token);
      else if (n.type === 'text') textStyles.add(`raw:${size}/${weight}`);
      if (size < 12) add({ code: 'D08', severity: 'P1', node: n.id, message: `Text ${size}px is too small to read comfortably (min 12px)` });
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      for (const mode of modes) {
        const tint = fgOf(n, mode);
        // worst case across everything that can sit behind the text
        let fg = tint.hex, bg = '', ratio = Infinity;
        for (const b of bgsOf(n, mode)) {
          const f = blend(tint, b);
          const r = contrastRatio(f, b);
          if (r < ratio) [ratio, fg, bg] = [r, f, b];
        }
        const min = large ? 3 : 4.5;
        if (ratio < min) {
          add({ code: 'D03', severity: 'P1', node: n.id, message: `Contrast ${ratio.toFixed(2)}:1 in ${mode} mode (${fg} on ${bg}) is below ${min}:1` });
          break;
        }
      }
    }

    // D09 one primary action / D10 unlabeled buttons
    if (n.type === 'instance' && (n.component === 'Button' || n.component === 'IconButton')) {
      const comp = doc.data.components[n.component]!;
      const v = { ...comp.defaults, ...(n.variant ?? {}) };
      if (n.component === 'Button' && v.variant === 'primary') primaryByRoot.set(rootId, [...(primaryByRoot.get(rootId) ?? []), n.id]);
      const label = n.props?.[comp.labelProp ?? 'label'];
      if ((label === undefined || label === '') && !n.props?.ariaLabel) add({ code: 'D10', severity: 'P1', node: n.id, message: `${n.component} has no accessible label (screen readers announce nothing) — add quoted text`, fix: `set #${n.id} "…"` });
    }

    // D12 empty frames
    if (n.type === 'frame' && !n.children?.length && !st.fill?.length && !st.stroke && !n.size?.w && !n.size?.h) {
      add({ code: 'D12', severity: 'P3', node: n.id, message: 'Empty frame with no size or fill — remove it or give it content' });
    }

    for (const c of n.children ?? []) visit(c, rootId, cardDepth + (card ? 1 : 0));
  };

  for (const r of roots) visit(r, r, 0);

  for (const [root, ids] of primaryByRoot) {
    if (ids.length > 1) add({ code: 'D09', severity: 'P1', node: ids[1]!, message: `${ids.length} primary buttons in #${root}. Keep one primary action; make the rest secondary/ghost.`, fix: ids.slice(1).map((id) => `set #${id} variant=secondary`).join('\n') });
  }
  // motion rules (M*) — only when linting the whole page, or for motion on the linted nodes
  const inScope = (target: string) => !opts.roots || target.startsWith('@') || [...doc.walk(roots, page.id)].some(({ node }) => target === `#${node.id}` || target.startsWith(`#${node.id}[`));
  const nonInteractive = (target: string) => {
    if (!target.startsWith('#')) return false;
    const n = page.nodes[target.slice(1).replace(/\[.*$/, '')];
    return !!n && n.type !== 'instance' && !n.role;
  };
  for (const m of lintMotion(doc.data.motion, doc.data.tokens, nonInteractive)) {
    if (!inScope(m.target)) continue;
    const motionNode = m.target.startsWith('#') ? m.target.slice(1).replace(/\[.*$/, '') : m.target;
    if (m.target.startsWith('#') && !page.nodes[motionNode]) continue;
    add({ code: m.code, severity: m.severity, node: motionNode, message: `motion ${m.target} ${m.message}` });
  }

  // icon references + icon-set consistency (I*), image checks (A*)
  for (const { node: n } of doc.walk(roots, page.id)) {
    if (n.icon && !findIcon(doc.data.icons, n.icon)) add({ code: 'D16', severity: 'P0', node: n.id, message: `references missing icon "${n.icon}"` });
    if (n.type !== 'image' || !n.image?.asset) continue;
    const meta = doc.data.assets?.[n.image.asset];
    if (!meta) {
      add({ code: 'A05', severity: 'P0', node: n.id, message: `references missing asset "${n.image.asset}"` });
      continue;
    }
    if (!n.image.decorative && !n.image.alt?.trim()) {
      add({ code: 'A01', severity: 'P1', node: n.id, message: `image "${meta.name}" has no alt text — describe what it shows (alt:"…"), or mark it decorative if it carries no meaning` });
    }
    if (meta.bytes > 300 * 1024) {
      add({ code: 'A02', severity: 'P2', node: n.id, message: `"${meta.name}" is ${formatBytes(meta.bytes)} — convert to WebP (~80 quality) and size it to its display size` });
    }
    const w = n.size?.w?.kind === 'fixed' && typeof n.size.w.v === 'number' ? n.size.w.v : undefined;
    const h = n.size?.h?.kind === 'fixed' && typeof n.size.h.v === 'number' ? n.size.h.v : undefined;
    if (w && meta.w < w) add({ code: 'A03', severity: 'P2', node: n.id, message: `shown at ${w}px wide but the image is only ${meta.w}px — it will look blurry` });
    else if (w && meta.w < w * 2) add({ code: 'A03', severity: 'P3', node: n.id, message: `${meta.w}px image shown at ${w}px — not sharp on 2× screens (use ≥ ${w * 2}px)` });
    if (w && h && (n.image.fit ?? 'cover') === 'fill') {
      const ratio = w / h, src = meta.w / meta.h;
      if (Math.abs(ratio - src) / src > 0.05) add({ code: 'A04', severity: 'P2', node: n.id, message: `fit:fill stretches a ${meta.w}×${meta.h} image into ${w}×${h} — use fit:cover or crop it`, fix: `set #${n.id} fit:cover` });
    }
  }
  if (!opts.roots) {
    // only sets actually in use, plus drafts, are worth reporting
    for (const i of lintIcons(doc.data.icons)) add({ code: i.code, severity: i.severity, node: `icon:${i.icon}`, message: `${i.icon} ${i.message}` });
  }

  // prototype rules (P*) — whole-page lint only
  if (!opts.roots) {
    const allInteractions = Object.values(doc.data.prototype?.interactions ?? {}).flat();
    const knownVars = new Set([...Object.keys(doc.data.prototype?.variables ?? {}), ...allInteractions.flatMap((i) => (i.action === 'set' ? Object.keys(i.variant ?? {}) : i.variable ? [i.variable] : []))]);
    for (const [node, list] of Object.entries(doc.data.prototype?.interactions ?? {})) {
      const n = page.nodes[node];
      if (!n) continue;
      for (const it of list) {
        for (const c of it.when ?? []) if (!knownVars.has(c.name)) add({ code: 'P04', severity: 'P2', node, message: `condition uses "${c.name}", which no interaction sets. Declare it with: proto var ${c.name}=value` });
        if (it.target && !page.nodes[it.target]) add({ code: 'P01', severity: 'P0', node, message: `${it.trigger} → ${it.action} targets #${it.target}, which no longer exists`, fix: `proto #${node} none` });
        if (it.action === 'play' && it.timeline && !doc.data.timelines?.[it.timeline]) add({ code: 'P01', severity: 'P0', node, message: `plays missing timeline "${it.timeline}"` });
      }
      const clickable = list.some((i) => i.trigger === 'click');
      const isControl = n.type === 'instance' && ['button', 'input', 'a'].includes(doc.data.components[n.component ?? '']?.tag ?? '');
      if (clickable && !isControl && !n.role) add({ code: 'P02', severity: 'P3', node, message: `"${n.name}" is clickable but not a button/link — give it role:button or use @Button so keyboard and screen-reader users can reach it` });
    }
    for (const tl of Object.values(doc.data.timelines ?? {})) {
      const missing = tl.tracks.filter((t) => !page.nodes[t.target]);
      if (missing.length) add({ code: 'P03', severity: 'P0', node: missing[0]!.target, message: `timeline "${tl.name}" animates missing node(s): ${missing.map((t) => `#${t.target}`).join(', ')}` });
      const total = timelineDuration(tl, doc.data.tokens);
      if (total > 1200) add({ code: 'M01', severity: 'P2', node: tl.tracks[0]?.target ?? '', message: `timeline "${tl.name}" runs ${total}ms — keep sequences under ~1s so people are not kept waiting` });
      const starts = [...new Set(tl.tracks.map((t) => t.at))].sort((a, b) => a - b);
      if (starts.length > 6) add({ code: 'M08', severity: 'P3', node: tl.tracks[0]?.target ?? '', message: `timeline "${tl.name}" staggers ${starts.length} steps — cap staggered reveals at ~6 items` });
    }
  }

  if (textStyles.size > 6) add({ code: 'D05', severity: 'P3', node: roots[0] ?? '', message: `${textStyles.size} different text styles in view — aim for ≤ 6 for a clear type scale` });
  if (radii.size > 4) add({ code: 'D07', severity: 'P3', node: roots[0] ?? '', message: `${radii.size} different corner radii — pick a consistent radius scale` });

  return issues.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.node.localeCompare(b.node));
}

/** Compact text form for agents: one line per issue. */
export function formatLint(issues: LintIssue[]): string {
  if (!issues.length) return 'No issues.';
  return issues.map((i) => `[${i.severity}] ${i.code} #${i.node} ${i.message}${i.fix ? `\n    fix: ${i.fix.replace(/\n/g, ' ; ')}` : ''}`).join('\n');
}
