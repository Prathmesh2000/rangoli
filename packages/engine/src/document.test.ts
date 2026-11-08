import { describe, expect, it } from 'vitest';
import { RangoliDocument, RangoliError } from './document.js';

const frame = (name: string) => ({ id: '', type: 'frame' as const, name });

describe('RangoliDocument ops', () => {
  it('creates nodes with stable generated ids and parents', () => {
    const doc = RangoliDocument.empty();
    const r1 = doc.apply([{ op: 'create', node: frame('Card') }]);
    const card = r1.created[0]!;
    const r2 = doc.apply([{ op: 'create', node: frame('Header'), parent: card }]);
    expect(card).toBe('n1');
    expect(r2.created[0]).toBe('n2');
    expect(doc.node('n2').parent).toBe('n1');
    expect(doc.node('n1').children).toEqual(['n2']);
  });

  it('is atomic: failing batch rolls back', () => {
    const doc = RangoliDocument.empty();
    doc.apply([{ op: 'create', node: frame('A') }]);
    expect(() =>
      doc.apply([
        { op: 'update', id: 'n1', patch: { name: 'Changed' } },
        { op: 'delete', id: 'missing' },
      ]),
    ).toThrow(RangoliError);
    expect(doc.node('n1').name).toBe('A');
  });

  it('undo/redo of create, update, move, delete keeps ids', () => {
    const doc = RangoliDocument.empty();
    doc.apply([{ op: 'create', node: frame('A') }, { op: 'create', node: frame('B') }]);
    doc.apply([{ op: 'create', node: frame('C'), parent: 'n1' }]);
    doc.apply([{ op: 'move', id: 'n3', parent: 'n2' }]);
    expect(doc.node('n2').children).toEqual(['n3']);
    doc.undo();
    expect(doc.node('n1').children).toEqual(['n3']);
    doc.redo();
    expect(doc.node('n2').children).toEqual(['n3']);

    doc.apply([{ op: 'delete', id: 'n2' }]);
    expect(doc.findNode('n3')).toBeUndefined();
    doc.undo();
    expect(doc.node('n3').parent).toBe('n2');
    expect(doc.page().children).toEqual(['n1', 'n2']);

    doc.apply([{ op: 'update', id: 'n1', patch: { name: 'Renamed', role: 'card' } }]);
    doc.undo();
    expect(doc.node('n1').name).toBe('A');
    expect(doc.node('n1').role).toBeUndefined();
  });

  it('prevents cycles on move', () => {
    const doc = RangoliDocument.empty();
    doc.apply([{ op: 'create', node: frame('A') }]);
    doc.apply([{ op: 'create', node: frame('B'), parent: 'n1' }]);
    expect(() => doc.apply([{ op: 'move', id: 'n1', parent: 'n2' }])).toThrow(/descendant/);
  });

  it('records author in history', () => {
    const doc = RangoliDocument.empty();
    doc.apply([{ op: 'create', node: frame('A') }], { author: 'agent:claude', label: 'add card' });
    expect(doc.historyEntries[0]?.author).toBe('agent:claude');
  });
});
