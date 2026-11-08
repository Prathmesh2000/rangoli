import { describe, expect, it } from 'vitest';
import { contrastRatio, generateRamp, hexToRgb, oklchToHex, rgbToOklch, simulateCvd, deltaE, generateCategorical } from './color.js';
import { defaultTokens, TokenResolver, tokensToCss } from './tokens.js';

describe('color math', () => {
  it('round-trips hex through OKLCH', () => {
    for (const hex of ['#2a6fb0', '#ffffff', '#000000', '#d63c3c', '#2f9e57']) {
      const back = oklchToHex(rgbToOklch(hexToRgb(hex)));
      expect(deltaE(back, hex)).toBeLessThan(0.5);
    }
  });

  it('computes WCAG contrast correctly', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });

  it('generates a monotonic lightness ramp in gamut', () => {
    const ramp = generateRamp('#2a6fb0');
    const ls = Object.values(ramp).map((h) => rgbToOklch(hexToRgb(h)).l);
    for (let i = 1; i < ls.length; i++) expect(ls[i]!).toBeLessThan(ls[i - 1]!);
    for (const h of Object.values(ramp)) expect(h).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('simulates color-vision deficiency (red/green collapse for deutan)', () => {
    const r = simulateCvd('#d63c3c', 'deutan');
    const g = simulateCvd('#2f9e57', 'deutan');
    expect(deltaE(r, g)).toBeLessThan(deltaE('#d63c3c', '#2f9e57'));
  });

  it('categorical palette colors are distinct', () => {
    const cats = generateCategorical('#2a6fb0', 8);
    for (let i = 0; i < cats.length; i++) for (let j = i + 1; j < cats.length; j++) expect(deltaE(cats[i]!, cats[j]!)).toBeGreaterThan(5);
  });
});

describe('tokens', () => {
  const r = new TokenResolver(defaultTokens());

  it('resolves aliases and modes', () => {
    const light = r.resolve('color.text.primary') as string;
    const dark = r.resolve('color.text.primary', 'dark') as string;
    expect(light).toMatch(/^#/);
    expect(dark).not.toBe(light);
    expect(r.resolve('color.text.muted')).toBe(r.resolve('color.text.secondary'));
  });

  it('default text tokens pass AA on their surfaces in light and dark', () => {
    for (const mode of ['light', 'dark']) {
      const bg = r.resolve('color.bg.surface', mode) as string;
      for (const t of ['color.text.primary', 'color.text.secondary']) {
        expect(contrastRatio(r.resolve(t, mode) as string, bg)).toBeGreaterThanOrEqual(4.5);
      }
      // secondary text must also work on every non-selected background it commonly sits on
      for (const surf of ['color.bg.subtle', 'color.bg.canvas']) {
        expect(contrastRatio(r.resolve('color.text.secondary', mode) as string, r.resolve(surf, mode) as string)).toBeGreaterThanOrEqual(4.5);
      }
      const onPrimary = r.resolve('color.text.onPrimary', mode) as string;
      expect(contrastRatio(onPrimary, r.resolve('color.action.primary', mode) as string)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(onPrimary, r.resolve('color.action.primaryHover', mode) as string)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.resolve('color.text.onDanger', mode) as string, r.resolve('color.action.danger', mode) as string)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r.resolve('color.text.link', mode) as string, bg)).toBeGreaterThanOrEqual(4.5);
      for (const s of ['success', 'warning', 'error', 'info']) {
        expect(contrastRatio(r.resolve(`color.status.${s}.fg`, mode) as string, r.resolve(`color.status.${s}.bg`, mode) as string)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('finds shorthand token names', () => {
    expect(r.find('surface', 'color')).toBe('color.bg.surface');
    expect(r.find('border', 'color')).toBe('color.border.default');
    expect(r.find('3', 'space')).toBe('space.3');
    expect(r.find('title-sm', 'textStyle')).toBe('textStyle.title-sm');
    expect(r.shortName('color.bg.surface', 'color')).toBe('surface');
  });

  it('exports CSS variables with a dark-mode block', () => {
    const css = tokensToCss(defaultTokens());
    expect(css).toContain('--space-3: 12px;');
    expect(css).toContain('[data-mode="dark"]');
    expect(css).toMatch(/--color-text-primary: #[0-9a-f]{6};/);
    expect(css).toContain('--motion-easing-out: cubic-bezier(0.2, 0, 0, 1);');
  });
});
