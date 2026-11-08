/**
 * Deterministic design linter. Same input → same output. No AI.
 * Codes: D01–D15 (design). Motion rules M01–M14 arrive with the motion engine (Phase 2).
 */
import { contrastRatio, deltaE } from './color.js';
import { resolveInstance } from './components.js';
import type { RangoliDocument } from './document.js';
import { isTokenRef, type Len, type Paint, type RNode, type Style } from './model.js';
import { TokenResolver } from './tokens.js';

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
  const modes = opts.modes ?? ['light', 'dark'];
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

  const paintHex = (p: Paint | undefined, mode: string): string | undefined => {
    if (!p) return undefined;
    if (isTokenRef(p)) {
      const v = tokens.resolve(p.token, mode);
      return typeof v === 'string' && v.startsWith('#') ? v : undefined;
    }
    if ('hex' in p) return p.hex;
    return undefined;
  };

  const bgOf = (n: RNode, mode: string): string => {
    let cur: RNode | undefined = n;
    while (cur) {
      const fill = effective(cur).fill;
      if (fill?.length) {
        const hex = paintHex(fill[0], mode);
        if (hex) return hex;
      }
      cur = cur.parent ? page.nodes[cur.parent] : undefined;
    }
    return (tokens.resolve('color.bg.canvas', mode) as string) ?? '#ffffff';
  };

  const fgOf = (n: RNode, mode: string): string => {
    let cur: RNode | undefined = n;
    while (cur) {
      const c = effective(cur).color;
      if (c) {
        const hex = paintHex(c, mode);
        if (hex) return hex;
      }
      cur = cur.parent ? page.nodes[cur.parent] : undefined;
    }
    return (tokens.resolve('color.text.primary', mode) as string) ?? '#000000';
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
    const card = n.type === 'frame' && isCardLike(st);
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
        const fg = fgOf(n, mode);
        const bg = bgOf(n, mode);
        const ratio = contrastRatio(fg, bg);
        const min = large ? 3 : 4.5;
        if (ratio < min) {
          add({ code: 'D03', severity: 'P1', node: n.id, message: `Contrast ${ratio.toFixed(2)}:1 in ${mode} mode (${fg} on ${bg}) is below ${min}:1` });
          break;
        }
      }
    }

    // D09 one primary action / D10 unlabeled buttons
    if (n.type === 'instance' && n.component === 'Button') {
      const comp = doc.data.components.Button!;
      const v = { ...comp.defaults, ...(n.variant ?? {}) };
      if (v.variant === 'primary') primaryByRoot.set(rootId, [...(primaryByRoot.get(rootId) ?? []), n.id]);
      const label = n.props?.[comp.labelProp ?? 'label'];
      if ((label === undefined || label === '') && !n.props?.ariaLabel) add({ code: 'D10', severity: 'P1', node: n.id, message: 'Button has no text label or ariaLabel (screen readers announce nothing)', fix: `set #${n.id} ariaLabel="…"` });
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
  if (textStyles.size > 6) add({ code: 'D05', severity: 'P3', node: roots[0] ?? '', message: `${textStyles.size} different text styles in view — aim for ≤ 6 for a clear type scale` });
  if (radii.size > 4) add({ code: 'D07', severity: 'P3', node: roots[0] ?? '', message: `${radii.size} different corner radii — pick a consistent radius scale` });

  return issues.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.node.localeCompare(b.node));
}

/** Compact text form for agents: one line per issue. */
export function formatLint(issues: LintIssue[]): string {
  if (!issues.length) return 'No issues.';
  return issues.map((i) => `[${i.severity}] ${i.code} #${i.node} ${i.message}${i.fix ? `\n    fix: ${i.fix.replace(/\n/g, ' ; ')}` : ''}`).join('\n');
}
