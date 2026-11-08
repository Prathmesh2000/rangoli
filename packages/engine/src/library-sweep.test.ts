import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { LIBRARY } from './library.js';
import { fmtNum } from './library-data.js';
import { lint } from './lint.js';
import { PATTERNS } from './patterns.js';
import { applyRdl } from './rdl.js';
import { renderDocument, renderFragment } from './render.js';

describe('every pattern', () => {
  it.each(Object.keys(PATTERNS))('+%s expands, renders and has no P0/P1 issues', (name) => {
    const doc = createDocument();
    applyRdl(doc, `Frame col p6 fill:canvas\n  +${name}`);
    const { html, css } = renderFragment(doc);
    expect(html + css).not.toMatch(/undefined|NaN/);
    expect(lint(doc).filter((i) => i.severity === 'P0' || i.severity === 'P1')).toEqual([]);
  });
});

describe('every component', () => {
  it.each(Object.keys(LIBRARY))('@%s example renders cleanly in both modes', (name) => {
    const doc = createDocument();
    applyRdl(doc, `Frame col p6 fill:surface\n${LIBRARY[name]!.doc.example.split('\n').map((l) => `  ${l}`).join('\n')}`);
    for (const mode of ['light', 'dark']) expect(renderDocument(doc, { mode })).not.toMatch(/undefined|NaN/);
    expect(lint(doc).filter((i) => i.severity === 'P0')).toEqual([]);
  });
});

describe('charts', () => {
  const render = (rdl: string) => { const doc = createDocument(); applyRdl(doc, rdl); return renderFragment(doc).html; };

  it('columns: ≤24px, rounded data end, zero baseline, legend for 2+ series, tooltip and table', () => {
    const html = render('@Chart w400 h240 data="10,20;5,8" labels="A|B" series="Passed|Failed" "Runs"');
    expect(html).toContain('<div class="rk-legend"><span><i class="rk-k1"></i>Passed</span><span><i class="rk-k2"></i>Failed</span></div>');
    expect(html).toContain('<title>B · Failed: 8</title>');
    expect(html).toMatch(/<table class="rk-sr"><caption>Runs<\/caption>/);
    for (const [, w] of html.matchAll(/H([\d.]+)Q[\d. ]+V/g)) expect(Number(w)).toBeGreaterThan(0);
  });

  it('a single series has no legend box; lines zoom to their range, bars never do', () => {
    const line = render('@Chart kind=line data="94,95,97" labels="a|b|c" unit="%"');
    expect(line).not.toContain('rk-legend');
    expect(line).toMatch(/>9[0-4]%<\/text>/); // axis starts near the data, not at 0
    expect(render('@Chart kind=column data="94,95,97"')).toMatch(/>0<\/text>/);
    expect(render('@Chart kind=line zero=true data="94,95,97"')).toMatch(/>0<\/text>/);
  });

  it('formats axis numbers in full under 10,000 and compact above', () => {
    expect([fmtNum(1284), fmtNum(12900), fmtNum(4_200_000), fmtNum(0.5)]).toEqual(['1,284', '12.9K', '4.2M', '0.5']);
  });

  it('meters pair colour with an icon and a word', () => {
    const html = render('Box col\n  @Meter value=95 "Memory"\n  @Meter value=20 "CPU"');
    expect(html).toContain('Critical');
    expect(html.match(/rk-status/g)).toHaveLength(1);
  });
});
