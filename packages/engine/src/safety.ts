/**
 * Shared checks for content that crosses a trust boundary: object keys chosen by callers, and strings
 * that end up inside CSS or a <style> element. Writes use these to reject bad input; the renderer uses
 * the same checks to drop bad values from documents that were stored before validation existed.
 */
import { isTokenRef, type Layout, type Paint, type Style } from './model.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
/** False for keys that reach Object.prototype when they index a plain object. */
export const isSafeKey = (key: string): boolean => !FORBIDDEN_KEYS.has(key);

const short = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s);

const TOKEN_SEGMENT = /^[\p{L}\p{N}_-]+$/u;

/** Why a dotted token path may not be walked into a token tree, or undefined when it is fine. */
export function tokenPathError(path: string): string | undefined {
  if (typeof path !== 'string' || !path || path.length > 200) return `Invalid token path "${short(String(path))}"`;
  for (const seg of path.split('.')) {
    if (!isSafeKey(seg)) return `Token path "${short(path)}" uses the reserved name "${seg}"`;
    if (!TOKEN_SEGMENT.test(seg)) return `Token path "${short(path)}" has an invalid segment "${short(seg)}" (use letters, numbers, _ and -)`;
  }
  return undefined;
}

/** Why a mode name is unusable (mode names become object keys and CSS selectors). */
export function tokenModeError(mode: string): string | undefined {
  return isSafeKey(mode) && /^[\w-]+$/.test(mode) ? undefined : `Invalid mode name "${short(String(mode))}"`;
}

/** Node ids become object keys, CSS class names and selectors. */
export const isSafeNodeId = (id: string): boolean => isSafeKey(id) && /^[\w-]+$/.test(id);

// Backslashes are refused outright: CSS escapes (u\72l) can spell any function name.
const UNSAFE_CSS = /[<>\\{};\x00-\x08\x0b\x0e-\x1f\x7f]|\/\*|@import|javascript:/i;
const URL_FUNCTION = /(?:url|src|image|image-set|cross-fade|element|paint|expression)\(/i;

function balanced(v: string): boolean {
  let depth = 0;
  let quote = '';
  for (const c of v) {
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\n' || c === '\r' || c === '\f') return false;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false;
  }
  return !quote && depth === 0;
}

/** One CSS value or declaration: cannot end its block or <style>, load a URL, or swallow what follows. */
export function isSafeCssValue(v: string): boolean {
  return typeof v === 'string' && !UNSAFE_CSS.test(v) && !URL_FUNCTION.test(v) && balanced(v);
}

/** Sanitise raw CSS declarations: no urls, imports, expressions, escapes or block syntax. */
export function sanitizeCss(css: string): string | undefined {
  const decls = css.split(';').map((d) => d.trim()).filter(Boolean);
  for (const d of decls) {
    if (!/^-?[a-z][a-z-]*\s*:\s*[^;{}<>\\]+$/i.test(d) || /expression|behavior|-moz-binding/i.test(d) || !isSafeCssValue(d)) return undefined;
  }
  return decls.join(';');
}

export const safeHex = (v: unknown): string | undefined => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : undefined);

const GRID_TEMPLATE = /^[\w\s.,%()+*/[\]-]+$/;
export const isSafeGridTemplate = (v: unknown): v is string => typeof v === 'string' && GRID_TEMPLATE.test(v) && isSafeCssValue(v);

export const SAFE_IMAGE_URL = /^https:\/\/[^\s"'()<>\\]+$/;
export const SAFE_IMAGE_POS = /^(center|top|bottom|left|right|[a-z]+-[a-z]+)$/;

function paintError(p: Paint | undefined | null): string | undefined {
  if (!p || typeof p !== 'object') return 'a paint must be a token, colour, gradient or image';
  if (isTokenRef(p)) return tokenPathError(p.token);
  if ('hex' in p) return safeHex(p.hex) ? undefined : `Invalid colour "${short(String(p.hex))}" (use #rrggbb or a token)`;
  if ('image' in p) {
    const m = p.image;
    if (m.url !== undefined && !SAFE_IMAGE_URL.test(m.url)) return 'Image paints only accept https URLs';
    if (m.pos !== undefined && !SAFE_IMAGE_POS.test(m.pos)) return `Invalid image position "${short(String(m.pos))}"`;
    if (!['cover', 'contain', 'tile'].includes(m.fit)) return `Invalid image fit "${short(String(m.fit))}"`;
    return m.tint ? paintError(m.tint) : undefined;
  }
  if ('gradient' in p && p.gradient) {
    const g = p.gradient;
    if (g.type !== 'linear' && g.type !== 'radial') return `Invalid gradient type "${short(String(g.type))}"`;
    if (g.angle !== undefined && !Number.isFinite(g.angle)) return 'A gradient angle must be a number';
    if (!Array.isArray(g.stops) || !g.stops.length) return 'A gradient needs colour stops';
    for (const s of g.stops) {
      if (!Number.isFinite(s.at)) return 'A gradient stop position must be a number';
      const e = paintError(s.color);
      if (e) return e;
    }
    return undefined;
  }
  return 'Unknown paint';
}

/** Why a node's style or layout fields cannot be stored, or undefined when they are fine. */
export function nodeFieldsError(n: { style?: Style | null; layout?: Layout | null }): string | undefined {
  const s = n.style;
  if (s) {
    const shadows = Array.isArray(s.shadow) ? s.shadow.map((x) => x.color) : [];
    for (const p of [...(s.fill ?? []), ...(s.stroke ? [s.stroke.paint] : []), ...(s.color ? [s.color] : []), ...shadows]) {
      const e = paintError(p);
      if (e) return e;
    }
    if (s.css !== undefined && sanitizeCss(s.css) === undefined) return 'css: only plain declarations are allowed (no url(), @import, expressions, escapes or braces)';
    const f = s.font;
    for (const v of [s.blend, s.cursor, s.aspect, s.overflow, s.decoration, s.textTransform, s.textAlign, f?.family, f?.letterSpacing, f?.lineHeight, f?.weight]) {
      if (typeof v === 'string' && !isSafeCssValue(v)) return `Invalid style value "${short(v)}"`;
    }
  }
  const l = n.layout;
  if (l) {
    if (typeof l.columns === 'string' && !isSafeGridTemplate(l.columns)) return `Invalid grid columns "${short(l.columns)}"`;
    if (l.rows !== undefined && !isSafeGridTemplate(l.rows)) return `Invalid grid rows "${short(String(l.rows))}"`;
  }
  return undefined;
}
