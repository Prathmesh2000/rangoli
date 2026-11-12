/**
 * Custom themes, beyond light and dark. A theme is a named mode over the same tokens: it stores only
 * what differs and falls back to its base (light or dark) for the rest. Four colours are enough to
 * derive a readable full theme; any single token can then be edited for that theme.
 */
import { contrastRatio, hexToRgb, rgbToHex } from './color.js';
import type { TokenTree } from './model.js';

export interface ThemeInfo { name: string; base: 'light' | 'dark' }
export interface ThemeSeeds { name?: string; bg: string; primary: string; surface?: string; text?: string }

type Ext = { $extensions?: { rangoli?: { themes?: Record<string, ThemeInfo> } } };
export const themesOf = (tree: TokenTree): Record<string, ThemeInfo> => (tree as Ext).$extensions?.rangoli?.themes ?? {};

export const THEME_PRESETS: Record<string, ThemeSeeds & { name: string }> = {
  midnight: { name: 'Midnight', bg: '#0b1020', surface: '#141a2e', primary: '#7aa2ff' },
  ocean: { name: 'Ocean', bg: '#06262f', surface: '#0b3440', primary: '#2dd4bf' },
  forest: { name: 'Forest', bg: '#0f1f17', surface: '#16291f', primary: '#6ee7a0' },
  sunset: { name: 'Sunset', bg: '#2a1420', surface: '#3a1b2a', primary: '#ff8a5c' },
  neon: { name: 'Neon', bg: '#07060f', surface: '#110f22', primary: '#22e6a8' },
  rose: { name: 'Rose', bg: '#fff1f3', surface: '#ffffff', primary: '#c2255c' },
  sepia: { name: 'Sepia', bg: '#f4ecd8', surface: '#fbf6e9', primary: '#8a5a2b' },
  mint: { name: 'Mint', bg: '#ecfaf4', surface: '#ffffff', primary: '#0b7a5b' },
  mono: { name: 'Mono', bg: '#f2f2f2', surface: '#ffffff', primary: '#111111' },
  contrast: { name: 'High contrast', bg: '#000000', surface: '#000000', text: '#ffffff', primary: '#ffd500' },
};

const mix = (a: string, b: string, t: number) => {
  const x = hexToRgb(a), y = hexToRgb(b);
  const m = (p: number, q: number) => p + (q - p) * t;
  return rgbToHex({ r: m(x.r, y.r), g: m(x.g, y.g), b: m(x.b, y.b) });
};
const readableOn = (bg: string) => (contrastRatio('#ffffff', bg) >= contrastRatio('#101014', bg) ? '#ffffff' : '#101014');
/** Move fg toward the strongest ink until it reads on bg. */
const ensure = (fg: string, bg: string, min: number) => {
  const ink = readableOn(bg);
  let out = fg;
  for (let t = 0.1; contrastRatio(out, bg) < min && t <= 1; t += 0.1) out = mix(fg, ink, t);
  return out;
};

/** Reserved names can never be theme ids. */
export const validThemeId = (id: string) => /^[a-z][\w-]*$/.test(id) && !['light', 'dark', 'reduced', 'constructor', 'prototype'].includes(id);

export function withTheme(tree: TokenTree, id: string, seeds: ThemeSeeds): TokenTree {
  const next = structuredClone(tree) as TokenTree & Ext;
  const { bg, primary } = seeds;
  const surface = seeds.surface ?? bg;
  const text = seeds.text ?? readableOn(surface);
  const base: ThemeInfo['base'] = contrastRatio('#ffffff', bg) >= contrastRatio('#000000', bg) ? 'dark' : 'light';
  const rangoli = (((next.$extensions ??= {}) as NonNullable<Ext['$extensions']>).rangoli ??= {});
  (rangoli.themes ??= {})[id] = { name: seeds.name ?? id, base };
  const action = ensure(primary, surface, 3);
  const onAction = readableOn(action);
  const values: Record<string, string> = {
    'color.bg.canvas': bg,
    'color.bg.surface': surface,
    'color.bg.subtle': mix(surface, text, 0.07),
    'color.bg.selected': mix(surface, action, 0.18),
    'color.bg.inverse': text,
    'color.bg.track': mix(surface, text, 0.28),
    'color.border.default': mix(surface, text, 0.16),
    'color.border.strong': mix(surface, text, 0.3),
    'color.border.focus': action,
    'color.text.primary': text,
    'color.text.secondary': ensure(mix(text, surface, 0.25), mix(surface, text, 0.07), 4.5),
    'color.text.disabled': mix(text, surface, 0.55),
    'color.text.onPrimary': onAction,
    'color.text.link': ensure(primary, surface, 4.5),
    'color.action.primary': action,
    'color.action.primaryHover': mix(action, text, 0.15),
    'color.action.secondaryHover': mix(surface, text, 0.07),
    'color.chart.grid': mix(surface, text, 0.1),
    'color.chart.axis': mix(surface, text, 0.26),
  };
  for (const [path, value] of Object.entries(values)) {
    let cur = next as unknown as Record<string, unknown>;
    for (const p of path.split('.')) cur = (cur?.[p] ?? undefined) as Record<string, unknown>;
    if (!cur) continue;
    const ext = (cur.$extensions ??= {}) as Record<string, Record<string, Record<string, unknown>>>;
    ((ext.rangoli ??= {}).modes ??= {})[id] = value;
  }
  return next;
}

export function withoutTheme(tree: TokenTree, id: string): TokenTree {
  const next = structuredClone(tree) as TokenTree & Ext;
  delete next.$extensions?.rangoli?.themes?.[id];
  const walk = (o: unknown) => {
    if (!o || typeof o !== 'object') return;
    const modes = (o as { $extensions?: { rangoli?: { modes?: Record<string, unknown> } } }).$extensions?.rangoli?.modes;
    if (modes) delete modes[id];
    for (const [k, v] of Object.entries(o)) if (!k.startsWith('$')) walk(v);
  };
  walk(next);
  return next;
}
