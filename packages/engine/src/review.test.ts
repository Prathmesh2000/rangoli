import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { applyRdl } from './rdl.js';
import { cloneDocument, diffDocuments, formatDiff, isEmptyDiff, mentions, previewScript } from './review.js';

const CARD = `Card col gap3 p4 fill:surface stroke:border r3
  Text title-sm "Login smoke test"
  @Chip variant=success "Passed"`;

describe('preview (suggestions never touch the original)', () => {
  it('applies a script to a copy', () => {
    const doc = createDocument();
    applyRdl(doc, CARD);
    const before = JSON.stringify(doc.data);
    const p = previewScript(doc, 'set #n3 variant=error "Failed"\ninsert #n1 end\n  Text caption muted "2 of 10 flaky"');
    expect(p.error).toBeUndefined();
    expect(p.created).toEqual(['n4']);
    expect(p.doc.node('n3').variant).toEqual({ variant: 'error' });
    expect(JSON.stringify(doc.data)).toBe(before);
    expect(doc.findNode('n4')).toBeUndefined();
  });

  it('reports script errors without throwing', () => {
    const doc = createDocument();
    applyRdl(doc, CARD);
    const p = previewScript(doc, 'set #zz gap3');
    expect(p.error).toContain('#zz not found');
  });
});

describe('diff', () => {
  it('lists added, removed and changed nodes with RDL lines', () => {
    const doc = createDocument();
    applyRdl(doc, CARD);
    const before = cloneDocument(doc).data;
    applyRdl(doc, 'set #n3 variant=error "Failed"\ndelete #n2\ninsert #n1 end\n  Text caption muted "Flaky"\nmotion #n1\n  enter opacity:0 base out');
    const d = diffDocuments(before, doc.data);
    expect(d.added).toEqual(['n4']);
    expect(d.removed).toEqual(['n2']);
    expect(d.changed.map((c) => c.id).sort()).toEqual(['n1', 'n3']);
    expect(d.motion).toEqual(['#n1']);
    const text = formatDiff(before, doc.data, d);
    expect(text).toContain('+ Text#n4 caption muted "Flaky"   (in #n1)');
    expect(text).toContain('- Text#n2 title-sm "Login smoke test"');
    expect(text).toContain('~ #n3 [variant, props]\n    was: @Chip#n3 variant=success "Passed"\n    now: @Chip#n3 variant=error "Failed"');
    expect(text).toContain('~ motion #n1');
  });

  it('empty diff', () => {
    const doc = createDocument();
    applyRdl(doc, CARD);
    const d = diffDocuments(cloneDocument(doc).data, doc.data);
    expect(isEmptyDiff(d)).toBe(true);
    expect(formatDiff(doc.data, doc.data, d)).toBe('No differences.');
  });
});

it('parses mentions', () => {
  expect(mentions('@agent can you fix the spacing? cc @Darshana')).toEqual(['agent', 'darshana']);
  expect(mentions('email me at a@b.com')).toEqual([]);
});
