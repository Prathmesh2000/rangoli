import { describe, expect, it } from 'vitest';
import { RangoliDocument, applyRdl, createDocument, type ChangeEntry, type Op, type RNode } from '@rangoli/engine';
import { copyForChange } from './docCopy';

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: T[]): T => xs[Math.floor(next() * xs.length)]! };
}

function isDescendant(doc: RangoliDocument, candidate: string, of: string): boolean {
  for (let p: string | undefined = candidate; p; p = doc.node(p).parent) if (p === of) return true;
  return false;
}

function randomOps(doc: RangoliDocument, r: ReturnType<typeof rng>): Op[] {
  const page = doc.page();
  const ids = Object.keys(page.nodes);
  const frames = ids.filter((id) => page.nodes[id]!.type === 'frame');
  const id = r.pick(ids);
  const parent = r.pick(frames);
  switch (r.int(14)) {
    case 0: return [{ op: 'create', node: { id: '', type: 'text', name: 't', text: 'x' } as RNode, parent, index: r.int(3) }];
    case 1: return [{ op: 'create', node: { id: '', type: 'frame', name: 'F' } as RNode, index: r.int(3) }];
    case 2: return [{ op: 'update', id, patch: { name: `n${r.int(99)}`, style: { opacity: r.next() } } }];
    case 3: return [{ op: 'patch', id, sets: [{ path: ['style', 'radius'], value: r.int(9) }, { path: ['layout', 'gap'], value: r.int(9) }] }];
    case 4: return [{ op: 'delete', id }];
    case 5: return parent !== id && !isDescendant(doc, parent, id) ? [{ op: 'move', id, parent, index: r.int(3) }] : [];
    case 6: return [{ op: 'move', id, index: r.int(4) }];
    case 7: return [{ op: 'patchTokens', sets: [{ path: ['color', 'primary', '600', '$value'], value: `#${String(100000 + r.int(800000))}` }] }];
    case 8: { const c = structuredClone(doc.data.components.Button!); c.styles.push({ when: {}, style: { radius: r.int(9) } }); return [{ op: 'setComponent', component: c }]; }
    case 9: return [{ op: 'setMotion', target: `#${id}`, def: r.next() < 0.5 ? null : { target: `#${id}`, specs: [] } }];
    case 10: return [{ op: 'setInteractions', node: id, list: r.next() < 0.5 ? null : [{ trigger: 'click', action: 'navigate', target: parent } as never] }, { op: 'setProtoStart', frame: parent }];
    case 11: return [{ op: 'setIcon', set: 'ui', name: `i${r.int(3)}`, icon: r.next() < 0.5 ? null : ({ src: 'circle 12 12 10' } as never) }];
    case 12: return [{ op: 'setAsset', id: `a${r.int(3)}`, meta: r.next() < 0.5 ? null : ({ id: 'a', file: 'a.png', mime: 'image/png', w: 1, h: 1, size: 1 } as never) }];
    default: return [{ op: 'setTimeline', name: `t${r.int(2)}`, def: r.next() < 0.5 ? null : ({ name: 't', tracks: [] } as never) }];
  }
}

describe('copyForChange: copy-on-write equals a full copy and never writes the previous version', () => {
  it.each(Array.from({ length: 25 }, (_, i) => i * 7919 + 3))('random committed changes (seed %i)', (seed) => {
    const r = rng(seed);
    const source = createDocument('cow');
    source.data.motion ??= {};
    source.data.assets ??= {};
    source.data.timelines ??= {};
    source.data.prototype ??= { interactions: {} };
    applyRdl(source, 'A col gap2 p4\n  B row gap2\n    Text "one"\n    Text "two"\n  C col\n    Text "three"\nD row gap1\n  Text "four"');
    const entries: ChangeEntry[] = [];
    source.onChange((e) => entries.push(JSON.parse(JSON.stringify(e)) as ChangeEntry)); // as it reaches the editor: JSON over SSE
    let mirror = new RangoliDocument(structuredClone(source.data));
    for (let step = 0; step < 40; step++) {
      const ops = randomOps(source, r);
      try { if (ops.length) source.apply(ops); } catch { /* invalid random op */ }
      if (r.next() < 0.15) source.undo();
      for (const e of entries.splice(0)) {
        const before = mirror.data;
        const frozen = JSON.stringify(before);
        const next = new RangoliDocument(copyForChange(before, e.ops, e.touched));
        next.applyCommitted(structuredClone(e));
        expect(JSON.stringify(before), `seed ${seed} step ${step}: previous version unchanged`).toBe(frozen);
        mirror = next;
      }
      expect(mirror.data, `seed ${seed} step ${step}: same result as the source`).toEqual(source.data);
    }
  });
});
