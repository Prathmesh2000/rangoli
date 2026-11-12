import { describe, expect, it } from 'vitest';
import { RangoliDocument, type ChangeEntry, type Op } from './document.js';
import { createDocument } from './components.js';
import type { DocumentData, TokenTree } from './model.js';

/**
 * Hand-rolled property tests: fast-check is not a dependency and new ones are out of scope for this package.
 * Every run replays the same seeds, so a failure names the seed that reproduces it.
 */
const SEEDS = Array.from({ length: 60 }, (_, i) => i * 2654435761 + 7);
const STEPS = 40;

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)]! };
}
type R = ReturnType<typeof rng>;

const clone = <T>(v: T): T => structuredClone(v);
/** What actually reaches storage: every op passes through JSON. */
const stored = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function randomOp(doc: RangoliDocument, r: R): Op | Op[] | null {
  const ids = Object.keys(doc.page().nodes);
  const frames = ids.filter((id) => doc.node(id).type === 'frame');
  const parent = frames.length && r.next() < 0.6 ? r.pick(frames) : undefined;
  const id = ids.length ? r.pick(ids) : undefined;
  switch (r.int(11)) {
    case 0:
      return { op: 'create', node: { id: '', type: 'frame', name: `f${r.int(1e6)}` }, parent };
    case 1:
      return { op: 'create', node: { id: '', type: 'text', name: 't', text: `txt${r.int(100)}` }, parent, index: r.int(3) };
    case 2:
      return id ? { op: 'update', id, patch: { role: r.pick(['card', undefined]), name: `n${r.int(1000)}` } } : null;
    case 3:
      return id ? { op: 'update', id, patch: { style: { opacity: r.next(), fill: [{ hex: r.pick(['#ffffff', '#123456']) }], ...(r.next() < 0.5 ? { radius: r.int(20) } : {}) } } } : null;
    case 4:
      return id ? { op: 'patch', id, sets: [{ path: ['style', 'z'], value: r.int(9) }, { path: ['size', 'w'], value: { kind: 'fixed', v: r.int(900) } }] } : null;
    case 5:
      return id ? { op: 'patch', id, sets: [{ path: ['style', 'z'] }] } : null;
    case 6:
      return id && r.next() < 0.7 ? { op: 'delete', id } : null;
    case 7: {
      if (!id) return null;
      const safe = parent && !doc.childrenOf(id).includes(parent) && parent !== id && !isDescendant(doc, parent, id);
      return safe ? { op: 'move', id, parent, index: r.int(3) } : null;
    }
    case 8: {
      const tokens = clone(doc.data.tokens) as Record<string, TokenTree>;
      const color = (tokens.color ??= {}) as Record<string, unknown>;
      color[`c${r.int(4)}`] = { $value: `#${String(r.int(899999) + 100000)}`, $type: 'color' };
      if (r.next() < 0.3) delete color[`c${r.int(4)}`];
      return { op: 'setTokens', tokens: tokens as TokenTree };
    }
    case 9:
      return [{ op: 'setMotion', target: `#x${r.int(3)}`, def: null }, { op: 'setAsset', id: `a${r.int(3)}`, meta: null }];
    default:
      return id && parent ? [{ op: 'update', id, patch: { hidden: true } }, { op: 'patch', id, sets: [{ path: ['props', 'k'], value: r.int(3) }] }] : null;
  }
}

function isDescendant(doc: RangoliDocument, candidate: string, of: string): boolean {
  for (let p: string | undefined = candidate; p; p = doc.node(p).parent) if (p === of) return true;
  return false;
}

function run(seed: number): { initial: DocumentData; doc: RangoliDocument; entries: ChangeEntry[]; snapshots: DocumentData[] } {
  const doc = createDocument('prop');
  // the containers an op can create; they are always present on a document that has been saved and reloaded
  doc.data.motion ??= {};
  doc.data.assets ??= {};
  const initial = clone(doc.data);
  const r = rng(seed);
  const entries: ChangeEntry[] = [];
  doc.onChange((e) => entries.push(e));
  const snapshots: DocumentData[] = [];
  for (let i = 0; i < STEPS; i++) {
    const made = randomOp(doc, r);
    const ops = made === null ? [] : Array.isArray(made) ? made : [made];
    if (!ops.length) continue;
    doc.apply(ops, { author: 'prop' });
    snapshots.push(clone(doc.data));
  }
  return { initial, doc, entries, snapshots };
}

describe('operation properties', () => {
  it.each(SEEDS)('apply then inverse is identity, through storage, for every step (seed %i)', (seed) => {
    const { initial, entries, snapshots } = run(seed);
    let before = initial;
    for (const [i, e] of entries.entries()) {
      const after = snapshots[i]!;
      const probe = new RangoliDocument(clone(after));
      probe.replay(stored(e.inverse));
      expect(probe.data, `step ${i}`).toEqual(before);
      before = after;
    }
  });

  it.each(SEEDS)('replay of stored ops equals live state (seed %i)', (seed) => {
    const { initial, doc, entries } = run(seed);
    const replica = new RangoliDocument(clone(initial));
    for (const e of entries) replica.replay(stored(e.ops));
    expect(replica.data).toEqual(doc.data);
    expect(JSON.stringify(replica.data)).toBe(JSON.stringify(doc.data));
  });

  it.each(SEEDS)('checkpoint plus tail equals full replay at every cut (seed %i)', (seed) => {
    const { doc, entries, snapshots } = run(seed);
    const cut = (seed >>> 0) % Math.max(1, entries.length);
    const cp = snapshots[cut]!;
    const replica = new RangoliDocument(clone(cp));
    for (const e of entries.slice(cut + 1)) replica.replay(stored(e.ops));
    expect(replica.data).toEqual(doc.data);
  });

  it.each(SEEDS.slice(0, 20))('undoing and redoing a whole history returns exactly (seed %i)', (seed) => {
    const { initial, doc, entries } = run(seed);
    const final = clone(doc.data);
    const count = doc.historyEntries.length;
    for (let i = 0; i < count; i++) expect(doc.undo()).toBeDefined();
    expect(doc.data).toEqual(initial);
    for (let i = 0; i < count; i++) expect(doc.redo()).toBeDefined();
    expect(doc.data).toEqual(final);
    expect(doc.historyEntries).toHaveLength(count);
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe('path patches', () => {
  const frame = () => {
    const doc = RangoliDocument.empty();
    doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'A', style: { opacity: 1, radius: 4 } } }]);
    return doc;
  };

  it('stores only the property that changed, as a path', () => {
    const doc = frame();
    let entry: ChangeEntry | undefined;
    doc.onChange((e) => (entry = e));
    doc.apply([{ op: 'update', id: 'n1', patch: { style: { opacity: 0.5, radius: 4 } } }]);
    expect(entry!.ops).toEqual([{ op: 'patch', page: 'p1', id: 'n1', sets: [{ path: ['style', 'opacity'], value: 0.5 }] }]);
    expect(entry!.inverse).toEqual([{ op: 'patch', page: 'p1', id: 'n1', sets: [{ path: ['style', 'opacity'], value: 1 }] }]);
  });

  it('a removed style key undoes back to its place in the node', () => {
    const doc = frame();
    doc.apply([{ op: 'update', id: 'n1', patch: { style: { opacity: 1 } } }]);
    expect(doc.node('n1').style?.radius).toBeUndefined();
    doc.undo();
    expect(doc.node('n1').style).toEqual({ opacity: 1, radius: 4 });
  });

  it('a token edit stores one path, not the tree', () => {
    const doc = createDocument('x');
    let entry: ChangeEntry | undefined;
    doc.onChange((e) => (entry = e));
    doc.setToken('color.neutral.50', '#fafafa');
    expect(entry!.ops[0]!.op).toBe('patchTokens');
    expect(JSON.stringify(entry!.ops).length).toBeLessThan(1024);
  });

  it('a token removal keeps sibling order on undo', () => {
    const doc = createDocument('x');
    const before = JSON.stringify(doc.data.tokens);
    const t = clone(doc.data.tokens) as Record<string, Record<string, unknown>>;
    delete t.color!.neutral;
    doc.apply([{ op: 'setTokens', tokens: t as unknown as TokenTree }]);
    doc.undo();
    expect(JSON.stringify(doc.data.tokens)).toBe(before);
  });

  it('refuses reserved keys and unsafe values on the incoming path', () => {
    const doc = frame();
    for (const path of [['__proto__', 'x'], ['style', 'constructor', 'prototype', 'x'], ['id'], ['children'], ['parent']]) {
      expect(() => doc.apply([{ op: 'patch', id: 'n1', sets: [{ path, value: 1 }] }]), path.join('.')).toThrow();
    }
    expect(() => doc.apply([{ op: 'patch', id: 'n1', sets: [{ path: ['style', 'fill'], value: [{ hex: 'javascript:1' }] }] }])).toThrow(/Invalid colour/);
    expect(() => doc.apply([{ op: 'patchTokens', sets: [{ path: ['__proto__', 'polluted'], value: 1 }] }])).toThrow(/reserved/);
    expect(() => doc.apply([{ op: 'patchTokens', sets: [{ path: ['color', '__proto__', 'x'], value: { $value: '#000' } }] }])).toThrow(/reserved/);
    expect(({} as { x?: unknown }).x).toBeUndefined();
  });

  it('replaying a tampered stored op cannot reach the prototype', () => {
    const doc = frame();
    expect(() => doc.replay([{ op: 'patch', id: 'n1', sets: [{ path: ['__proto__', 'polluted'], value: 'y' }] }])).toThrow(/reserved/);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('a patch survives JSON, including a deletion', () => {
    const doc = frame();
    doc.apply([{ op: 'update', id: 'n1', patch: { role: 'card' } }]);
    const [entry] = doc.historyEntries.slice(-1);
    const replica = new RangoliDocument(clone(doc.data));
    replica.replay(stored(entry!.inverse));
    expect(replica.node('n1').role).toBeUndefined();
  });
});

describe('undo stays with its author', () => {
  const twoEditors = () => {
    const doc = RangoliDocument.empty();
    let who = 'alice';
    doc.attribution = () => ({ actorId: who });
    const as = (name: string) => (who = name);
    doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'root', style: { opacity: 1 } } }]);
    return { doc, as };
  };

  it('does not undo another author', () => {
    const { doc, as } = twoEditors();
    as('bob');
    doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'bobs' } }]);
    as('alice');
    expect(doc.undo()?.author).toBe('human');
    expect(doc.findNode('n2')).toBeDefined();
    expect(doc.findNode('n1')).toBeUndefined();
  });

  it('keeps a later edit by someone else on the same property, undoing the rest', () => {
    const { doc, as } = twoEditors();
    doc.apply([{ op: 'update', id: 'n1', patch: { style: { opacity: 0.2, radius: 3 } } }]);
    as('bob');
    doc.apply([{ op: 'patch', id: 'n1', sets: [{ path: ['style', 'opacity'], value: 0.9 }] }]);
    as('alice');
    const undone = doc.undo();
    expect(undone?.stayed).toBe(1);
    expect(doc.node('n1').style).toEqual({ opacity: 0.9 });
    // bob still undoes only his own
    as('bob');
    doc.undo();
    expect(doc.node('n1').style?.opacity).toBe(0.2);
  });

  it('leaves a node someone else has built on', () => {
    const { doc, as } = twoEditors();
    doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'mine' } }]);
    as('bob');
    doc.apply([{ op: 'patch', id: 'n2', sets: [{ path: ['name'], value: 'bobs now' }] }]);
    as('alice');
    expect(doc.undo()?.stayed).toBe(1);
    expect(doc.node('n2').name).toBe('bobs now');
  });

  it('redo restores what undo took, per author', () => {
    const { doc, as } = twoEditors();
    doc.apply([{ op: 'update', id: 'n1', patch: { name: 'alices' } }]);
    doc.undo();
    as('bob');
    doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'other' } }]);
    as('alice');
    expect(doc.redo()).toBeDefined();
    expect(doc.node('n1').name).toBe('alices');
  });

  it('local mode stays one stack over every author', () => {
    const doc = RangoliDocument.empty();
    doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'a' } }], { author: 'human' });
    doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'b' } }], { author: 'agent' });
    expect(doc.undo()?.author).toBe('agent');
    expect(doc.findNode('n1')).toBeDefined();
    expect(doc.findNode('n2')).toBeUndefined();
  });

  it('numbering never repeats, even after an undo', () => {
    const doc = RangoliDocument.empty();
    const seen: number[] = [];
    doc.onChange((e) => seen.push(e.seq));
    doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'a' } }]);
    doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'b' } }]);
    doc.undo();
    doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'c' } }]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('restores undo state from stored history', () => {
    const { doc, as } = twoEditors();
    doc.apply([{ op: 'update', id: 'n1', patch: { name: 'two' } }]);
    const fresh = new RangoliDocument(clone(doc.data));
    fresh.attribution = doc.attribution;
    fresh.restoreHistory(stored([...doc.historyEntries]), doc.headSeq);
    expect(fresh.headSeq).toBe(doc.headSeq);
    as('alice');
    fresh.undo();
    expect(fresh.node('n1').name).toBe('root');
  });
});
