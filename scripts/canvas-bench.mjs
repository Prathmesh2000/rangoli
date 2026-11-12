// Canvas render benchmark at 5,000 layers against ARCHITECTURE.md sections 4 and 5.
// usage: npx tsc -b && node scripts/canvas-bench.mjs [--json] [--write-doc <dir>]
// Engine-side numbers (string render, dirty sets, spatial index). DOM-side numbers come from
// scripts/canvas-check.mjs, which drives the real editor in headless Edge.
import { performance } from 'node:perf_hooks';
import { RangoliDocument, FrameRenderer, RectIndex, applyRdl, createDocument, renderCss, renderFragment } from '../packages/engine/dist/index.js';
import { copyForChange } from '../packages/editor/src/docCopy.ts'; // type-only imports: Node strips them

export const FRAMES = 10;
export const ROWS = 50; // 10 layers per row: 501 layers per frame, 5,010 on the page

/** 10 frames x 501 layers: rows of text, icons, chips, buttons, the mix a real screen has. */
export function bigDocument(frames = FRAMES, rows = ROWS) {
  const doc = createDocument('bench');
  doc.data.motion ??= {};
  doc.data.assets ??= {};
  for (let f = 0; f < frames; f++) {
    const lines = [`Screen${f} col gap2 p4 w1200 fill:canvas name:"Screen ${f}"`];
    for (let r = 0; r < rows; r++) {
      lines.push(
        `  Row${r} row gap3 p3 center fill:surface stroke:border r3`,
        `    Dot w8 h8 rfull fill:status.success.fg`,
        `    Tick icon:check w16 h16 color:status.success.fg`,
        `    Info col gap1 wfill`,
        `      Text title-sm "Run ${f}-${r}"`,
        `      Text body-sm muted "Nightly suite on main"`,
        `    @Chip variant=success "Passed"`,
        `    @Button variant=secondary size=sm "Open"`,
        `    Text label muted w96 "12m ${r}s"`,
        `    Text label muted w120 "${r} hours ago"`,
      );
    }
    applyRdl(doc, lines.join('\n'));
  }
  return doc;
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stat = (xs) => ({ p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: Math.max(...xs), n: xs.length });
const time = (fn) => { const t = performance.now(); const v = fn(); return [performance.now() - t, v]; };
const repeat = (n, fn) => Array.from({ length: n }, (_, i) => time(() => fn(i))[0]);

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function run() {
  const [buildMs, doc] = time(() => bigDocument());
  const page = doc.page();
  const layers = Object.keys(page.nodes).length;
  const opts = { editorAttrs: true, assetBase: '/assets/' };

  // warm up the JIT on both paths
  for (let i = 0; i < 3; i++) { const f = renderFragment(doc, opts); renderCss(doc, f.css, f.usedComponents); }
  const fullRender = repeat(15, () => { const f = renderFragment(doc, opts); return renderCss(doc, f.css, f.usedComponents); });

  const fr = new FrameRenderer(opts);
  const [initialSync] = time(() => fr.sync(doc, null));

  // a text edit deep in one 501-layer frame
  const texts = Object.values(page.nodes).filter((n) => n.type === 'text');
  const r = rng(1);
  const apply = [], syncEdit = [], storeClone = [], storeCow = [], editorPath = [];
  let lastDelta;
  let lastEntry;
  const off = doc.onChange((e) => { lastEntry = e; });
  for (let i = 0; i < 300; i++) {
    const n = texts[Math.floor(r() * texts.length)];
    const before = doc.data;
    const [a, res] = time(() => doc.apply([{ op: 'update', id: n.id, patch: { text: `edit ${i}` } }]));
    apply.push(a);
    const [s, d] = time(() => fr.sync(doc, res.touched));
    syncEdit.push(s);
    lastDelta = d;
    // the editor's own path per committed change: copy-on-write store copy, apply, then the frame sync
    const [c, copy] = time(() => new RangoliDocument(copyForChange(before, lastEntry.ops, lastEntry.touched)));
    storeCow.push(c);
    void copy;
  }
  off();
  // what the editor store did per committed change before (ed/store.ts applyCommitted): copy the whole document
  for (let i = 0; i < 30; i++) storeClone.push(time(() => new RangoliDocument(structuredClone(doc.data)))[0]);
  // editor path end to end, string side: store copy + apply + frame sync, on a separate renderer
  {
    let cur = new RangoliDocument(structuredClone(doc.data));
    const fr2 = new FrameRenderer(opts);
    fr2.sync(cur, null);
    const src = new RangoliDocument(structuredClone(doc.data));
    let entry;
    src.onChange((e) => { entry = JSON.parse(JSON.stringify(e)); });
    const ts = Object.values(src.page().nodes).filter((n) => n.type === 'text');
    for (let i = 0; i < 200; i++) {
      src.apply([{ op: 'update', id: ts[Math.floor(r() * ts.length)].id, patch: { text: `e2e ${i}` } }]);
      editorPath.push(time(() => {
        const next = new RangoliDocument(copyForChange(cur.data, entry.ops, entry.touched));
        next.applyCommitted(entry);
        fr2.sync(next, entry.touched);
        cur = next;
      })[0]);
    }
  }

  // a style patch that changes a frame's CSS
  const rows = Object.values(page.nodes).filter((n) => n.name?.startsWith('Row'));
  const syncStyle = [];
  for (let i = 0; i < 200; i++) {
    const n = rows[Math.floor(r() * rows.length)];
    const res = doc.apply([{ op: 'patch', id: n.id, sets: [{ path: ['style', 'radius'], value: i % 12 }] }]);
    syncStyle.push(time(() => fr.sync(doc, res.touched))[0]);
  }

  // token edit: variables swap; every frame is re-rendered to strings and diffed, none patched
  const syncToken = [];
  let tokenDelta;
  for (let i = 0; i < 20; i++) {
    const res = doc.setToken('color.primary.600', `#${(0x100000 + i * 4097).toString(16).slice(0, 6)}`);
    const [s, d] = time(() => fr.sync(doc, res.touched));
    syncToken.push(s);
    tokenDelta = d;
  }

  // component restyle: every frame re-rendered, only frames using it change
  const syncComponent = [];
  for (let i = 0; i < 10; i++) {
    const c = structuredClone(doc.data.components.Chip);
    c.styles[0].style = { ...c.styles[0].style, radius: i };
    const res = doc.apply([{ op: 'setComponent', component: c }]);
    syncComponent.push(time(() => fr.sync(doc, res.touched))[0]);
  }

  // correctness spot check at scale
  const f = renderFragment(doc, opts);
  const identical = fr.html() === f.html && fr.css() === renderCss(doc, f.css, f.usedComponents);

  // spatial index: frames, then nodes, then 50k mixed rectangles
  const rr = rng(7);
  const mk = (n) => Array.from({ length: n }, (_, i) => { const big = rr() < 0.05; return { id: `r${i}`, x: rr() * 40000, y: rr() * 40000, w: big ? 1440 : rr() * 300, h: big ? 4000 : rr() * 120 }; });
  const r500 = mk(500), r5k = mk(5000), r50k = mk(50000);
  const build500 = repeat(50, () => RectIndex.build(r500));
  const build5k = repeat(20, () => RectIndex.build(r5k));
  const build50k = repeat(10, () => RectIndex.build(r50k));
  const idx = RectIndex.build(r50k);
  const q50k = repeat(2000, () => { const x = rr() * 40000, y = rr() * 40000; return idx.search(x, y, x + 1440 * 3, y + 900 * 3); });
  const hit50k = repeat(2000, () => idx.hitTest(rr() * 40000, rr() * 40000));

  return {
    layers, frames: page.children.length, docBuildMs: buildMs,
    fullRender: stat(fullRender),
    initialSync,
    apply: stat(apply),
    nodeEditSync: stat(syncEdit), nodeEditRendered: lastDelta.rendered, nodeEditChanged: lastDelta.changed.length,
    styleEditSync: stat(syncStyle),
    storeClone: stat(storeClone), storeCow: stat(storeCow), editorPath: stat(editorPath),
    tokenSync: stat(syncToken), tokenChanged: tokenDelta.changed.length, tokenRendered: tokenDelta.rendered,
    componentSync: stat(syncComponent),
    identical,
    spatial: { build500: stat(build500), build5k: stat(build5k), build50k: stat(build50k), query50k: stat(q50k), hitTest50k: stat(hit50k) },
  };
}

const ms = (v) => `${v.toFixed(2)} ms`;
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('canvas-bench.mjs')) {
  const res = run();
  if (process.argv.includes('--json')) console.log(JSON.stringify(res, null, 2));
  else {
    const row = (name, v, budget) => console.log(`${name.padEnd(52)} ${v.padEnd(34)} ${budget}`);
    console.log(`\n${res.layers} layers in ${res.frames} frames (${(res.layers / res.frames).toFixed(0)} per frame)\n`);
    row('measure', 'p50 / p95 / max', 'budget (ARCHITECTURE.md)');
    row('full render, strings only (old path, every edit)', `${ms(res.fullRender.p50)} / ${ms(res.fullRender.p95)}`, 'replaced');
    row('first sync, all frames', ms(res.initialSync), 'once per load');
    row('engine apply, text edit', `${ms(res.apply.p50)} / ${ms(res.apply.p95)}`, 'p95 < 5 ms');
    row(`text edit -> frame re-render (${res.nodeEditRendered} of ${res.frames} frames)`, `${ms(res.nodeEditSync.p50)} / ${ms(res.nodeEditSync.p95)} / ${ms(res.nodeEditSync.max)}`, '500-node frame patch p95 < 8 ms (string part)');
    row('style edit -> frame re-render', `${ms(res.styleEditSync.p50)} / ${ms(res.styleEditSync.p95)}`, 'same');
    row('token edit -> sync (frames changed: ' + res.tokenChanged + ')', `${ms(res.tokenSync.p50)} / ${ms(res.tokenSync.p95)}`, 'marks changes < 10 ms');
    row('component restyle -> sync', `${ms(res.componentSync.p50)} / ${ms(res.componentSync.p95)}`, 'none set');
    row('store copy per change, before (structuredClone)', `${ms(res.storeClone.p50)} / ${ms(res.storeClone.p95)}`, 'counted against 8 ms');
    row('store copy per change, now (copy-on-write)', `${ms(res.storeCow.p50)} / ${ms(res.storeCow.p95)}`, '');
    row('editor path: store copy + apply + frame sync', `${ms(res.editorPath.p50)} / ${ms(res.editorPath.p95)} / ${ms(res.editorPath.max)}`, '500-node frame patch p95 < 8 ms (string part)');
    row('R-tree build, 500 rects (one frame of nodes)', `${ms(res.spatial.build500.p50)} / ${ms(res.spatial.build500.p95)}`, 'rebuild per frame < 4 ms');
    row('R-tree build, 5k rects', `${ms(res.spatial.build5k.p50)} / ${ms(res.spatial.build5k.p95)}`, '');
    row('R-tree build, 50k rects', `${ms(res.spatial.build50k.p50)} / ${ms(res.spatial.build50k.p95)}`, '');
    row('R-tree viewport query, 50k rects', `${ms(res.spatial.query50k.p50)} / ${ms(res.spatial.query50k.p95)} / ${ms(res.spatial.query50k.max)}`, 'query < 1 ms at 50k');
    row('R-tree point hit-test, 50k rects', `${ms(res.spatial.hitTest50k.p50)} / ${ms(res.spatial.hitTest50k.p95)}`, 'query < 1 ms at 50k');
    console.log(`\nincremental output identical to full render after all edits: ${res.identical}`);
  }
}
