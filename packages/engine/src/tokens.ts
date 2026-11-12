import { generateNeutralRamp, generateRamp, RAMP_STEPS } from './color.js';
import { isTokenLeaf, type TokenLeaf, type TokenTree } from './model.js';
import { isSafeCssValue, isSafeKey, tokenModeError, tokenPathError } from './safety.js';

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
  readonly themes: Record<string, { base: string }>;
  constructor(tree: TokenTree) {
    this.flat = flattenTokens(tree);
    this.themes = (tree as { $extensions?: { rangoli?: { themes?: Record<string, { base: string }> } } }).$extensions?.rangoli?.themes ?? {};
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
    // a custom theme falls back to its base mode, then to the default value
    const base = this.themes[mode]?.base;
    const raw = t.modes && Object.hasOwn(t.modes, mode) ? t.modes[mode] : base && t.modes && Object.hasOwn(t.modes, base) ? t.modes[base] : t.value;
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

/** Anything that is not a name character becomes "-", so a stored path cannot break out of var(). */
export const cssVarName = (path: string) => `--${path.replace(/[^\p{L}\p{N}_-]/gu, '-')}`;

/** Export tokens as CSS custom properties, one block per mode. */
export function tokensToCss(tree: TokenTree, modes?: Mode[]): string {
  const r = new TokenResolver(tree);
  modes = (modes ?? ['light', 'dark', ...Object.keys(r.themes)]).filter((m) => !tokenModeError(m)); // mode names become selectors
  const light = (p: string) => JSON.stringify(r.resolve(p, 'light'));
  const blocks: string[] = [];
  modes.forEach((mode, i) => {
    const lines: string[] = [];
    for (const t of r.flat.values()) {
      if (r.themes[mode]) { if (JSON.stringify(r.resolve(t.path, mode)) === light(t.path)) continue; }
      else if (i > 0 && !(t.modes && mode in t.modes) && !dependsOnMode(r, t.path, mode)) continue;
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

const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'inherit']);
/** CSS font stack; quotes names that are not plain identifiers ("Source Serif 4", "Segoe UI") */
export function fontStack(list: string[]): string {
  return list.map((f) => (GENERIC_FONTS.has(f) || f.startsWith('-') || /^[A-Za-z][\w-]*$/.test(f) ? f : `"${f.replace(/"/g, '')}"`)).join(', ');
}

/** CSS for a resolved token value. Values that are unsafe in a <style> element are dropped. */
export function tokenValueToCss(v: unknown, type?: string): string | undefined {
  const css = rawTokenCss(v, type);
  return css !== undefined && isSafeCssValue(css) ? css : undefined;
}

function rawTokenCss(v: unknown, type?: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (type === 'dimension' && typeof v === 'number') return `${v}px`;
  if (type === 'duration' && typeof v === 'number') return `${v}ms`;
  if (type === 'cubicBezier' && Array.isArray(v)) return `cubic-bezier(${v.join(', ')})`;
  if (type === 'fontFamily' && Array.isArray(v)) return fontStack(v as string[]);
  if (type === 'typography' && typeof v === 'object') {
    const t = v as { fontSize?: number; lineHeight?: number | string; fontWeight?: number; fontFamily?: string | string[] };
    const fam = Array.isArray(t.fontFamily) ? fontStack(t.fontFamily) : t.fontFamily ?? 'inherit';
    const lh = typeof t.lineHeight === 'number' && t.lineHeight > 3 ? `${t.lineHeight}px` : t.lineHeight ?? 'normal';
    return `${t.fontWeight ?? 400} ${t.fontSize ?? 14}px/${lh} ${fam}`;
  }
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  return undefined;
}

// ---------------- validating token writes ----------------

const TOKEN_KEY = /^[\p{L}\p{N}_.-]+$/u; // scale steps such as "0.5" are single keys
const FONT_NAME = /^[^<>\\{};"\x00-\x1f]+$/;
const TOKEN_VALUE: Record<string, RegExp> = {
  color: /^(#[0-9a-f]{3,8}|[a-z]+|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|var)\(.+\))$/i,
  dimension: /^(-?(\d+\.?\d*|\.\d+)[a-z%]*|[a-z-]+|(?:calc|min|max|clamp|var)\(.+\))$/i,
  duration: /^((\d+\.?\d*|\.\d+)m?s|var\(.+\))$/i,
  number: /^(-?(\d+\.?\d*|\.\d+)|var\(.+\))$/i,
  fontWeight: /^(\d{1,4}|[a-z-]+|var\(.+\))$/i,
  fontFamily: /^[\p{L}\p{N}\s,'"_.()-]+$/u,
  shadow: /^[\w\s.,%#()/-]+$/,
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s);

function deepKeyError(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  for (const [k, x] of Object.entries(v)) {
    if (!isSafeKey(k)) return `"${k}" is a reserved name`;
    const e = deepKeyError(x);
    if (e) return e;
  }
  return undefined;
}

function tokenValueError(v: unknown, type?: string): string | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? undefined : 'must be a finite number';
  if (v === null || typeof v === 'boolean') return undefined;
  if (typeof v === 'string') {
    const alias = ALIAS.exec(v);
    if (alias) return tokenPathError(alias[1]!);
    if (!isSafeCssValue(v)) return `"${clip(v)}" is not a safe CSS value`;
    const shape = type ? TOKEN_VALUE[type] : undefined;
    return shape && !shape.test(v) ? `"${clip(v)}" is not a valid ${type}` : undefined;
  }
  if (Array.isArray(v)) {
    for (const x of v) {
      // font lists are quoted on output, so a name may hold an apostrophe
      const e = type === 'fontFamily' && typeof x === 'string' && !ALIAS.test(x) ? (FONT_NAME.test(x) ? undefined : `"${clip(x)}" is not a valid font name`) : tokenValueError(x);
      if (e) return e;
    }
    return undefined;
  }
  if (isObj(v)) {
    for (const x of Object.values(v)) {
      const e = tokenValueError(x);
      if (e) return e;
    }
    return undefined;
  }
  return 'has an unsupported type';
}

function tokenLeafError(path: string, leaf: TokenLeaf, type?: string): string | undefined {
  const keys = deepKeyError(leaf);
  if (keys) return `Token ${path}: ${keys}`;
  const value = tokenValueError(leaf.$value, type);
  if (value) return `Token ${path}: ${value}`;
  for (const [mode, v] of Object.entries(leaf.$extensions?.rangoli?.modes ?? {})) {
    const e = tokenModeError(mode) ?? tokenValueError(v, type);
    if (e) return `Token ${path} [${clip(mode)}]: ${e}`;
  }
  return undefined;
}

/**
 * Why a token tree cannot be stored, or undefined when it can. Only what differs from `prev` is checked,
 * so a value saved before validation existed cannot block edits to other tokens.
 */
export function tokenTreeError(tree: TokenTree, prev?: TokenTree, path = '', inherited?: string): string | undefined {
  const node = tree as unknown as Record<string, unknown>;
  const groupType = typeof node.$type === 'string' ? node.$type : inherited;
  for (const [key, val] of Object.entries(node)) {
    const before = isObj(prev) && Object.hasOwn(prev, key) ? (prev as unknown as Record<string, unknown>)[key] : undefined;
    if (JSON.stringify(val) === JSON.stringify(before)) continue;
    const where = path ? `${path}.${key}` : key;
    if (!isSafeKey(key)) return `Token key "${where}" uses a reserved name`;
    if (key.startsWith('$')) {
      const e = deepKeyError(val);
      if (e) return `${where}: ${e}`;
      continue;
    }
    if (!TOKEN_KEY.test(key)) return `Token key "${clip(where)}" is invalid (use letters, numbers, _ and -)`;
    if (isTokenLeaf(val)) {
      const e = tokenLeafError(where, val, val.$type ?? groupType);
      if (e) return e;
    } else if (isObj(val)) {
      const e = tokenTreeError(val as unknown as TokenTree, before as TokenTree | undefined, where, groupType);
      if (e) return e;
    }
  }
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
  /** headings/display face (defaults to fontSans) */
  fontDisplay?: string[];
  /** neutral ramp: hue seed (defaults to brand) and tint strength */
  neutralSeed?: string;
  neutralTint?: number;
  /** radius steps 1–5 in px */
  radius?: [number, number, number, number, number];
  /** radius role for controls (buttons, inputs) and surfaces (cards, alerts, dialogs): a step key or 'full' */
  radiusControl?: string;
  radiusCard?: string;
  /** control heights (density) */
  controls?: { xs: number; sm: number; md: number; lg: number };
  /** text styles: overrides on top of the default scale */
  type?: Partial<Record<TextStyleName, TypeSpec>>;
  /** elevation: CSS box-shadow per level, [light, dark] */
  shadows?: Record<'sm' | 'md' | 'lg', [string, string]>;
  /** motion: duration multiplier (1 = default) and standard ease-out curve */
  motionSpeed?: number;
  easeOut?: [number, number, number, number];
  /** shadow under buttons and fields, [light, dark] (default: none) */
  controlShadow?: [string, string];
  /** near-black borders instead of soft greys (brutalist, high-contrast) */
  inkBorders?: boolean;
}

export type TextStyleName = 'caption' | 'label' | 'body-sm' | 'body' | 'body-lg' | 'title-sm' | 'title' | 'headline' | 'display' | 'code';
export interface TypeSpec {
  size?: number;
  line?: number;
  weight?: number;
  tracking?: string;
  /** which family: sans (default), display or mono */
  family?: 'sans' | 'display' | 'mono';
  textCase?: 'uppercase' | 'none';
}

export const DEFAULT_TYPE: Record<TextStyleName, TypeSpec> = {
  caption: { size: 12, line: 16, weight: 400 },
  label: { size: 13, line: 16, weight: 500 },
  'body-sm': { size: 13, line: 20, weight: 400 },
  body: { size: 14, line: 20, weight: 400 },
  'body-lg': { size: 16, line: 24, weight: 400 },
  'title-sm': { size: 16, line: 24, weight: 600 },
  title: { size: 20, line: 28, weight: 600, tracking: '-0.01em', family: 'display' },
  headline: { size: 24, line: 32, weight: 600, tracking: '-0.015em', family: 'display' },
  display: { size: 30, line: 38, weight: 600, tracking: '-0.02em', family: 'display' },
  code: { size: 13, line: 20, weight: 400, family: 'mono' },
};

export const DEFAULT_SHADOWS: Record<'sm' | 'md' | 'lg', [string, string]> = {
  sm: ['0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.10)', '0 1px 2px rgba(0,0,0,.4)'],
  md: ['0 4px 8px -2px rgba(16,24,40,.08), 0 2px 4px -2px rgba(16,24,40,.06)', '0 4px 8px rgba(0,0,0,.45)'],
  lg: ['0 12px 16px -4px rgba(16,24,40,.08), 0 4px 6px -2px rgba(16,24,40,.03)', '0 12px 24px rgba(0,0,0,.5)'],
};

/**
 * A calm, professional default system. Deliberately NOT indigo/violet.
 * Every value can be regenerated from a brand seed.
 */
export function defaultTokens(opts: DefaultTokenOptions = {}): TokenTree {
  const brand = opts.brand ?? '#2a6fb0';
  const primary = generateRamp(brand);
  const neutral = generateNeutralRamp(opts.neutralSeed ?? brand, opts.neutralTint);
  const success = generateRamp(opts.success ?? '#2f9e57');
  const warning = generateRamp(opts.warning ?? '#d9900f');
  const error = generateRamp(opts.error ?? '#d63c3c');
  const ref = (p: string) => `{${p}}`;
  const r = opts.radius ?? [4, 6, 8, 12, 16];
  const ctl = opts.controls ?? { xs: 24, sm: 32, md: 36, lg: 44 };
  const sh = opts.shadows ?? DEFAULT_SHADOWS;
  const ms = (v: number) => Math.round(v * (opts.motionSpeed ?? 1));
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
        track: sem('color.neutral.300', 'color.neutral.600', 'Off switch tracks, empty meters'),
      },
      border: {
        default: opts.inkBorders ? sem('color.neutral.900', 'color.neutral.100') : sem('color.neutral.200', 'color.neutral.700'),
        strong: opts.inkBorders ? sem('color.neutral.950', 'color.neutral.50') : sem('color.neutral.300', 'color.neutral.600'),
        focus: sem('color.primary.500', 'color.primary.400'),
      },
      text: {
        primary: sem('color.neutral.900', 'color.neutral.50'),
        // 700 (not 600) so secondary text also passes AA on bg.subtle (table headers, wells)
        secondary: sem('color.neutral.700', 'color.neutral.300'),
        muted: leaf(ref('color.text.secondary'), 'color'),
        disabled: sem('color.neutral.400', 'color.neutral.500'),
        onPrimary: leaf(ref('color.white'), 'color', { dark: ref('color.primary.950') }),
        onDanger: leaf(ref('color.white'), 'color', { dark: ref('color.error.950') }),
        link: sem('color.primary.700', 'color.primary.300'),
      },
      action: {
        primary: sem('color.primary.600', 'color.primary.400'),
        primaryHover: sem('color.primary.700', 'color.primary.300'),
        secondaryHover: sem('color.neutral.100', 'color.neutral.800'),
        danger: sem('color.error.600', 'color.error.400'),
        dangerHover: sem('color.error.700', 'color.error.300'),
      },
      // data viz: validated categorical order (fixed, never cycled or brand-generated), light and dark selected separately
      chart: {
        '1': leaf('#2a78d6', 'color', { dark: '#3987e5' }), '2': leaf('#eb6834', 'color', { dark: '#d95926' }),
        '3': leaf('#1baf7a', 'color', { dark: '#199e70' }), '4': leaf('#eda100', 'color', { dark: '#c98500' }),
        '5': leaf('#e87ba4', 'color', { dark: '#d55181' }), '6': leaf('#008300', 'color', { dark: '#008300' }),
        '7': leaf('#6250d6', 'color', { dark: '#9085e9' }), '8': leaf('#e34948', 'color', { dark: '#e66767' }),
        grid: sem('color.neutral.100', 'color.neutral.800', 'Hairline gridlines'),
        axis: sem('color.neutral.300', 'color.neutral.700', 'Baseline / axis'),
        // sequential (heatmaps): one hue; the lightest step is "near zero" and recedes toward the surface in both modes
        seq: {
          '1': leaf('#cde2fb', 'color', { dark: '#1c2a3d' }), '2': leaf('#9ec5f4', 'color', { dark: '#184f95' }),
          '3': leaf('#6da7ec', 'color', { dark: '#1c5cab' }), '4': leaf('#3987e5', 'color', { dark: '#256abf' }),
          '5': leaf('#256abf', 'color', { dark: '#3987e5' }), '6': leaf('#184f95', 'color', { dark: '#6da7ec' }),
          '7': leaf('#0d366b', 'color', { dark: '#9ec5f4' }),
        },
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
      '0': leaf(0), '1': leaf(r[0]), '2': leaf(r[1]), '3': leaf(r[2]), '4': leaf(r[3]), '5': leaf(r[4]), full: leaf(9999),
      control: leaf(ref(`radius.${opts.radiusControl ?? '2'}`), undefined, undefined, 'Buttons, inputs, selects'),
      card: leaf(ref(`radius.${opts.radiusCard ?? '3'}`), undefined, undefined, 'Cards, alerts, dialogs, toasts'),
    } as unknown as TokenTree,
    size: {
      control: {
        $type: 'dimension',
        xs: leaf(ctl.xs), sm: leaf(ctl.sm), md: leaf(ctl.md, undefined, undefined, 'Default control height'), lg: leaf(ctl.lg),
      } as unknown as TokenTree,
    },
    font: {
      family: {
        sans: leaf(opts.fontSans ?? ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'], 'fontFamily'),
        mono: leaf(opts.fontMono ?? ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'], 'fontFamily'),
        display: opts.fontDisplay ? leaf(opts.fontDisplay, 'fontFamily') : leaf(ref('font.family.sans'), 'fontFamily'),
      },
    },
    textStyle: {
      $type: 'typography',
      ...Object.fromEntries((Object.keys(DEFAULT_TYPE) as TextStyleName[]).map((k) => {
        const t = { ...DEFAULT_TYPE[k], ...opts.type?.[k] };
        return [k, leaf({
          fontFamily: `{font.family.${t.family ?? 'sans'}}`, fontSize: t.size, lineHeight: t.line, fontWeight: t.weight,
          ...(t.tracking ? { letterSpacing: t.tracking } : {}), ...(t.textCase && t.textCase !== 'none' ? { textCase: t.textCase } : {}),
        })];
      })),
    } as unknown as TokenTree,
    shadow: {
      $type: 'shadow',
      ...Object.fromEntries((['sm', 'md', 'lg'] as const).map((k) => [k, leaf(sh[k][0], undefined, { dark: sh[k][1] })])),
      // a zero shadow (not "none") so it can be combined with inside strokes
      control: leaf(opts.controlShadow?.[0] ?? '0 0 0 0 transparent', undefined, { dark: opts.controlShadow?.[1] ?? '0 0 0 0 transparent' }, 'Under buttons and fields'),
    } as unknown as TokenTree,
    motion: {
      duration: {
        $type: 'duration',
        instant: leaf(0), fast: leaf(ms(120), undefined, { reduced: 0 }), base: leaf(ms(200), undefined, { reduced: 0 }),
        slow: leaf(ms(300), undefined, { reduced: 0 }), panel: leaf(ms(350), undefined, { reduced: 0 }),
      } as unknown as TokenTree,
      easing: {
        $type: 'cubicBezier',
        out: leaf(opts.easeOut ?? [0.2, 0, 0, 1]), in: leaf([0.3, 0, 0.8, 0.15]), inOut: leaf([0.65, 0, 0.35, 1]),
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
