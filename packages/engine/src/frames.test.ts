import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RangoliDocument, type ChangeEntry, type Op } from './document.js';
import { createDocument } from './components.js';
import { applyRdl } from './rdl.js';
import { renderCss, renderFragment } from './render.js';
import { FrameRenderer, frameRootOf } from './frames.js';
import type { ComponentDef, RNode, TokenTree } from './model.js';

/**
 * Incremental render equals full render. Hand-rolled property test (fast-check is not a dependency):
 * every seed replays the same random edit sequence, so a failure names the seed that reproduces it.
 */
const SEEDS = Array.from({ length: 40 }, (_, i) => i * 2654435761 + 11);
const STEPS = 30;

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

const EXAMPLES = ['building-blocks', 'test-runs', 'style-power', 'new-run-dialog', 'data-components'];
const example = (name: string) => readFileSync(new URL(`../../../examples/${name}.rdl`, import.meta.url), 'utf8');

/** A document with real variety: library components, a building block, gradients, fonts, icons. */
function sampleDoc(): RangoliDocument {
  const doc = createDocument('frames');
  doc.data.motion ??= {};
  doc.data.assets ??= {};
  for (const name of EXAMPLES) applyRdl(doc, example(name));
  doc.data.assets['a1'] = { id: 'a1', file: 'a1.png', mime: 'image/png', w: 64, h: 48, size: 10 } as never;
  return doc;
}

const clone = <T>(v: T): T => structuredClone(v);

function isDescendant(doc: RangoliDocument, candidate: string, of: string): boolean {
  for (let p: string | undefined = candidate; p; p = doc.node(p).parent) if (p === of) return true;
  return false;
}

function randomOps(doc: RangoliDocument, r: R): Op[] {
  const page = doc.page();
  const ids = Object.keys(page.nodes);
  const containers = ids.filter((id) => ['frame', 'group'].includes(page.nodes[id]!.type));
  const id = r.pick(ids);
  const node = page.nodes[id]!;
  const parent = r.pick(containers);
  switch (r.int(18)) {
    case 0:
      return [{ op: 'create', node: { id: '', type: 'text', name: 't', text: `hello ${r.int(100)}` } as RNode, parent, index: r.int(4) }];
    case 1:
      return [{ op: 'create', node: { id: '', type: 'frame', name: 'F', layout: { mode: 'col', gap: 8 }, style: { fill: [{ token: 'color.bg.surface' }] } } as RNode, index: r.int(page.children.length + 1) }];
    case 2:
      return node.type === 'text' ? [{ op: 'update', id, patch: { text: `edited ${r.int(1000)}` } }] : [{ op: 'update', id, patch: { name: `n${r.int(1000)}` } }];
    case 3:
      return [{ op: 'patch', id, sets: [{ path: ['style', 'fill'], value: [r.next() < 0.5 ? { token: r.pick(['color.bg.subtle', 'color.primary.600', 'color.bg.surface']) } : { hex: r.pick(['#ffffff', '#123456']) }] }] }];
    case 4:
      return [{ op: 'patch', id, sets: [{ path: ['style', 'radius'], value: r.int(20) }, { path: ['size', 'w'], value: { kind: 'fixed', v: 40 + r.int(600) } }] }];
    case 5:
      return [{ op: 'patch', id, sets: [{ path: ['style', 'font'], value: { family: r.pick(['Inter', 'IBM Plex Sans', 'Lora', 'Space Grotesk']), weight: 600 } }] }];
    case 6:
      return r.next() < 0.6 ? [{ op: 'delete', id }] : [];
    case 7: {
      const safe = parent !== id && !isDescendant(doc, parent, id);
      return safe ? [{ op: 'move', id, parent, index: r.int(3) }] : [];
    }
    case 8:
      // to top level, or reorder top level
      return [{ op: 'move', id: r.next() < 0.5 ? id : r.pick(page.children), index: r.int(page.children.length + 1) }];
    case 9: {
      const tokens = clone(doc.data.tokens) as Record<string, TokenTree>;
      const color = tokens.color as Record<string, Record<string, Record<string, unknown>>>;
      const primary = color?.primary;
      const which = r.int(4);
      if (which === 0 && primary?.['600']) primary['600'] = { ...primary['600'], $value: `#${String(r.int(899999) + 100000)}` };
      else if (which === 1) {
        // a text style's letter spacing or case reaches markup CSS, not only variables
        const ts = tokens.textStyle as Record<string, { $value?: Record<string, unknown> }>;
        const key = r.pick(['caption', 'label', 'body-sm', 'body', 'title', 'title-sm'].filter((k) => ts[k]?.$value));
        if (key) ts[key] = { ...ts[key], $value: { ...ts[key]!.$value, ...(r.next() < 0.5 ? { letterSpacing: `${r.int(5) / 100}em` } : { textCase: r.pick(['uppercase', 'none']) }) } };
      } else if (which === 2) {
        // adding a token can change which path a short name resolves to
        (color as Record<string, unknown>)[`extra${r.int(3)}`] = { $value: '#abcdef', $type: 'color' };
      } else if (color?.primary) {
        delete (color as Record<string, unknown>)[`extra${r.int(3)}`];
      }
      return [{ op: 'setTokens', tokens: tokens as TokenTree }];
    }
    case 10: {
      const comps = Object.values(doc.data.components);
      const c = clone(r.pick(comps)) as ComponentDef;
      if (c.styles[0]) c.styles[0].style = { ...c.styles[0].style, radius: r.int(16) };
      else c.styles.push({ when: {}, style: { radius: r.int(16) } });
      return [{ op: 'setComponent', component: c }];
    }
    case 11: {
      const target = r.next() < 0.5 ? `#${id}` : '@Button';
      return [{ op: 'setMotion', target, def: r.next() < 0.3 ? null : { target, specs: [{ trigger: 'hover', tracks: [{ prop: 'opacity', from: '1', to: '0.6' }] as never, duration: 'fast', easing: 'out' }] } }];
    }
    case 12:
      return [{ op: 'patch', id, sets: [{ path: ['hidden'], value: r.next() < 0.5 ? true : undefined }] }];
    case 13:
      return [{ op: 'create', node: { id: '', type: 'image', name: 'img', image: { asset: r.pick(['a1', 'a2']), fit: 'cover' } } as RNode, parent }];
    case 14:
      return [{ op: 'setAsset', id: 'a2', meta: r.next() < 0.5 ? ({ id: 'a2', file: 'a2.png', mime: 'image/png', w: 10 + r.int(90), h: 20, size: 5 } as never) : null }];
    case 15:
      return [{ op: 'create', node: { id: '', type: 'vector', name: 'ic', icon: r.pick(['ui/check', 'ui/star', 'ui/x']) } as RNode, parent }];
    case 16:
      return [{ op: 'setProtoStart', frame: r.pick(page.children) }];
    default: {
      const inst = ids.filter((x) => page.nodes[x]!.type === 'instance');
      if (!inst.length) return [];
      const i = r.pick(inst);
      return [{ op: 'patch', id: i, sets: [{ path: ['props', 'variant'], value: r.pick(['primary', 'secondary', 'success', 'pill']) }] }];
    }
  }
}

function full(doc: RangoliDocument, opts = { editorAttrs: true, assetBase: '/assets/' }) {
  const f = renderFragment(doc, opts);
  return { html: f.html, css: renderCss(doc, f.css, f.usedComponents) };
}

/** Apply edits, sometimes several before one sync (as when events arrive between two paints). */
function run(seed: number, opts: { cloneEachStep: boolean }) {
  const r = rng(seed);
  let doc = sampleDoc();
  const fr = new FrameRenderer({ editorAttrs: true, assetBase: '/assets/' });
  fr.sync(doc, null);
  let pending = new Set<string>();
  let entries: ChangeEntry[] = [];
  let off = doc.onChange((e) => entries.push(e));
  let rendered = 0;
  let total = 0;
  for (let step = 0; step < STEPS; step++) {
    const ops = randomOps(doc, r);
    if (ops.length) {
      try { doc.apply(ops, { author: 'prop' }); } catch { /* invalid random op: nothing applied */ }
    }
    if (r.next() < 0.1 && doc.historyEntries.length) doc.undo();
    for (const e of entries) for (const t of e.touched) pending.add(t);
    entries = [];
    if (r.next() < 0.3) continue; // keep batching
    if (opts.cloneEachStep) {
      // the editor builds a new document per change; nothing may hang on object identity
      off();
      doc = new RangoliDocument(clone(doc.data));
      off = doc.onChange((e) => entries.push(e));
    }
    const d = fr.sync(doc, pending);
    rendered += d.rendered;
    total += d.order.length;
    pending = new Set();
    const ref = full(doc);
    expect(fr.html(), `seed ${seed} step ${step}: html`).toBe(ref.html);
    expect(fr.css(), `seed ${seed} step ${step}: css`).toBe(ref.css);
  }
  return { rendered, total };
}

describe('FrameRenderer: incremental render equals full render', () => {
  it('starts equal to the full render', () => {
    const doc = sampleDoc();
    const fr = new FrameRenderer({ editorAttrs: true, assetBase: '/assets/' });
    const d = fr.sync(doc, null);
    expect(d.order.length).toBeGreaterThanOrEqual(EXAMPLES.length);
    expect(d.changed).toEqual(d.order);
    const ref = full(doc);
    expect(fr.html()).toBe(ref.html);
    expect(fr.css()).toBe(ref.css);
    // the parts in cascade order are the same text
    const parts = [fr.headCss(), d.order.map((id) => fr.frameCss(id)).filter(Boolean).join('\n'), fr.motionCss()].filter(Boolean).join('\n\n');
    expect(parts).toBe(ref.css);
  });

  it.each(SEEDS)('after random edit sequences (seed %i)', (seed) => {
    const { rendered, total } = run(seed, { cloneEachStep: seed % 2 === 0 });
    expect(rendered, 'the incremental path rendered fewer frames than full renders would').toBeLessThan(total);
  });

  it('re-renders only the touched frame for a node edit', () => {
    const doc = sampleDoc();
    const fr = new FrameRenderer({ editorAttrs: true });
    fr.sync(doc, null);
    const page = doc.page();
    const deep = Object.values(page.nodes).find((n) => n.type === 'text' && n.parent && page.nodes[n.parent]!.parent)!;
    const root = frameRootOf(page, deep.id)!;
    const res = doc.apply([{ op: 'update', id: deep.id, patch: { text: 'changed' } }]);
    const d = fr.sync(doc, res.touched);
    expect(d.rendered).toBe(1);
    expect(d.changed).toEqual([root]);
    expect(d.headChanged).toBe(false);
    expect(fr.html()).toBe(full(doc, { editorAttrs: true } as never).html);
  });

  it('a token change swaps shared CSS and patches no frame whose markup is unchanged', () => {
    const doc = sampleDoc();
    const fr = new FrameRenderer({ editorAttrs: true });
    fr.sync(doc, null);
    const res = doc.setToken('color.primary.600', '#ff0000');
    const d = fr.sync(doc, res.touched);
    expect(d.headChanged).toBe(true);
    expect(d.rendered).toBe(0); // a colour value is a CSS variable: no frame markup reads it
    expect(d.changed).toEqual([]);
    expect(fr.css()).toBe(full(doc, { editorAttrs: true } as never).css);
  });

  it('a motion change touches only the motion CSS', () => {
    const doc = sampleDoc();
    const fr = new FrameRenderer({ editorAttrs: true });
    fr.sync(doc, null);
    const res = doc.apply([{ op: 'setMotion', target: '@Button', def: { target: '@Button', specs: [{ trigger: 'hover', tracks: [{ prop: 'opacity', from: '1', to: '0.5' }] as never, duration: 'fast', easing: 'out' }] } }]);
    const d = fr.sync(doc, res.touched);
    expect(d.rendered).toBe(0);
    expect(d.motionChanged).toBe(true);
    expect(fr.css()).toBe(full(doc, { editorAttrs: true } as never).css);
  });

  it('moving a layer between frames re-renders both', () => {
    const doc = sampleDoc();
    const fr = new FrameRenderer({ editorAttrs: true });
    fr.sync(doc, null);
    const page = doc.page();
    const [a, b] = page.children as [string, string];
    const child = page.nodes[a]!.children![0]!;
    const res = doc.apply([{ op: 'move', id: child, parent: b, index: 0 }]);
    const d = fr.sync(doc, res.touched);
    expect(new Set(d.changed)).toEqual(new Set([a, b]));
    expect(fr.frameOf(child)).toBe(b);
    expect(fr.html()).toBe(full(doc, { editorAttrs: true } as never).html);
  });

  it('deleting and reordering top-level frames reports removal and order', () => {
    const doc = sampleDoc();
    const fr = new FrameRenderer({ editorAttrs: true });
    fr.sync(doc, null);
    const [a, b] = doc.page().children as [string, string];
    let d = fr.sync(doc, doc.apply([{ op: 'delete', id: a }]).touched);
    expect(d.removed).toEqual([a]);
    expect(d.orderChanged).toBe(true);
    d = fr.sync(doc, doc.apply([{ op: 'move', id: b, index: 99 }]).touched);
    expect(d.orderChanged).toBe(true);
    expect(d.changed).toEqual([]);
    expect(fr.html()).toBe(full(doc, { editorAttrs: true } as never).html);
  });
});
