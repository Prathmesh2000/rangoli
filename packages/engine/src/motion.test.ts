import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { lint } from './lint.js';
import { cubicBezier, dampingRatio, motionCss, sampleMotion, serializeMotion, simulateSpring } from './motion.js';
import { applyRdl } from './rdl.js';
import { renderDocument } from './render.js';
import { defaultTokens } from './tokens.js';

describe('easing math', () => {
  it('cubic-bezier endpoints and monotonic ease-out', () => {
    const f = cubicBezier(0.2, 0, 0, 1);
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
    expect(f(0.5)).toBeGreaterThan(0.5); // ease-out is ahead at midpoint
  });
  it('critically damped spring does not overshoot, bouncy one does', () => {
    const snappy = simulateSpring({ stiffness: 400, damping: 40 });
    expect(snappy.overshoot).toBeLessThan(0.005);
    expect(dampingRatio({ stiffness: 400, damping: 40 })).toBeCloseTo(1, 2);
    const bouncy = simulateSpring({ stiffness: 300, damping: 10 });
    expect(bouncy.overshoot).toBeGreaterThan(0.2);
    expect(snappy.samples.at(-1)).toBe(1);
  });
});

describe('motion via RDL', () => {
  it('defines, merges, serializes and clears motion', () => {
    const doc = createDocument();
    applyRdl(doc, 'Dialog col p6 fill:surface r4');
    applyRdl(doc, 'motion #n1\n  enter opacity:0, scale:popIn, y:md base out\n  exit opacity:0, scale:popIn fast in');
    expect(doc.data.motion!['#n1']!.specs).toHaveLength(2);
    // merging replaces only the given trigger
    applyRdl(doc, 'motion #n1\n  exit opacity:0 instant in');
    const m = doc.data.motion!['#n1']!;
    expect(m.specs.map((s) => s.trigger).sort()).toEqual(['enter', 'exit']);
    expect(m.specs.find((s) => s.trigger === 'exit')!.tracks).toEqual([{ prop: 'opacity', to: '0' }]);
    expect(serializeMotion(doc.data.motion, ['#n1'])).toBe('motion #n1\n  enter opacity:0, scale:popIn, y:md base out\n  exit opacity:0 instant in');
    applyRdl(doc, 'motion #n1 none');
    expect(doc.data.motion!['#n1']).toBeUndefined();
    doc.undo();
    expect(doc.data.motion!['#n1']).toBeDefined();
  });

  it('variant-scoped component motion is validated', () => {
    const doc = createDocument();
    expect(() => applyRdl(doc, 'motion @Button variant=fancy\n  hover opacity:0.9 fast out')).toThrow(/no variant=fancy/);
    expect(() => applyRdl(doc, 'motion @Nope\n  hover opacity:0.9')).toThrow(/Unknown component/);
    expect(() => applyRdl(doc, 'motion @Button\n  wiggle opacity:0.9')).toThrow(/Unknown motion trigger/);
    applyRdl(doc, 'motion @Chip variant=error\n  enter opacity:0, scale:popIn base spring:snappy');
    expect(doc.data.motion!['@Chip[variant=error]']).toBeDefined();
  });

  it('deleting a node removes its motion; undo restores both', () => {
    const doc = createDocument();
    applyRdl(doc, 'Toast row p3 fill:inverse r3');
    applyRdl(doc, 'motion #n1\n  enter opacity:0, y:md base out');
    applyRdl(doc, 'delete #n1');
    expect(doc.data.motion!['#n1']).toBeUndefined();
    doc.undo();
    expect(doc.data.motion!['#n1']).toBeDefined();
    expect(doc.findNode('n1')).toBeDefined();
  });
});

describe('motion CSS', () => {
  it('emits transitions for states, keyframes for enter/exit, and reduced-motion variants', () => {
    const doc = createDocument();
    applyRdl(doc, 'Dialog col p6 fill:surface r4');
    applyRdl(doc, 'motion #n1\n  enter opacity:0, scale:popIn, y:md base out\n  exit opacity:0, scale:popIn fast in');
    const css = motionCss(doc.data.motion, doc.data.tokens);
    // default button motion
    expect(css).toContain('.rc-Button[data-variant="primary"]:hover:not(:disabled):not([aria-disabled="true"]){background-color:var(--color-action-primaryHover)');
    expect(css).toContain('.rc-Button:active:not(:disabled):not([aria-disabled="true"]){transform:scale(var(--motion-scale-press))');
    expect(css).toContain('.rc-Button:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:2px');
    // enter/exit keyframes
    expect(css).toContain('@keyframes rg-n1-enter{from{opacity:0;transform:scale(var(--motion-scale-popIn)) translateY(var(--motion-distance-md))}to{opacity:1;transform:scale(1) translateY(0px)}}');
    expect(css).toContain('.r-n1{animation:rg-n1-enter var(--motion-duration-base) var(--motion-easing-out) 0ms both}');
    expect(css).toContain('.r-n1[data-exiting]{animation:rg-n1-exit');
    // reduced: fade kept, movement dropped
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\{.*@keyframes rg-n1-enter-r\{from\{opacity:0\}to\{opacity:1\}\}/);
    expect(css).toMatch(/prefers-reduced-motion[^]*\.rc-Button:active[^{]*\{transform:none\}/);
  });

  it('springs become CSS linear() easing', () => {
    const doc = createDocument();
    applyRdl(doc, 'motion @Chip\n  enter opacity:0, scale:popIn base spring:snappy');
    const css = motionCss(doc.data.motion, doc.data.tokens);
    expect(css).toMatch(/\.rc-Chip\{animation:rg-Chip-enter \d+ms linear\(0, [\d., ]+1\) 0ms both\}/);
  });

  it('standalone render includes motion and no global reduced-motion kill switch', () => {
    const doc = createDocument();
    applyRdl(doc, '@Button variant=primary "Save"');
    const html = renderDocument(doc);
    expect(html).toContain('.rc-Button[data-variant="primary"]:hover');
    expect(html).not.toContain('transition-duration:0.01ms!important');
  });
});

describe('motion for agents', () => {
  it('samples value tables', () => {
    const s = sampleMotion({ trigger: 'enter', tracks: [{ prop: 'opacity', from: '0' }, { prop: 'y', from: 'md' }], duration: 'base', easing: 'out' }, defaultTokens());
    expect(s.ms).toBe(200);
    expect(s.lines[0]).toMatch(/^opacity: 0 [\d.]+ [\d.]+ [\d.]+ [\d.]+ 1$/);
    expect(s.lines[1]).toMatch(/^y: 8 [\d.]+ .* 0$/);
    expect(s.lines.at(-1)).toBe('t(ms): 0 40 80 120 160 200');
  });
});

describe('motion lint', () => {
  it('flags slow, janky, bouncy, scale-from-zero, slow exits and hover-lift slop', () => {
    const doc = createDocument();
    doc.data.tokens = defaultTokens();
    (doc.data.tokens as Record<string, any>).motion.spring.bouncy = { $value: { stiffness: 300, damping: 10 }, $type: 'spring' };
    applyRdl(doc, 'Card col p4 fill:surface stroke:border r3\n  Text body "Card"');
    applyRdl(doc, `motion #n1
  hover y:-4, shadow:md 250ms out
  press scale:0.97 spring:bouncy
  enter opacity:0, scale:0.2, h:0 base out
  exit opacity:0 slow in`);
    const codes = lint(doc).filter((i) => i.code.startsWith('M')).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['M01', 'M02', 'M03', 'M05', 'M07', 'M11']));
    const m02 = lint(doc).find((i) => i.code === 'M02' && i.severity === 'P1');
    expect(m02?.message).toContain('h');
  });

  it('default component motion is clean', () => {
    const doc = createDocument();
    applyRdl(doc, '@Button variant=primary "Save"');
    expect(lint(doc).filter((i) => i.code.startsWith('M'))).toEqual([]);
  });
});
