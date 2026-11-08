import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { applyRdl, compileRdl, serializeRdl, tokenizeLine } from './rdl.js';

const CARD = `
Card col gap3 p4 w320 fill:surface stroke:border r3
  Header row between center
    Text title-sm "Login smoke test"
    @Chip variant=success "Passed"
  Text body-sm muted "Last run 2 hours ago · 24 steps"
  @Button variant=primary size=sm "Run again"
`;

describe('tokenizer', () => {
  it('keeps quoted strings and key="quoted value" together, strips comments', () => {
    expect(tokenizeLine('Text body "hello world" title="A b" # note')).toEqual(['Text', 'body', '"hello world"', 'title="A b"']);
  });
});

describe('RDL create + serialize', () => {
  it('builds a tree with token refs, components and text', () => {
    const doc = createDocument();
    const res = applyRdl(doc, CARD, { author: 'agent:test' });
    expect(res.created).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
    const card = doc.node('n1');
    expect(card.layout).toMatchObject({ mode: 'col', gap: { token: 'space.3' } });
    expect(card.layout?.padding).toEqual([{ token: 'space.4' }, { token: 'space.4' }, { token: 'space.4' }, { token: 'space.4' }]);
    expect(card.style?.fill).toEqual([{ token: 'color.bg.surface' }]);
    expect(doc.node('n3')).toMatchObject({ type: 'text', text: 'Login smoke test' });
    expect(doc.node('n4')).toMatchObject({ type: 'instance', component: 'Chip', variant: { variant: 'success' }, props: { label: 'Passed' } });
    expect(doc.node('n2').layout).toMatchObject({ mode: 'row', justify: 'between', align: 'center' });
  });

  it('round-trips: serialize → parse → serialize is stable', () => {
    const doc = createDocument();
    applyRdl(doc, CARD);
    const out1 = serializeRdl(doc);
    const doc2 = createDocument();
    applyRdl(doc2, out1);
    const out2 = serializeRdl(doc2);
    expect(out2).toBe(out1);
    expect(out1).toContain('Card#n1 gap3 p4 w320 fill:surface stroke:border r3');
    expect(out1).toContain('@Chip#n4 variant=success "Passed"');
    expect(out1).toContain('Text#n5 body-sm muted "Last run 2 hours ago · 24 steps"');
  });

  it('outline detail is tiny', () => {
    const doc = createDocument();
    applyRdl(doc, CARD);
    const outline = serializeRdl(doc, { detail: 'outline' });
    expect(outline.split('\n')[0]).toBe('Card#n1 frame');
    expect(outline.length).toBeLessThan(serializeRdl(doc).length);
  });

  it('reports helpful errors and applies nothing', () => {
    const doc = createDocument();
    expect(() => applyRdl(doc, 'Card gap7 fill:purple-gradient\n  @Buton "x"')).toThrow(/Unknown space step "7"[\s\S]*Unknown color "purple-gradient"[\s\S]*Unknown component "@Buton"/);
    expect(doc.page().children).toEqual([]);
  });

  it('validates variant values against component axes', () => {
    const doc = createDocument();
    expect(() => applyRdl(doc, '@Button variant=fancy "x"')).toThrow(/variant must be one of: primary, secondary, ghost, danger/);
  });

  it('rejects text on a container instead of silently ignoring it', () => {
    const doc = createDocument();
    applyRdl(doc, CARD);
    expect(() => applyRdl(doc, 'set #n2 "oops"')).toThrow(/container with children/);
  });

  it('allows raw px with explicit unit (for linter to flag later)', () => {
    const doc = createDocument();
    applyRdl(doc, 'Box p13px gap5px');
    expect(doc.node('n1').layout?.gap).toBe(5);
  });
});

describe('RDL edit commands', () => {
  it('set / insert / move / delete / replace', () => {
    const doc = createDocument();
    applyRdl(doc, CARD);
    applyRdl(doc, 'set #n4 variant=error "Failed"');
    expect(doc.node('n4')).toMatchObject({ variant: { variant: 'error' }, props: { label: 'Failed' } });

    applyRdl(doc, 'insert #n1 end\n  Text caption muted "Flaky in 2 of last 10 runs"');
    expect(doc.node('n1').children?.at(-1)).toBe('n7');

    applyRdl(doc, 'insert #n5 after\n  Text caption "after five"');
    const kids = doc.node('n1').children!;
    expect(kids[kids.indexOf('n5') + 1]).toBe('n8');

    applyRdl(doc, 'move #n6 before #n2');
    expect(doc.node('n1').children![0]).toBe('n6');

    applyRdl(doc, 'move #n6 into #n2 start');
    expect(doc.node('n2').children![0]).toBe('n6');

    applyRdl(doc, 'replace #n3\n  Text title "New title"');
    expect(doc.node('n3')).toMatchObject({ text: 'New title', style: { textStyle: { token: 'textStyle.title' } } });

    applyRdl(doc, 'delete #n7');
    expect(doc.findNode('n7')).toBeUndefined();

    // whole batch is one undoable change each
    doc.undo();
    expect(doc.findNode('n7')).toBeDefined();
  });

  it('replace can reuse the ids of the whole subtree (editor RDL tab round-trip)', () => {
    const doc = createDocument();
    applyRdl(doc, CARD);
    const sub = serializeRdl(doc, { roots: ['n2'] });
    const edited = sub.replace('"Login smoke test"', '"Checkout flow"');
    applyRdl(doc, `replace #n2\n${edited.split('\n').map((l) => '  ' + l).join('\n')}`);
    expect(doc.node('n3').text).toBe('Checkout flow');
    expect(doc.node('n2').children).toEqual(['n3', 'n4']);
    expect(doc.node('n1').children![0]).toBe('n2');
  });

  it('renames with name:', () => {
    const doc = createDocument();
    applyRdl(doc, CARD);
    applyRdl(doc, 'set #n2 name:"Card header"');
    expect(doc.node('n2').name).toBe('Card header');
    applyRdl(doc, 'set #n3 name:"Title text"');
    // names with spaces survive a serialize → parse round trip
    const out = serializeRdl(doc);
    expect(out).toContain('Frame#n2 name:"Card header" row between center');
    expect(out).toContain('Text#n3 name:"Title text" title-sm "Login smoke test"');
    const doc2 = createDocument();
    applyRdl(doc2, out);
    expect(doc2.node('n2').name).toBe('Card header');
    expect(doc2.node('n3')).toMatchObject({ name: 'Title text', type: 'text' });
    expect(serializeRdl(doc2)).toBe(out);
  });

  it('set only patches changed fields', () => {
    const doc = createDocument();
    applyRdl(doc, CARD);
    const { ops } = compileRdl(doc, 'set #n1 gap4');
    expect(ops).toHaveLength(1);
    expect(Object.keys((ops[0] as { patch: object }).patch)).toEqual(['layout']);
  });

  it('mixed commands and creates in one script', () => {
    const doc = createDocument();
    applyRdl(doc, 'Page col gap6 p6\n  Text headline "Runs"\nset #n1 fill:canvas');
    expect(doc.node('n1').style?.fill).toEqual([{ token: 'color.bg.canvas' }]);
  });
});
