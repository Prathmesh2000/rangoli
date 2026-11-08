import { generateNeutralRamp, generateRamp, RAMP_STEPS } from './color.js';
import { isTokenLeaf, type TokenLeaf, type TokenTree } from './model.js';

export type Mode = string; // 'light' | 'dark' | 'highContrast' | 'reduced' ...

export interface FlatToken {
  path: string;
  type?: string;
  value: unknown;
  modes?: Record<string, unknown>;
  description?: string;
}

/** Flatten a DTCG tree into path → token. Group-level $type is inherited. */
export function flattenTokens(tree: TokenTree, prefix = '', inheritedType?: string, out = new Map<string, FlatToken>()): Map<string, FlatToken> {
  const groupType = (tree as { $type?: string }).$type ?? inheritedType;
  for (const [key, val] of Object.entries(tree)) {
    if (key.startsWith('$')) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isTokenLeaf(val)) {
      out.set(path, {
        path,
        type: val.$type ?? groupType,
        value: val.$value,
        modes: val.$extensions?.rangoli?.modes,
        description: val.$description,
      });
    } else if (typeof val === 'object' && val) {
      flattenTokens(val as TokenTree, path, groupType, out);
    }
  }
  return out;
}

const ALIAS = /^\{([^}]+)\}$/;

export class TokenResolver {
  readonly flat: Map<string, FlatToken>;
  constructor(tree: TokenTree) {
    this.flat = flattenTokens(tree);
  }

  has(path: string): boolean {
    return this.flat.has(path);
  }

  /** Resolve a token's final value for a mode, following aliases. */
  resolve(path: string, mode: Mode = 'light', seen = new Set<string>()): unknown {
    const t = this.flat.get(path);
    if (!t) return undefined;
    if (seen.has(path)) throw new Error(`Token alias cycle at ${path}`);
    seen.add(path);
    const raw = t.modes && mode in t.modes ? t.modes[mode] : t.value;
    return this.resolveValue(raw, mode, seen);
  }

  private resolveValue(raw: unknown, mode: Mode, seen: Set<string>): unknown {
    if (typeof raw === 'string') {
      const m = ALIAS.exec(raw);
      if (m) return this.resolve(m[1]!, mode, seen);
      return raw;
    }
    if (Array.isArray(raw)) return raw.map((v) => this.resolveValue(v, mode, new Set(seen)));
    if (raw && typeof raw === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) o[k] = this.resolveValue(v, mode, new Set(seen));
      return o;
    }
    return raw;
  }

  /**
   * Find a token from shorthand used in RDL. e.g. find('surface','color') → 'color.bg.surface'.
   * Resolution order: exact path, group.short, group.short.default, unique suffix match.
   */
  find(short: string, group?: string): string | undefined {
    const cands = [short];
    if (group) cands.push(`${group}.${short}`, `${group}.${short}.default`);
    for (const c of cands) if (this.flat.has(c)) return c;
    const prefix = group ? `${group}.` : '';
    const suffix = [...this.flat.keys()].filter(
      (p) => p.startsWith(prefix) && (p.endsWith(`.${short}`) || p.endsWith(`.${short}.default`)),
    );
    suffix.sort((a, b) => a.length - b.length);
    return suffix[0];
  }

  /** All tokens under a group prefix. */
  group(prefix: string): FlatToken[] {
    return [...this.flat.values()].filter((t) => t.path === prefix || t.path.startsWith(`${prefix}.`));
  }

  /** Shortest name usable in RDL for a path (inverse of find). */
  shortName(path: string, group: string): string {
    const parts = path.split('.');
    if (parts[parts.length - 1] === 'default') parts.pop();
    for (let i = parts.length - 1; i >= 1; i--) {
      const short = parts.slice(i).join('.');
      if (this.find(short, group) === path) return short;
    }
    return path;
  }
}

export const cssVarName = (path: string) => `--${path.replace(/\./g, '-')}`;

/** Export tokens as CSS custom properties, one block per mode. */
export function tokensToCss(tree: TokenTree, modes: Mode[] = ['light', 'dark']): string {
  const r = new TokenResolver(tree);
  const blocks: string[] = [];
  modes.forEach((mode, i) => {
    const lines: string[] = [];
    for (const t of r.flat.values()) {
      if (i > 0 && !(t.modes && mode in t.modes) && !dependsOnMode(r, t.path, mode)) continue;
      const v = r.resolve(t.path, mode);
      const css = tokenValueToCss(v, t.type);
      if (css !== undefined) lines.push(`  ${cssVarName(t.path)}: ${css};`);
    }
    if (!lines.length) return;
    const sel = i === 0 ? ':root' : `[data-mode="${mode}"]`;
    blocks.push(`${sel} {\n${lines.join('\n')}\n}`);
  });
  return blocks.join('\n\n') + '\n';
}

function dependsOnMode(r: TokenResolver, path: string, mode: Mode, depth = 0): boolean {
  if (depth > 20) return false;
  const t = r.flat.get(path);
  if (!t) return false;
  if (t.modes && mode in t.modes) return true;
  if (typeof t.value === 'string') {
    const m = ALIAS.exec(t.value);
    if (m) return dependsOnMode(r, m[1]!, mode, depth + 1);
  }
  return false;
}

export function tokenValueToCss(v: unknown, type?: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (type === 'dimension' && typeof v === 'number') return `${v}px`;
  if (type === 'duration' && typeof v === 'number') return `${v}ms`;
  if (type === 'cubicBezier' && Array.isArray(v)) return `cubic-bezier(${v.join(', ')})`;
  if (type === 'fontFamily' && Array.isArray(v)) return v.join(', ');
  if (type === 'typography' && typeof v === 'object') {
    const t = v as { fontSize?: number; lineHeight?: number | string; fontWeight?: number; fontFamily?: string | string[] };
    const fam = Array.isArray(t.fontFamily) ? t.fontFamily.join(', ') : t.fontFamily ?? 'inherit';
    const lh = typeof t.lineHeight === 'number' && t.lineHeight > 3 ? `${t.lineHeight}px` : t.lineHeight ?? 'normal';
    return `${t.fontWeight ?? 400} ${t.fontSize ?? 14}px/${lh} ${fam}`;
  }
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  return undefined;
}

// ---------------- default token set ----------------

const leaf = (value: unknown, type?: string, modes?: Record<string, unknown>, description?: string): TokenLeaf => ({
  $value: value,
  ...(type ? { $type: type } : {}),
  ...(description ? { $description: description } : {}),
  ...(modes ? { $extensions: { rangoli: { modes } } } : {}),
});

function rampGroup(ramp: Record<number, string>): TokenTree {
  const g: TokenTree = { $type: 'color' } as unknown as TokenTree;
  for (const s of RAMP_STEPS) g[String(s)] = leaf(ramp[s]);
  return g;
}

export interface DefaultTokenOptions {
  brand?: string;
  success?: string;
  warning?: string;
  error?: string;
  fontSans?: string[];
  fontMono?: string[];
}

/**
 * A calm, professional default system. Deliberately NOT indigo/violet.
 * Every value can be regenerated from a brand seed.
 */
export function defaultTokens(opts: DefaultTokenOptions = {}): TokenTree {
  const brand = opts.brand ?? '#2a6fb0';
  const primary = generateRamp(brand);
  const neutral = generateNeutralRamp(brand);
  const success = generateRamp(opts.success ?? '#2f9e57');
  const warning = generateRamp(opts.warning ?? '#d9900f');
  const error = generateRamp(opts.error ?? '#d63c3c');
  const ref = (p: string) => `{${p}}`;
  const sem = (light: string, dark: string, desc?: string) => leaf(ref(light), 'color', { dark: ref(dark) }, desc);

  return {
    color: {
      primary: rampGroup(primary),
      neutral: rampGroup(neutral),
      success: rampGroup(success),
      warning: rampGroup(warning),
      error: rampGroup(error),
      white: leaf('#ffffff', 'color'),
      bg: {
        canvas: sem('color.neutral.50', 'color.neutral.950', 'App background'),
        surface: leaf(ref('color.white'), 'color', { dark: ref('color.neutral.900') }, 'Cards, panels, inputs'),
        subtle: sem('color.neutral.100', 'color.neutral.800', 'Hover rows, wells'),
        selected: sem('color.primary.50', 'color.primary.900'),
        inverse: sem('color.neutral.900', 'color.neutral.50'),
      },
      border: {
        default: sem('color.neutral.200', 'color.neutral.700'),
        strong: sem('color.neutral.300', 'color.neutral.600'),
        focus: sem('color.primary.500', 'color.primary.400'),
      },
      text: {
        primary: sem('color.neutral.900', 'color.neutral.50'),
        secondary: sem('color.neutral.600', 'color.neutral.300'),
        muted: leaf(ref('color.text.secondary'), 'color'),
        disabled: sem('color.neutral.400', 'color.neutral.500'),
        onPrimary: leaf(ref('color.white'), 'color'),
        link: sem('color.primary.700', 'color.primary.300'),
      },
      action: {
        primary: sem('color.primary.600', 'color.primary.400'),
        primaryHover: sem('color.primary.700', 'color.primary.300'),
        secondaryHover: sem('color.neutral.100', 'color.neutral.800'),
      },
      status: {
        success: { fg: sem('color.success.700', 'color.success.300'), bg: sem('color.success.50', 'color.success.900') },
        warning: { fg: sem('color.warning.800', 'color.warning.300'), bg: sem('color.warning.50', 'color.warning.900') },
        error: { fg: sem('color.error.700', 'color.error.300'), bg: sem('color.error.50', 'color.error.900') },
        info: { fg: sem('color.primary.700', 'color.primary.300'), bg: sem('color.primary.50', 'color.primary.900') },
        neutral: { fg: sem('color.neutral.700', 'color.neutral.300'), bg: sem('color.neutral.100', 'color.neutral.800') },
      },
    },
    space: {
      $type: 'dimension',
      '0': leaf(0), '0.5': leaf(2), '1': leaf(4), '1.5': leaf(6), '2': leaf(8), '3': leaf(12), '4': leaf(16),
      '5': leaf(20), '6': leaf(24), '8': leaf(32), '10': leaf(40), '12': leaf(48), '16': leaf(64), '24': leaf(96),
    } as unknown as TokenTree,
    radius: {
      $type: 'dimension',
      '0': leaf(0), '1': leaf(4), '2': leaf(6), '3': leaf(8), '4': leaf(12), '5': leaf(16), full: leaf(9999),
    } as unknown as TokenTree,
    font: {
      family: {
        sans: leaf(opts.fontSans ?? ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'], 'fontFamily'),
        mono: leaf(opts.fontMono ?? ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'], 'fontFamily'),
      },
    },
    textStyle: {
      $type: 'typography',
      caption: leaf({ fontFamily: '{font.family.sans}', fontSize: 12, lineHeight: 16, fontWeight: 400 }),
      label: leaf({ fontFamily: '{font.family.sans}', fontSize: 13, lineHeight: 16, fontWeight: 500 }),
      'body-sm': leaf({ fontFamily: '{font.family.sans}', fontSize: 13, lineHeight: 20, fontWeight: 400 }),
      body: leaf({ fontFamily: '{font.family.sans}', fontSize: 14, lineHeight: 20, fontWeight: 400 }),
      'body-lg': leaf({ fontFamily: '{font.family.sans}', fontSize: 16, lineHeight: 24, fontWeight: 400 }),
      'title-sm': leaf({ fontFamily: '{font.family.sans}', fontSize: 16, lineHeight: 24, fontWeight: 600 }),
      title: leaf({ fontFamily: '{font.family.sans}', fontSize: 20, lineHeight: 28, fontWeight: 600, letterSpacing: '-0.01em' }),
      headline: leaf({ fontFamily: '{font.family.sans}', fontSize: 24, lineHeight: 32, fontWeight: 600, letterSpacing: '-0.015em' }),
      display: leaf({ fontFamily: '{font.family.sans}', fontSize: 30, lineHeight: 38, fontWeight: 600, letterSpacing: '-0.02em' }),
      code: leaf({ fontFamily: '{font.family.mono}', fontSize: 13, lineHeight: 20, fontWeight: 400 }),
    } as unknown as TokenTree,
    shadow: {
      $type: 'shadow',
      sm: leaf('0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.10)', undefined, { dark: '0 1px 2px rgba(0,0,0,.4)' }),
      md: leaf('0 4px 8px -2px rgba(16,24,40,.08), 0 2px 4px -2px rgba(16,24,40,.06)', undefined, { dark: '0 4px 8px rgba(0,0,0,.45)' }),
      lg: leaf('0 12px 16px -4px rgba(16,24,40,.08), 0 4px 6px -2px rgba(16,24,40,.03)', undefined, { dark: '0 12px 24px rgba(0,0,0,.5)' }),
    } as unknown as TokenTree,
    motion: {
      duration: {
        $type: 'duration',
        instant: leaf(0), fast: leaf(120, undefined, { reduced: 0 }), base: leaf(200, undefined, { reduced: 0 }),
        slow: leaf(300, undefined, { reduced: 0 }), panel: leaf(350, undefined, { reduced: 0 }),
      } as unknown as TokenTree,
      easing: {
        $type: 'cubicBezier',
        out: leaf([0.2, 0, 0, 1]), in: leaf([0.3, 0, 0.8, 0.15]), inOut: leaf([0.65, 0, 0.35, 1]),
        drawer: leaf([0.32, 0.72, 0, 1]), linear: leaf([0, 0, 1, 1]),
      } as unknown as TokenTree,
      spring: {
        snappy: leaf({ stiffness: 400, damping: 40 }, 'spring'),
        gentle: leaf({ stiffness: 200, damping: 30 }, 'spring'),
      },
      distance: { $type: 'dimension', sm: leaf(4), md: leaf(8), lg: leaf(16) } as unknown as TokenTree,
      scale: { press: leaf(0.97, 'number'), popIn: leaf(0.96, 'number') },
    },
  };
}
