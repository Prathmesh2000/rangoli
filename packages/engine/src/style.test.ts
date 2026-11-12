import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { applyRdl, sanitizeCss, serializeRdl } from './rdl.js';
import { renderFragment } from './render.js';
import { lint } from './lint.js';

/** Every style capability must render AND survive serialize → parse unchanged. */
const RICH = `Hero col gap4 p6 w600 fill:linear(135,primary.400,primary.700@80) stroke:border/2/dashed/b r:16,16,0,0 shadow:0,8,24,-4,neutral.900~20 shadow+:0,1,2,0,neutral.900~8 bgblur:12 overflow:hidden z:2
  Title text size:40 weight:700 font:"IBM Plex Sans" lh:1.1 ls:-0.02em color:white
  Eyebrow text caption upper ls:0.08em color:primary.100~80
  Quote text body italic underline align:justify
  Badge row abs at:520,16 p2 rfull fill:warning.400 rotate:-8 cursor:pointer
    Text label "NEW"
  Media row w200 ratio:16/9 fill:subtle blend:multiply blur:2 css:"filter:grayscale(1);mix-blend-mode:normal"
  Logo w48 h48 vb:24,24 shapes:"circle 12 12 10 fill=true c=primary.600|polyline 7 12 11 16 17 8" stroke:white/2
  Squiggle w120 h40 d:"M2 20 Q32 2 60 20 T118 20" stroke:primary.600/3`;

describe('style power', () => {
  it('round-trips every new property', () => {
    const doc = createDocument();
    applyRdl(doc, RICH);
    const out = serializeRdl(doc);
    const doc2 = createDocument();
    applyRdl(doc2, out);
    expect(serializeRdl(doc2)).toBe(out);
    expect(out).toContain('fill:linear(135,primary.400,primary.700@80)');
    expect(out).toContain('stroke:border/2/dashed/b');
    expect(out).toContain('r:16,16,0,0');
    expect(out).toContain('shadow:0,8,24,-4,neutral.900~20 shadow+:0,1,2,0,neutral.900~8');
    expect(out).toContain('font:"IBM Plex Sans" lh:1.1 ls:-0.02em');
    expect(out).toContain('abs');
    expect(out).toContain('shapes:"circle 12 12 10 fill=true c=primary.600|polyline 7 12 11 16 17 8"');
    expect(out).toContain('d:"M2 20 Q32 2 60 20 T118 20"');
  });

  it('renders to real CSS', () => {
    const doc = createDocument();
    applyRdl(doc, RICH);
    const { html, css } = renderFragment(doc);
    expect(css).toContain('background:linear-gradient(135deg, var(--color-primary-400) 0%, var(--color-primary-700) 80%)');
    expect(css).toContain('border-bottom:2px dashed var(--color-border-default)');
    expect(css).toContain('border-radius:16px 16px 0 0');
    expect(css).toContain('box-shadow:0px 8px 24px -4px color-mix(in srgb, var(--color-neutral-900) 20%, transparent),0px 1px 2px 0px color-mix(in srgb, var(--color-neutral-900) 8%, transparent)');
    expect(css).toContain('backdrop-filter:blur(12px)');
    expect(css).toContain('font-family:"IBM Plex Sans", sans-serif');
    expect(css).toContain('letter-spacing:-0.02em');
    expect(css).toContain('text-transform:uppercase');
    expect(css).toContain('font-style:italic;text-decoration:underline');
    expect(css).toMatch(/position:absolute;left:520px;top:16px/);
    expect(css).toContain('rotate:-8deg');
    expect(css).toContain('aspect-ratio:16/9');
    expect(css).toContain('filter:grayscale(1);mix-blend-mode:normal');
    // parent of an absolute child becomes the positioning context
    expect(css).toMatch(/\.r-n1\{[^}]*position:relative/);
    // vectors: filled circle keeps its own colour (no layer outline), the check inherits the layer stroke
    expect(html).toMatch(/<path d="M2 12 A10 10[^"]*" fill="var\(--color-primary-600\)" stroke="none"/);
    expect(html).toMatch(/<path d="M7 12 L11 16 L17 8" fill="none" stroke="var\(--color-white\)"/);
    expect(html).toContain('<path d="M2 20 Q32 2 60 20 T118 20" fill="none" stroke="var(--color-primary-600)" stroke-width="3"');
  });

  it('rejects unsafe raw CSS and bad paths', () => {
    expect(sanitizeCss('color:red;background:url(http://x)')).toBeUndefined();
    expect(sanitizeCss('}body{display:none')).toBeUndefined();
    expect(sanitizeCss('filter: blur(2px); opacity:.5')).toBe('filter: blur(2px);opacity:.5');
    const doc = createDocument();
    expect(() => applyRdl(doc, 'Box css:"background:url(evil)"')).toThrow(/only plain declarations/);
    expect(() => applyRdl(doc, 'V d:"<script>"')).toThrow(/SVG path data/);
    expect(() => applyRdl(doc, 'Box fill:linear(primary.500)')).toThrow(/at least two colours/);
  });

  it('set can move a layer to absolute and back', () => {
    const doc = createDocument();
    applyRdl(doc, 'Card col p4\n  Tag text "x"');
    applyRdl(doc, 'set #n2 abs at:10,10');
    expect(doc.node('n2')).toMatchObject({ absolute: true, position: { x: 10, y: 10 } });
  });
});

describe('contrast on rich fills', () => {
  it('checks every gradient stop and blends alpha text', () => {
    const doc = createDocument();
    applyRdl(doc, 'Hero col p6 fill:linear(135,primary.700,primary.900)\n  T text body color:white~85 "ok"\n  Bad text body color:white~20 "faint"');
    const d03 = lint(doc).filter((i) => i.code === 'D03').map((i) => i.node);
    expect(d03).toEqual(['n3']);
  });
});

describe('unset', () => {
  it('removes properties so they fall back to inherited/component defaults', () => {
    const doc = createDocument();
    applyRdl(doc, 'Box col p4 rotate:5 italic css:"opacity:.5" shadow:md abs at:4,4 w200\n  T text "x"');
    applyRdl(doc, 'set #n1 unset:rotate,italic,css,shadow,abs,w');
    expect(doc.node('n1')).toMatchObject({ layout: { mode: 'col' } });
    expect(doc.node('n1')!.style).toBeUndefined();
    expect(doc.node('n1')!.absolute).toBeUndefined();
    expect(() => applyRdl(doc, 'set #n1 unset:bogus')).toThrow(/unknown property "bogus"/);
  });
});

describe('pen paths', () => {
  it('unset:paths replaces drawn paths instead of adding to them', () => {
    const doc = createDocument();
    applyRdl(doc, 'P w40 h40 d:"M0 0 L10 10"');
    applyRdl(doc, 'set #n1 unset:paths d:"M1 1 L2 2" d:"M3 3 L4 4"');
    expect(doc.node('n1')!.vector!.paths.map((p) => p.d)).toEqual(['M1 1 L2 2', 'M3 3 L4 4']);
  });
});
