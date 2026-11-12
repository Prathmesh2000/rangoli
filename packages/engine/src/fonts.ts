/**
 * Fonts: the Google Fonts catalogue, web-safe system fonts, and fonts a user adds to a document.
 * Loading is automatic: any family a design uses gets the right <link> or @font-face when rendered.
 */
import { GOOGLE_FONT_ROWS } from './fonts-catalog.js';
import type { RangoliDocument } from './document.js';
import type { TokenTree } from './model.js';
import { TokenResolver } from './tokens.js';

export type FontCategory = 'sans' | 'serif' | 'display' | 'handwriting' | 'mono';
export interface CatalogFont {
  family: string;
  category: FontCategory;
  /** [min, max] for variable fonts, otherwise the static weights */
  weights: number[];
  variable: boolean;
  italic: boolean;
  source: 'google' | 'system' | 'custom';
}

const CAT: Record<string, FontCategory> = { S: 'sans', R: 'serif', D: 'display', H: 'handwriting', M: 'mono' };
export const FONT_FALLBACK: Record<FontCategory, string> = { sans: 'sans-serif', serif: 'serif', display: 'sans-serif', handwriting: 'cursive', mono: 'monospace' };

let google: CatalogFont[] | undefined;
let byName: Map<string, CatalogFont> | undefined;

export function googleFonts(): CatalogFont[] {
  return (google ??= GOOGLE_FONT_ROWS.split('\n').map((row) => {
    const [family = '', c = 'S', w = '400'] = row.split('|');
    const italic = w.endsWith('i');
    const clean = italic ? w.slice(0, -1) : w;
    const variable = clean.includes('-');
    return { family, category: CAT[c] ?? 'sans', weights: clean.split(/[-,]/).map(Number), variable, italic, source: 'google' as const };
  }));
}

const sys = (family: string, category: FontCategory): CatalogFont => ({ family, category, weights: [400, 700], variable: false, italic: true, source: 'system' });
/** Installed on most machines: no download, always instant. */
export const SYSTEM_FONTS: CatalogFont[] = [
  sys('system-ui', 'sans'), sys('Arial', 'sans'), sys('Helvetica Neue', 'sans'), sys('Segoe UI', 'sans'), sys('Verdana', 'sans'), sys('Tahoma', 'sans'), sys('Trebuchet MS', 'sans'),
  sys('Georgia', 'serif'), sys('Times New Roman', 'serif'), sys('Palatino Linotype', 'serif'), sys('Cambria', 'serif'), sys('Garamond', 'serif'),
  sys('Courier New', 'mono'), sys('Consolas', 'mono'), sys('Menlo', 'mono'), sys('Lucida Console', 'mono'),
  sys('Impact', 'display'), sys('Arial Black', 'display'), sys('Comic Sans MS', 'handwriting'), sys('Brush Script MT', 'handwriting'),
];

export function findFont(name: string): CatalogFont | undefined {
  byName ??= new Map([...googleFonts(), ...SYSTEM_FONTS].map((f) => [f.family.toLowerCase(), f]));
  return byName.get(name.trim().replace(/^["']|["']$/g, '').toLowerCase());
}

/** Well-known display/body pairings, by display face. */
export const FONT_PAIRS: [string, string][] = [
  ['Playfair Display', 'Source Sans 3'], ['Space Grotesk', 'Inter'], ['Fraunces', 'Inter'], ['DM Serif Display', 'DM Sans'], ['Sora', 'Inter'], ['Poppins', 'Lora'],
  ['Merriweather', 'Open Sans'], ['Bricolage Grotesque', 'Figtree'], ['Instrument Serif', 'Instrument Sans'], ['Archivo Black', 'Roboto'], ['Oswald', 'Lato'], ['Syne', 'Manrope'],
];

// ---------------------------------------------------------------- fonts added to a document

export interface FontFace { src: string; weight?: string; style?: string }
type Ext = { $extensions?: { rangoli?: { fonts?: Record<string, FontFace[]> } } };

export const customFonts = (tree: TokenTree): Record<string, FontFace[]> => (tree as Ext).$extensions?.rangoli?.fonts ?? {};

const SAFE_SRC = /^(https:\/\/[^\s"'()<>\\]+|data:font\/[\w+.-]+;base64,[A-Za-z0-9+/=]+)$/;
/** A font source must be an https URL or an embedded font file; size is capped so documents stay small. */
export function validFontSrc(src: string): boolean {
  return src.length <= 2_000_000 && SAFE_SRC.test(src);
}

/** Copy of the token tree with a font family added (or removed when faces is null). */
export function withCustomFont(tree: TokenTree, family: string, faces: FontFace[] | null): TokenTree {
  const next = structuredClone(tree) as TokenTree & Ext;
  const rangoli = (((next.$extensions ??= {}) as NonNullable<Ext['$extensions']>).rangoli ??= {});
  const fonts = (rangoli.fonts ??= {});
  if (faces) fonts[family] = faces;
  else delete fonts[family];
  return next;
}

export function allFonts(tree: TokenTree): CatalogFont[] {
  const mine = Object.entries(customFonts(tree)).map(([family, faces]): CatalogFont => ({ family, category: 'sans', weights: faces.map((f) => Number(f.weight) || 400), variable: false, italic: faces.some((f) => f.style === 'italic'), source: 'custom' }));
  return [...mine, ...googleFonts(), ...SYSTEM_FONTS];
}

// ---------------------------------------------------------------- loading what a design uses

/** Every font family a document actually references (first loadable face of each stack). */
export function usedFonts(doc: RangoliDocument): string[] {
  const out = new Set<string>();
  const custom = customFonts(doc.data.tokens);
  const add = (v: unknown) => {
    const stack = Array.isArray(v) ? (v as string[]) : typeof v === 'string' ? v.split(',') : [];
    for (const raw of stack) {
      const name = String(raw).trim().replace(/^["']|["']$/g, '');
      if (!name || name.startsWith('var(')) return;
      const known = findFont(name);
      if (Object.hasOwn(custom, name) || known?.source === 'google') { out.add(name); return; }
      if (known) return; // an installed font comes first: nothing to download
    }
  };
  const r = new TokenResolver(doc.data.tokens);
  for (const t of r.group('font.family')) add(r.resolve(t.path));
  for (const page of Object.values(doc.data.pages)) for (const n of Object.values(page.nodes)) if (n.style?.font?.family) add(n.style.font.family);
  for (const c of Object.values(doc.data.components)) {
    for (const rule of c.styles) if (rule.style.font?.family) add(rule.style.font.family);
    for (const n of Object.values(c.template?.nodes ?? {})) if (n.style?.font?.family) add(n.style.font.family);
  }
  return [...out];
}

export function googleFontUrl(families: string[]): string | undefined {
  const parts = families.map(findFont).filter((f): f is CatalogFont => f?.source === 'google').map((f) => {
    const name = f.family.replace(/ /g, '+');
    if (f.variable) {
      const range = `${f.weights[0]}..${f.weights[1]}`;
      return f.italic ? `family=${name}:ital,wght@0,${range};1,${range}` : `family=${name}:wght@${range}`;
    }
    const ws = [...f.weights].sort((a, b) => a - b);
    if (ws.length === 1 && ws[0] === 400 && !f.italic) return `family=${name}`;
    return f.italic ? `family=${name}:ital,wght@${[...ws.map((w) => `0,${w}`), ...ws.map((w) => `1,${w}`)].join(';')}` : `family=${name}:wght@${ws.join(';')}`;
  });
  return parts.length ? `https://fonts.googleapis.com/css2?${parts.join('&')}&display=swap` : undefined;
}

/** Tiny request for showing a family's own name in a font list. */
export const fontPreviewUrl = (family: string) => `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}&text=${encodeURIComponent(family)}&display=swap`;

/** Where the app and the local server answer for third-party icons and fonts. Only those two serve it. */
export const ASSET_PROXY = '/api/asset-proxy';

const proxiedCss = (families: string[], extra = '') => {
  const google = families.filter((f) => findFont(f)?.source === 'google');
  return google.length ? `${ASSET_PROXY}/fonts/css?${google.map((f) => `family=${encodeURIComponent(f)}`).join('&')}${extra}` : undefined;
};
/** googleFontUrl through the same-origin proxy: names only, for pages the server hands out. */
export const proxiedFontUrl = (families: string[]): string | undefined => proxiedCss(families);
/** fontPreviewUrl through the same-origin proxy. */
export const proxiedFontPreviewUrl = (family: string): string => `${ASSET_PROXY}/fonts/css?family=${encodeURIComponent(family)}&preview=1`;

/**
 * Stylesheet links and @font-face rules for the fonts a document uses.
 * Links go straight to Google unless `proxied` is set, because an exported page has no server behind it.
 */
export function fontHead(doc: RangoliDocument, opts: { proxied?: boolean } = {}): { links: string[]; css: string } {
  const used = usedFonts(doc);
  const custom = customFonts(doc.data.tokens);
  const links: string[] = [];
  const isCustom = (f: string) => Object.hasOwn(custom, f);
  const google = used.filter((f) => !isCustom(f));
  for (let i = 0; i < google.length; i += 24) {
    const part = google.slice(i, i + 24);
    const url = opts.proxied ? proxiedFontUrl(part) : googleFontUrl(part);
    if (url) links.push(url);
  }
  const css = used
    .filter(isCustom)
    .flatMap((family) => custom[family]!.filter((f) => validFontSrc(f.src)).map((f) => `@font-face{font-family:"${family.replace(/["\\<>{};\n\r\f]/g, '')}";src:url("${f.src}");font-weight:${/^\d{3}$/.test(f.weight ?? '') ? f.weight : 400};font-style:${f.style === 'italic' ? 'italic' : 'normal'};font-display:swap}`))
    .join('\n');
  return { links, css };
}
