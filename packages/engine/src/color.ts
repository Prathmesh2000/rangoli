/**
 * Color math: sRGB <-> OKLab/OKLCH, gamut mapping, WCAG contrast, CVD simulation.
 * Pure functions, no dependencies.
 */

export interface RGB { r: number; g: number; b: number } // 0..1 sRGB (gamma-encoded)
export interface OKLCH { l: number; c: number; h: number } // l 0..1, c ~0..0.4, h degrees

export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((ch) => ch + ch).join('');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) throw new Error(`Invalid hex color: ${hex}`);
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const to = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function rgbToOklch(rgb: RGB): OKLCH {
  const r = toLinear(rgb.r), g = toLinear(rgb.g), b = toLinear(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.sqrt(A * A + B * B);
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

/** Returns linear-free gamma sRGB, possibly out of [0,1] gamut. */
export function oklchToRgbUnclamped({ l: L, c, h }: OKLCH): RGB {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr), B = c * Math.sin(hr);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return { r: toGamma(Math.max(0, r)), g: toGamma(Math.max(0, g)), b: toGamma(Math.max(0, b)) };
}

function inGamut(c: OKLCH): boolean {
  const hr = (c.h * Math.PI) / 180;
  const A = c.c * Math.cos(hr), B = c.c * Math.sin(hr);
  const l = (c.l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (c.l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (c.l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const e = 1e-4;
  return r >= -e && r <= 1 + e && g >= -e && g <= 1 + e && b >= -e && b <= 1 + e;
}

/** Map into sRGB gamut by reducing chroma (binary search), preserving L and H. */
export function oklchToHex(c: OKLCH): string {
  let col = { ...c };
  if (!inGamut(col)) {
    let lo = 0, hi = col.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut({ ...col, c: mid })) lo = mid; else hi = mid;
    }
    col = { ...col, c: lo };
  }
  return rgbToHex(oklchToRgbUnclamped(col));
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.x contrast ratio (1..21). */
export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg), b = relativeLuminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

export type WcagLevel = 'AAA' | 'AA' | 'AA-large' | 'fail';
export function wcagLevel(ratio: number, largeText = false): WcagLevel {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return largeText ? 'AA' : 'AA-large';
  return 'fail';
}

/** Color-vision-deficiency simulation (Machado et al. 2009, severity 1.0), on linear RGB. */
const CVD: Record<'protan' | 'deutan' | 'tritan', number[]> = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};
export function simulateCvd(hex: string, kind: keyof typeof CVD): string {
  const { r, g, b } = hexToRgb(hex);
  const R = toLinear(r), G = toLinear(g), B = toLinear(b);
  const m = CVD[kind];
  const out = [m[0]! * R + m[1]! * G + m[2]! * B, m[3]! * R + m[4]! * G + m[5]! * B, m[6]! * R + m[7]! * G + m[8]! * B];
  return rgbToHex({ r: toGamma(clamp01(out[0]!)), g: toGamma(clamp01(out[1]!)), b: toGamma(clamp01(out[2]!)) });
}

/** Perceptual distance (OKLab euclidean ×100). ~2 = just noticeable. */
export function deltaE(a: string, b: string): number {
  const x = rgbToOklch(hexToRgb(a)), y = rgbToOklch(hexToRgb(b));
  const ax = x.c * Math.cos((x.h * Math.PI) / 180), ay = x.c * Math.sin((x.h * Math.PI) / 180);
  const bx = y.c * Math.cos((y.h * Math.PI) / 180), by = y.c * Math.sin((y.h * Math.PI) / 180);
  return Math.sqrt((x.l - y.l) ** 2 + (ax - bx) ** 2 + (ay - by) ** 2) * 100;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ---------------- palette generation ----------------

export const RAMP_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
const RAMP_L = [0.975, 0.94, 0.88, 0.8, 0.71, 0.62, 0.54, 0.46, 0.38, 0.3, 0.22];
/** chroma multiplier per step: low at the light/dark extremes */
const RAMP_C = [0.12, 0.25, 0.45, 0.7, 0.9, 1, 0.95, 0.85, 0.7, 0.55, 0.4];

/** Perceptually even 50–950 ramp from a seed color. */
export function generateRamp(seedHex: string, opts: { chroma?: number } = {}): Record<number, string> {
  const seed = rgbToOklch(hexToRgb(seedHex));
  const maxC = opts.chroma ?? Math.max(seed.c, 0.02);
  const out: Record<number, string> = {};
  RAMP_STEPS.forEach((step, i) => {
    out[step] = oklchToHex({ l: RAMP_L[i]!, c: maxC * RAMP_C[i]!, h: seed.h });
  });
  return out;
}

/** Neutral ramp slightly tinted toward the brand hue. */
export function generateNeutralRamp(brandHex: string, tint = 0.012): Record<number, string> {
  const seed = rgbToOklch(hexToRgb(brandHex));
  const out: Record<number, string> = {};
  RAMP_STEPS.forEach((step, i) => {
    out[step] = oklchToHex({ l: RAMP_L[i]!, c: tint * (0.5 + RAMP_C[i]! * 0.5), h: seed.h });
  });
  return out;
}

/** Categorical chart palette: evenly spaced hues at similar lightness/chroma, starting at the brand hue. */
export function generateCategorical(brandHex: string, n = 8): string[] {
  const seed = rgbToOklch(hexToRgb(brandHex));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = (seed.h + 137.508 * i) % 360; // golden angle keeps neighbours distinct for any n
    out.push(oklchToHex({ l: i % 2 ? 0.62 : 0.7, c: 0.13, h }));
  }
  return out;
}
