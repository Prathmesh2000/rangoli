import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { compileIcon, findIcon, iconSvg, lintIcons, packIconNames } from './icons.js';
import { fromSubpaths, normalizePath, svgToIconSrc, toSubpaths } from './icons-svg.js';
import './icon-pack.js';
import { applyRdl } from './rdl.js';
import { renderDocument, renderFragment } from './render.js';
import { SCENE_KIT, parseSceneObjects, serializeSceneObjects } from './scene3d.js';

describe('SVG paths', () => {
  it('normalises relative commands, shorthand curves and arcs to absolute M L C Z', () => {
    expect(normalizePath('m2 2 h4 v4 z')).toBe('M2 2 L6 2 L6 6 Z');
    expect(normalizePath('M0 0 Q5 10 10 0')).toMatch(/^M0 0 C3\.333 6\.667 6\.667 6\.667 10 0$/);
    const arc = normalizePath('M0 0 A5 5 0 0 1 10 0');
    expect(arc.startsWith('M0 0 C')).toBe(true);
    expect(arc.endsWith(' 10 0')).toBe(true);
  });

  it('round-trips through editable nodes', () => {
    const d = 'M2 2 L10 2 C12 2 14 4 14 6 Z';
    const subs = toSubpaths(d);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.closed).toBe(true);
    expect(subs[0]!.nodes).toHaveLength(3);
    expect(toSubpaths(fromSubpaths(subs))[0]!.nodes).toEqual(subs[0]!.nodes);
  });
});

describe('importing SVG', () => {
  it('scales any viewBox to the grid and keeps stroke, fill, colour and evenodd', () => {
    const { src, stroke } = svgToIconSrc('<svg viewBox="0 0 48 48"><path d="M4 4 L44 44" fill="none" stroke="#000" stroke-width="4"/><circle cx="24" cy="24" r="10" fill="#ff0000"/><path fill-rule="evenodd" d="M0 0 H48 V48 Z"/></svg>');
    expect(stroke).toBe(2);
    expect(src.split('\n')[0]).toBe('exact');
    expect(src).toContain('path M2 2 L22 22 w=2');
    expect(src).toContain('c=#ff0000');
    expect(src).toContain('rule=evenodd');
    const c = compileIcon(src);
    expect(c.shapes).toHaveLength(3);
    expect(c.snapped).toBe(0);
  });

  it('applies transforms, ignores what it cannot use, and refuses empty files', () => {
    const r = svgToIconSrc('<svg viewBox="0 0 24 24"><g transform="translate(2 3)"><rect width="4" height="4"/></g><text>x</text></svg>');
    expect(r.src).toContain('M2 3 L6 3');
    expect(r.warnings.join()).toContain('text');
    expect(() => svgToIconSrc('<svg></svg>')).toThrow(/no shapes/);
  });

  it('never emits raw markup: quotes and scripts cannot reach the output', () => {
    const doc = createDocument();
    const { src } = svgToIconSrc('<svg viewBox="0 0 24 24"><script>alert(1)</script><path d="M1 1 L2 2" onclick="x()"/></svg>');
    applyRdl(doc, `icon ui/imported\n${src.split('\n').map((l) => `  ${l}`).join('\n')}`);
    const svg = iconSvg(doc.data.icons!.ui!, doc.data.icons!.ui!.icons.imported!);
    expect(svg).not.toMatch(/script|onclick/);
  });
});

describe('shape language', () => {
  it('has ellipse, polygon, star and per-shape stroke, opacity, dash', () => {
    const c = compileIcon('ellipse 12 12 8 4\nngon 12 12 8 6 fill=true c=#ff0000\nstar 12 12 9 4 5 w=3 o=.5 dash=2,1');
    expect(c.shapes).toHaveLength(3);
    expect(c.shapes[1]).toMatchObject({ fill: true, color: '#ff0000' });
    expect(c.shapes[2]).toMatchObject({ w: 3, o: 0.5, dash: '2,1' });
    expect(c.shapes[2]!.points).toHaveLength(10);
  });

  it('snaps normally, but keeps exact coordinates when asked, and c=#hex is not a comment', () => {
    expect(compileIcon('line 1.2 1 3 3').snapped).toBe(1);
    expect(compileIcon('exact\nline 1.2 1 3 3').shapes[0]!.d).toBe('M1.2 1 L3 3');
    expect(compileIcon('circle 12 12 4 c=#00ff00 # note').shapes[0]!.color).toBe('#00ff00');
    expect(lintIcons({ a: { name: 'a', grid: 24, stroke: 2, cap: 'round', join: 'round', icons: { x: { name: 'x', src: 'exact\nline 2.2 2 9 9' } } } }).map((i) => i.code)).not.toContain('I01');
  });
});

describe('icon pack', () => {
  it('offers thousands of icons without adding them to documents', () => {
    expect(packIconNames('lucide').length).toBeGreaterThan(1500);
    const doc = createDocument();
    expect(doc.data.icons!.lucide).toBeUndefined();
    applyRdl(doc, 'Icon icon:rocket w24 h24');
    expect(findIcon(doc.data.icons, 'lucide/rocket')).toBeDefined();
    expect(renderFragment(doc).html).toContain('<path');
    expect(doc.data.icons!.lucide).toBeUndefined();
  });

  it('your own icon with the same name wins', () => {
    const doc = createDocument();
    applyRdl(doc, 'icon ui/rocket\n  circle 12 12 8');
    expect(findIcon(doc.data.icons, 'rocket')!.set.name).toBe('ui');
  });
});

describe('3D set', () => {
  it('every kit entry parses, and new fields round-trip', () => {
    for (const k of SCENE_KIT) expect(parseSceneObjects(k.objects).length).toBeGreaterThan(0);
    const list = parseSceneObjects('text text=HELLO_WORLD depth=.3 mat=chrome | box copies=6 radius=2 orbit=.5 pulse=1 name=ring | blob noise=2 map=https://x.com/a.png');
    expect(list[0]!.text).toBe('HELLO WORLD');
    expect(serializeSceneObjects(list)).toBe('text text=HELLO_WORLD depth=0.3 mat=chrome | box copies=6 radius=2 orbit=0.5 pulse=1 name=ring | blob noise=2 map=https://x.com/a.png');
  });

  it('extrude brings the icon geometry into the scene', () => {
    const doc = createDocument();
    applyRdl(doc, '@Scene3D objects="extrude icon=shield depth=.5"');
    expect(renderDocument(doc)).toContain('&quot;paths&quot;:[{&quot;d&quot;:&quot;M12 3');
  });

  it('saves your own designs in the document', () => {
    const doc = createDocument();
    applyRdl(doc, 'sceneset "Hero" objects="gem color=primary.400" light=neon');
    expect((doc.data.tokens as { $extensions: { rangoli: { scenes: Record<string, unknown> } } }).$extensions.rangoli.scenes.Hero).toEqual({ objects: 'gem color=primary.400', light: 'neon' });
    applyRdl(doc, 'sceneset "Hero" none');
    expect(() => applyRdl(doc, 'sceneset "X" light=neon')).toThrow(/needs a name and objects/);
  });
});

describe('field looks', () => {
  it.each(['outlined', 'filled', 'underlined', 'pill', 'ghost', 'floating', 'floating-filled'])('%s input renders', (a) => {
    const doc = createDocument();
    applyRdl(doc, `@Input appearance=${a} title="Email" help="We never share it" max=40 required=true "you@work.com"`);
    const { html } = renderFragment(doc);
    expect(html).toContain(`data-appearance="${a}"`);
    expect(html).toContain('rk-help');
    expect(html.includes('rk-float')).toBe(a.startsWith('floating'));
  });

  it('floating labels really float: the field keeps a blank placeholder so CSS can see it filled', () => {
    const doc = createDocument();
    applyRdl(doc, '@Input appearance=floating "Email"');
    const { html } = renderFragment(doc);
    expect(html).toContain('placeholder=" "');
    expect(html).toContain('<label class="rk-float">Email</label>');
  });
});
