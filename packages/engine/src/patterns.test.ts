import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { LIBRARY } from './library.js';
import { lint } from './lint.js';
import { expandPatterns, PATTERNS } from './patterns.js';
import { applyRdl } from './rdl.js';
import { renderFragment } from './render.js';

describe('component library', () => {
  it('every component renders its documented example without errors and lints clean', () => {
    for (const [name, def] of Object.entries(LIBRARY)) {
      const doc = createDocument();
      applyRdl(doc, `Wrap col p4 fill:surface\n  ${def.doc.example}`);
      const { html } = renderFragment(doc);
      expect(html, name).toContain(`rc-${name}`);
      expect(html, name).not.toContain('undefined');
      const issues = lint(doc).filter((i) => i.severity !== 'P3' && !i.node.startsWith('icon:'));
      expect(issues, `${name}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });

  it('accessible anatomy: checkbox/switch/progress/tabs/pagination expose roles and state', () => {
    const doc = createDocument();
    applyRdl(doc, 'W col\n  @Checkbox checked=mixed "Some"\n  @Switch checked=true "On"\n  @ProgressBar value=40\n  @Tabs selected=1 "A|B:3|C"\n  @Pagination page=1 pages=3\n  @IconButton icon=more "More actions"');
    const { html } = renderFragment(doc);
    expect(html).toContain('role="checkbox" aria-checked="mixed"');
    expect(html).toContain('role="switch" aria-checked="true"');
    expect(html).toContain('aria-valuenow="40"');
    expect(html).toMatch(/role="tab" aria-selected="true">B<span class="rk-count">3<\/span>/);
    expect(html).toContain('aria-current="page">1<');
    expect(html).toContain('aria-label="More actions"');
  });

  it('icon buttons without a label are flagged', () => {
    const doc = createDocument();
    applyRdl(doc, '@IconButton icon=more');
    expect(lint(doc).some((i) => i.code === 'D10')).toBe(true);
  });
});

describe('patterns', () => {
  it('every pattern expands with defaults, applies, renders and lints clean (P0–P2)', () => {
    for (const name of Object.keys(PATTERNS)) {
      const doc = createDocument();
      let r;
      try {
        r = applyRdl(doc, `+${name}`);
      } catch (e) {
        throw new Error(`+${name}: ${e instanceof Error ? e.message : e}`);
      }
      expect(r.created.length, name).toBeGreaterThan(0);
      expect(renderFragment(doc).html, name).not.toContain('undefined');
      const issues = lint(doc).filter((i) => i.severity !== 'P3' && !i.node.startsWith('icon:'));
      expect(issues, `+${name}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });

  it('expands with params, keeps indentation, nests inside insert blocks', () => {
    const doc = createDocument();
    applyRdl(doc, 'Page col gap6 p6\n  +page-header title="Suites" primary="New suite" secondary=""\n  +table cols="Suite|Owner|Status" rows=3 pagination=false');
    const text = expandPatterns('  +section-header title="Recent"');
    expect(text.startsWith('  SectionHeader row between center wfill')).toBe(true);
    expect(doc.node('n1').children!.length).toBe(2);
    applyRdl(doc, `insert #n1 end\n  +empty-state title="No suites"`);
    expect(doc.node('n1').children!.length).toBe(3);
  });

  it('reports unknown patterns and parameters', () => {
    const doc = createDocument();
    expect(() => applyRdl(doc, '+tabel')).toThrow(/Unknown pattern "\+tabel"/);
    expect(() => applyRdl(doc, '+table colz="A"')).toThrow(/no parameter "colz"/);
  });
});
