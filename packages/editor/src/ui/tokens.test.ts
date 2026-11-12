import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const css = read('./tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
const components = read('./ui.css').replace(/\/\*[\s\S]*?\*\//g, '');
const direction = read('../../../../docs/design/direction.md');

/** The declarations of the first rule whose selector is exactly this. */
function block(selector: string, source = css): Record<string, string> {
  const start = source.indexOf(`${selector} {`);
  expect(start, `selector ${selector}`).toBeGreaterThanOrEqual(0);
  const open = start + selector.length + 1;
  const body = source.slice(open + 1, source.indexOf('}', open));
  return Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const at = d.indexOf(':');
    return [d.slice(0, at).trim(), d.slice(at + 1).trim()];
  }));
}

const light = block(":root,\n[data-theme='light']");
const dark = block("[data-theme='dark']");
const system = block(":root:not([data-theme='light'])");

const roles = [...direction.matchAll(/^([a-z][a-z0-9-]*)\s+(#[0-9A-Fa-f]{6})\s+(#[0-9A-Fa-f]{6})$/gm)].map((m) => ({ name: m[1]!, light: m[2]!, dark: m[3]! }));

describe('colour roles match direction.md', () => {
  it('finds the whole table', () => expect(roles.length).toBe(26));
  it.each(roles)('$name', ({ name, light: l, dark: d }) => {
    expect(light[`--rg-${name}`]).toBe(l);
    expect(dark[`--rg-${name}`]).toBe(d);
    expect(system[`--rg-${name}`]).toBe(d);
  });
  it('keeps the two dark blocks identical', () => expect(system).toEqual(dark));
  it('fixes canvas selection in both themes', () => {
    const base = block(':root');
    expect(base['--rg-canvas-selection']).toBe('#BD1560');
    expect(base['--rg-canvas-keyline']).toBe('#FFFFFF');
  });
});

describe('scales match direction.md', () => {
  const base = block(':root');
  it.each([[12, 16], [13, 18], [14, 20], [16, 24], [20, 28], [24, 32], [28, 36], [36, 44]])('type %d/%d', (s, l) => expect(base[`--rg-type-${s}`]).toBe(`${s}px/${l}px`));
  it.each([4, 8, 12, 16, 20, 24, 32, 40, 48, 64])('space %d', (n) => expect(base[`--rg-space-${n}`]).toBe(`${n}px`));
  it('radius', () => {
    expect([base['--rg-radius-inner'], base['--rg-radius-control'], base['--rg-radius-panel'], base['--rg-radius-sheet']]).toEqual(['6px', '8px', '12px', '14px']);
  });
  it('motion', () => {
    expect([base['--rg-dur-keyboard'], base['--rg-dur-hover'], base['--rg-dur-popover'], base['--rg-dur-panel'], base['--rg-dur-seal-wash'], base['--rg-dur-kolam']]).toEqual(['0ms', '120ms', '200ms', '240ms', '480ms', '640ms']);
    expect(base['--rg-ease-out']).toBe('cubic-bezier(.2, 0, 0, 1)');
    expect(base['--rg-ease-sheet']).toBe('cubic-bezier(.32, .72, 0, 1)');
  });
  it('declares both families with fallbacks', () => {
    expect(base['--rg-font-sans']).toMatch(/^'Instrument Sans',.*sans-serif$/);
    expect(base['--rg-font-mono']).toMatch(/^'JetBrains Mono',.*monospace$/);
  });
  it('collapses every moving duration under reduced motion', () => {
    const start = css.indexOf('prefers-reduced-motion');
    const reduced = block(':root', css.slice(start));
    expect(Object.keys(reduced).sort()).toEqual(['--rg-dur-hover', '--rg-dur-kolam', '--rg-dur-panel', '--rg-dur-popover', '--rg-dur-seal-wash']);
    expect(new Set(Object.values(reduced))).toEqual(new Set(['0ms']));
  });
});

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('avatar tints', () => {
  describe.each([['light', light], ['dark', dark]] as const)('%s', (_, theme) => {
    it.each(['plum', 'slate', 'clay'])('%s initials meet 4.5:1', (t) => {
      expect(contrast(theme[`--rg-avatar-${t}`]!, theme[`--rg-on-avatar-${t}`]!)).toBeGreaterThanOrEqual(4.5);
    });
  });
});

describe('component styles follow the motion and type rules', () => {
  it('only ever transitions opacity or transform', () => {
    const transitions = [...components.matchAll(/transition(?:-property)?:\s*([^;]+);/g)].map((m) => m[1]!);
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) expect(t).toMatch(/^(opacity|transform)\b/);
  });
  it('only animates opacity and transform in keyframes', () => {
    const frames = [...components.matchAll(/@keyframes[^{]+\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)].map((m) => m[1]!);
    expect(frames.length).toBe(3);
    for (const f of frames) for (const d of f.matchAll(/([a-z-]+):/g)) expect(['opacity', 'transform']).toContain(d[1]);
  });
  it('never drops below the 12px floor', () => {
    for (const m of components.matchAll(/font-size:\s*(\d+)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(12);
  });
  it('uses no raw colours: everything comes from tokens', () => {
    expect(components.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });
});
