import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { compileIcon, defaultIcons, findIcon, iconReact, iconSprite, iconSvg, lintIcons } from './icons.js';
import { lint } from './lint.js';
import { applyRdl, serializeRdl } from './rdl.js';
import { renderFragment } from './render.js';
import type { Diagnostic } from './rdl.js';

describe('shape language', () => {
  it('compiles shapes to path data', () => {
    const c = compileIcon('line 4 4 20 20\ncircle 12 12 8\nrect 4 4 16 16 r=2\ndot 12 12\npolyline 5 12 10 17 19 7\npath M8 5 L18 12 L8 19 Z');
    expect(c.shapes.map((s) => s.d.split(' ')[0])).toEqual(['M4', 'M4', 'M6', 'M10.75', 'M5', 'M8']);
    expect(c.shapes[3]!.fill).toBe(true);
    expect(c.bbox).toEqual({ x0: 4, y0: 4, x1: 20, y1: 20 });
  });

  it('snaps to the 0.5 grid and counts it', () => {
    const c = compileIcon('line 4.2 4 20 19.9');
    expect(c.shapes[0]!.d).toBe('M4 4 L20 20');
    expect(c.snapped).toBe(2);
  });

  it('rejects unknown shapes, relative/arc path commands and bad numbers', () => {
    const d: Diagnostic[] = [];
    compileIcon('blob 1 2\npath m1 1 l2 2\npath M1 1 A 2 2 0 0 1 4 4\nline 1 x 3 4', d);
    expect(d.map((x) => x.message).join('\n')).toMatch(/Unknown shape "blob"[\s\S]*command "m" not allowed[\s\S]*command "A" not allowed[\s\S]*"x" is not a number/);
  });
});

describe('starter set', () => {
  it('is consistent: no P0–P2 icon lint', () => {
    const issues = lintIcons(defaultIcons()).filter((i) => i.severity !== 'P3');
    expect(issues).toEqual([]);
  });
  it('exports SVG, React and sprite', () => {
    const { set, icon } = findIcon(defaultIcons(), 'clock')!;
    const svg = iconSvg(set, icon);
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('stroke="currentColor" stroke-width="1.5" stroke-linecap="round"');
    expect(svg).toContain('aria-hidden="true"');
    expect(iconSvg(set, icon, { title: 'Duration' })).toContain('<title>Duration</title>');
    const tsx = iconReact(set, icon);
    expect(tsx).toContain('export function ClockIcon(');
    expect(tsx).toContain('strokeWidth={1.5}');
    expect(iconSprite(set)).toContain('<symbol id="ui-clock"');
  });
});

describe('icons via RDL and in designs', () => {
  it('creates sets/icons, validates, lints, and renders icon nodes with currentColor', () => {
    const doc = createDocument();
    applyRdl(doc, 'icon drafts/flask-check~1\n  line 9.5 3.5 14.5 3.5\n  path M10.5 3.5 L10.5 9.5 L5.5 18 Q4.5 20 6.5 20 L17.5 20\n  polyline 9 15 11 17 15 13');
    expect(doc.data.icons!.drafts!.grid).toBe(24); // inherits ui conventions
    expect(doc.data.icons!.drafts!.icons['flask-check~1']!.src).toContain('polyline 9 15 11 17 15 13');
    expect(() => applyRdl(doc, 'icon ui/bad\n  wiggle 1 2')).toThrow(/Unknown shape "wiggle"/);
    expect(() => applyRdl(doc, 'icon ui/bad\n  path M1 1 l5 5')).toThrow(/not allowed/);

    applyRdl(doc, 'icon ui/heavy stroke2\n  circle 12 12 11.5');
    const codes = lint(doc).filter((i) => i.node === 'icon:ui/heavy').map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['I02', 'I03']));

    applyRdl(doc, '@Button variant=secondary "Run again"\n  Icon icon:retry w16 h16\nIcon icon:clock w20 color:text.secondary');
    expect(doc.node('n2')).toMatchObject({ type: 'vector', icon: 'ui/retry' });
    expect(serializeRdl(doc)).toContain('Icon#n2 w16 h16 icon:retry');
    const { html, css } = renderFragment(doc);
    expect(html).toMatch(/<button class="r-n1 rc-Button"[^>]*><svg class="r-n2" [^>]*stroke="currentColor" stroke-width="1.5"[^>]*>.*<\/svg>Run again<\/button>/);
    expect(css).toContain('.r-n3{width:20px;color:var(--color-text-secondary)');
    expect(() => applyRdl(doc, 'Icon icon:nope')).toThrow(/Unknown icon "nope"/);

    applyRdl(doc, 'icon ui/clock none');
    expect(lint(doc).some((i) => i.code === 'D16' && i.node === 'n3')).toBe(true);
    doc.undo();
    expect(findIcon(doc.data.icons, 'ui/clock')).toBeDefined();
  });
});
