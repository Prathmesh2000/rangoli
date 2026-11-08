import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { loadDocument, saveDocument } from './io.js';
import { formatLint, lint } from './lint.js';
import { applyRdl, serializeRdl } from './rdl.js';
import { renderDocument, renderFragment } from './render.js';

const CARD = `
Card col gap3 p4 w320 fill:surface stroke:border r3
  Header row between center
    Text title-sm "Login smoke test"
    @Chip variant=success "Passed"
  Text body-sm muted "Last run 2 hours ago · 24 steps"
  @Button variant=primary size=sm "Run again"
`;

describe('renderer', () => {
  it('emits semantic HTML with token CSS variables', () => {
    const doc = createDocument();
    applyRdl(doc, CARD);
    const { html, css } = renderFragment(doc);
    expect(html).toContain('<h4 class="r-n3">Login smoke test</h4>');
    expect(html).toContain('<button class="r-n6 rc-Button" data-variant="primary" data-size="sm" data-state="default" type="button">Run again</button>');
    expect(css).toContain('.r-n1{display:flex;flex-direction:column;gap:var(--space-3);padding:var(--space-4);width:320px');
    expect(css).toContain('box-shadow:inset 0 0 0 1px var(--color-border-default)');
    expect(css).toMatch(/\.r-n2\{display:flex;flex-direction:row;justify-content:space-between;align-items:center/);
  });

  it('fill sizing follows parent axis', () => {
    const doc = createDocument();
    applyRdl(doc, 'Row row gap2\n  A wfill h40 fill:subtle\n  B w80 h40 fill:subtle');
    const { css } = renderFragment(doc);
    expect(css).toContain('flex:1 1 0px;min-width:0;height:40px;background');
    expect(css).toContain('width:80px;flex-shrink:0;height:40px;background');
  });

  it('standalone document includes tokens, dark mode, reduced motion and component states', () => {
    const doc = createDocument();
    applyRdl(doc, CARD);
    const page = renderDocument(doc, { mode: 'dark' });
    expect(page).toContain('<html lang="en" data-mode="dark">');
    expect(page).toContain('[data-mode="dark"]');
    expect(page).toContain('prefers-reduced-motion');
    expect(page).toContain('.rc-Button:focus-visible');
    expect(page).not.toContain('undefined');
  });

  it('escapes text', () => {
    const doc = createDocument();
    applyRdl(doc, 'Text "<script>alert(1)</script>"');
    expect(renderFragment(doc).html).toContain('&lt;script&gt;');
  });
});

describe('linter', () => {
  it('clean token-based card has no P0/P1/P2 issues', () => {
    const doc = createDocument();
    applyRdl(doc, CARD);
    const issues = lint(doc).filter((i) => i.severity !== 'P3');
    expect(issues).toEqual([]);
  });

  it('flags slop and quality problems with fixes', () => {
    const doc = createDocument();
    applyRdl(doc, `
Screen col gap13px p4 fill:#ffffff
  Card col p4 fill:surface stroke:border r3
    Inner col p3 fill:subtle stroke:border r3
      Text caption color:#bbbbbb "low contrast"
  @Button variant=primary "Save"
  @Button variant=primary "Publish"
  @Button variant=ghost
`);
    const issues = lint(doc);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('D01'); // raw hex
    expect(codes).toContain('D02'); // 13px gap
    expect(codes).toContain('D03'); // contrast
    expect(codes).toContain('D04'); // nested card
    expect(codes).toContain('D09'); // two primaries
    expect(codes).toContain('D10'); // unlabeled button
    const d01 = issues.find((i) => i.code === 'D01' && i.node === 'n1');
    expect(d01?.fix).toBe('set #n1 fill:white'.replace('white', d01!.fix!.split(':')[1]!));
    const d02 = issues.find((i) => i.code === 'D02');
    expect(d02?.fix).toBe('set #n1 gap3');
    // the fixes are valid RDL and resolve the issues
    applyRdl(doc, issues.filter((i) => i.fix && ['D02', 'D09'].includes(i.code)).map((i) => i.fix!).join('\n'));
    const after = lint(doc).map((i) => i.code);
    expect(after).not.toContain('D02');
    expect(after).not.toContain('D09');
    expect(formatLint(lint(doc))).toMatch(/^\[P1\]/);
  });
});

describe('file format', () => {
  it('saves and loads a .rangoli directory losslessly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rangoli-'));
    try {
      const doc = createDocument('Test');
      applyRdl(doc, CARD);
      delete doc.data.icons!.ui!.icons.settings; // simulate a document saved before this icon existed
      await saveDocument(doc, join(dir, 'test.rangoli'));
      const loaded = await loadDocument(join(dir, 'test.rangoli'));
      expect(serializeRdl(loaded)).toBe(serializeRdl(doc));
      // older documents gain newly added starter icons and library components on load
      expect(loaded.data.icons!.ui!.icons.settings).toBeDefined();
      expect(loaded.data.components.Pagination).toBeDefined();
      // ids continue after load
      applyRdl(loaded, 'Text "new"');
      expect(loaded.page().children.at(-1)).toBe('n7');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
